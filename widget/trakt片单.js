/* ============================================================
 * Trakt 继续观看 · CapyPlayer Widget
 * 功能：同步 Trakt 观看记录，推断下一集，生成继续观看列表
 * 依赖：Trakt API v2（公开 Client ID 仅限公开数据读取）
 * ============================================================ */

var WidgetMetadata = {
  id: "trakt_continue_watching",
  title: "Trakt 继续观看",
  description: "从 Trakt 同步观看进度，自动推断下一集，生成继续观看列表。",
  version: "1.0.0",
  author: "",
  site: "",
  iconUrl: "",
  globalParams: [
    {
      name: "traktUser",
      title: "Trakt 用户名",
      type: "string",
      defaultValue: ""
    },
    {
      name: "traktClientId",
      title: "Trakt Client ID",
      type: "string",
      defaultValue: ""
    }
  ],
  modules: [
    {
      id: "continue_watching",
      title: "继续观看",
      type: "media_list",
      functionName: "loadContinueWatching",
      cacheDuration: 300,
      timeoutSeconds: 30,
      retryCount: 1,
      params: [
        { name: "page", title: "页码", type: "page" },
        {
          name: "pageSize",
          title: "每页数量",
          type: "enumeration",
          defaultValue: "15",
          enumOptions: [
            { title: "10", value: "10" },
            { title: "15", value: "15" },
            { title: "20", value: "20" },
            { title: "30", value: "30" }
          ]
        },
        {
          name: "recentDays",
          title: "时间范围",
          type: "enumeration",
          defaultValue: "60",
          enumOptions: [
            { title: "最近 60 天", value: "60" },
            { title: "最近 180 天", value: "180" },
            { title: "最近 365 天", value: "365" },
            { title: "不限时间", value: "0" }
          ]
        }
      ]
    }
  ]
};

/* ==================== 常量 ==================== */

var TRAKT_BASE = "https://api.trakt.tv";
var TMDB_POSTER = "https://image.tmdb.org/t/p/w500";
var TMDB_BACKDROP = "https://image.tmdb.org/t/p/w780";
var TRAKT_PAGE_LIMIT = 100;
var TRAKT_MAX_PAGES = 20;
var MAX_CACHE_SIZE = 300;
var REQUEST_TIMEOUT_MS = 15000;
var DEFAULT_HIDE_DAYS = 60;

/* ==================== 工具函数 ==================== */

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNumber(value) {
  var n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pad2(value) {
  return String(toNumber(value)).padStart(2, "0");
}

function formatSE(season, episode) {
  return "S" + pad2(season) + "E" + pad2(episode);
}

function safeTime(value) {
  var time = new Date(value || 0).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function normalizeRating(value) {
  var n = toNumber(value);
  return n > 0 ? Math.round(n * 10) / 10 : 0;
}

function textItem(id, title, description) {
  var item = { id: id, type: "text", title: title };
  if (description) item.description = description;
  return [item];
}

function dedupeById(arr, keyFn) {
  var seen = {};
  return toArray(arr).filter(function (item) {
    var key = keyFn(item);
    if (!key || seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

/* ==================== 缓存（LRU 上限） ==================== */

var traktHistoryCache = new Map();
var tmdbShowCache = new Map();

async function cachedLoad(cache, key, loader) {
  if (cache.has(key)) return await cache.get(key);
  if (cache.size >= MAX_CACHE_SIZE) {
    var oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  var promise = Promise.resolve().then(loader);
  cache.set(key, promise);
  try {
    var value = await promise;
    cache.set(key, value);
    return value;
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}

/* ==================== 日期工具 ==================== */

function getDisplayDate(value) {
  if (!value) return "";
  if (typeof value === "string") {
    var matched = value.trim().match(/^(\d{4}-\d{2}-\d{2})$/);
    if (matched) return matched[1];
  }
  var date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  var shifted = new Date(date.getTime() + 8 * 3600000);
  return [
    shifted.getUTCFullYear(),
    pad2(shifted.getUTCMonth() + 1),
    pad2(shifted.getUTCDate())
  ].join("-");
}

function today() {
  return getDisplayDate(new Date());
}

function hasAired(value) {
  if (!value) return false;
  var day = getDisplayDate(String(value).slice(0, 10));
  return !!day && day <= today();
}

function isRecent(item, days) {
  var t = safeTime(item && item.last_watched_at);
  if (t <= 0) return false;
  if (!days || days <= 0) return true;
  var diff = Date.now() - t;
  return diff >= 0 && diff <= days * 86400000;
}

/* ==================== 参数读取 ==================== */

function getUser(params) {
  return String((params && params.traktUser) || "").trim();
}

function getClientId(params) {
  return String((params && params.traktClientId) || "").trim();
}

function getPaging(params) {
  return {
    page: Math.max(1, parseInt((params && params.page) || 1, 10) || 1),
    pageSize: Math.max(1, parseInt((params && params.pageSize) || 15, 10) || 15)
  };
}

function getRecentDays(params) {
  var raw = params && params.recentDays;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_HIDE_DAYS;
  var n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_HIDE_DAYS;
}

/* ==================== Trakt 客户端 ==================== */

function getTraktShowId(show) {
  return (show && show.ids && (show.ids.trakt || show.ids.slug)) || "";
}

function getTraktHeaders(clientId) {
  return {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": clientId
  };
}

async function traktRequest(path, clientId, strict) {
  var response = await Widget.http.get(TRAKT_BASE + path, {
    headers: getTraktHeaders(clientId),
    timeout: REQUEST_TIMEOUT_MS
  });
  if (!response) {
    if (strict) throw new Error("Trakt 返回为空");
    return null;
  }
  if (response.ok === false) {
    if (strict) throw new Error("Trakt HTTP " + (response.status || "unknown"));
    return null;
  }
  var data = Array.isArray(response)
    ? response
    : response.data !== undefined
      ? response.data
      : response;
  if (typeof data !== "string") return data;
  if (!data.trim()) return null;
  try {
    return JSON.parse(data);
  } catch (error) {
    if (strict) throw error;
    return null;
  }
}

async function fetchAllTraktPages(pathBuilder, clientId) {
  var all = [];
  for (var page = 1; page <= TRAKT_MAX_PAGES; page++) {
    var data = await traktRequest(pathBuilder(page), clientId, page === 1);
    if (data == null) {
      if (page > 1) console.warn("[trakt] 第 " + page + " 页为空，提前结束");
      break;
    }
    var rows = toArray(data);
    if (!rows.length) break;
    all = all.concat(rows);
    if (rows.length < TRAKT_PAGE_LIMIT) break;
  }
  return all;
}

async function fetchWatchedShows(user, clientId) {
  return await fetchAllTraktPages(function (page) {
    return (
      "/users/" +
      encodeURIComponent(user) +
      "/watched/shows?extended=progress&page=" +
      page +
      "&limit=" +
      TRAKT_PAGE_LIMIT
    );
  }, clientId);
}

async function fetchShowHistory(user, showId, clientId) {
  return await fetchAllTraktPages(function (page) {
    return (
      "/users/" +
      encodeURIComponent(user) +
      "/history/shows/" +
      encodeURIComponent(showId) +
      "?page=" +
      page +
      "&limit=" +
      TRAKT_PAGE_LIMIT
    );
  }, clientId);
}

/* ==================== 观看统计 ==================== */

function getWatchStats(item) {
  var count = 0;
  var last = null;
  var seasons = toArray(item && item.seasons);
  for (var si = 0; si < seasons.length; si++) {
    var season = seasons[si];
    var sn = toNumber(season && season.number);
    if (sn <= 0) continue;
    var episodes = toArray(season && season.episodes);
    for (var ei = 0; ei < episodes.length; ei++) {
      var ep = episodes[ei];
      if (toNumber(ep && ep.plays) <= 0) continue;
      count++;
      var en = toNumber(ep && ep.number);
      if (en <= 0) continue;
      var isNewer =
        !last || sn > last.season || (sn === last.season && en > last.episode);
      if (isNewer) last = { season: sn, episode: en };
    }
  }
  return { count: count, last: last };
}

async function fetchHighestWatched(user, show, clientId) {
  var showId = getTraktShowId(show);
  if (!user || !showId) return null;
  return await cachedLoad(
    traktHistoryCache,
    user + ":" + showId,
    async function () {
      var rows = await fetchShowHistory(user, showId, clientId);
      var last = null;
      var lastWatchedAt = null;
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var episode = row && row.episode;
        if (!episode) continue;
        var s = toNumber(episode.season);
        var n = toNumber(episode.number);
        if (s <= 0 || n <= 0) continue;
        var isNewer =
          !last || s > last.season || (s === last.season && n > last.episode);
        if (isNewer) last = { season: s, episode: n };
        var watchedAt = row.watched_at || row.created_at;
        if (safeTime(watchedAt) > safeTime(lastWatchedAt)) {
          lastWatchedAt = watchedAt;
        }
      }
      return last ? { last: last, lastWatchedAt: lastWatchedAt } : null;
    }
  );
}

/* ==================== TMDB 客户端 ==================== */

function unpackResponse(response) {
  if (response == null) return null;
  var raw = response.data !== undefined ? response.data : response;
  if (typeof raw !== "string") return raw || null;
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

async function fetchTmdbShow(id) {
  return await cachedLoad(tmdbShowCache, "tmdb:tv:" + id, async function () {
    var data = unpackResponse(
      await Widget.tmdb.get("/tv/" + id, { params: { language: "zh-CN" } })
    );
    if (!data || typeof data !== "object") throw new Error("TMDB 剧集详情为空");
    return data;
  });
}

async function loadTmdbShow(tmdbId) {
  if (!tmdbId) return { tmdbShow: null, failed: false };
  try {
    return { tmdbShow: await fetchTmdbShow(tmdbId), failed: false };
  } catch (err) {
    console.warn("[tmdb] loadTmdbShow failed for " + tmdbId + ":", err && err.message);
    return { tmdbShow: null, failed: true };
  }
}

/* ==================== 下一集推断 ==================== */

function nextResult(season, episode) {
  return { status: "next", next: { season: season, episode: episode } };
}

async function inferNextEpisode(last, tmdbShow, show, aired, tmdbFailed) {
  if (!last) return { status: "none" };

  var seasonEpisodes = toArray(show && show.seasons).find(function (s) {
    return toNumber(s && s.number) === last.season;
  });
  if (seasonEpisodes) {
    var episodes = toArray(seasonEpisodes.episodes);
    var nextInSeason = episodes.find(function (ep) {
      return toNumber(ep && ep.number) === last.episode + 1;
    });
    if (nextInSeason) {
      if (toNumber(nextInSeason.plays) > 0) {
        return nextResult(last.season, last.episode + 1);
      }
      return { status: "none" };
    }
  }

  if (last.season === 1 && toNumber(aired) > last.episode) {
    return nextResult(last.season, last.episode + 1);
  }

  if (!tmdbId || tmdbFailed) return { status: "lookup_failed" };

  var nextSeasonNo = last.season + 1;
  var hasNext = toArray(tmdbShow && tmdbShow.seasons).some(function (s) {
    return (
      toNumber(s && s.season_number) === nextSeasonNo &&
      toNumber(s && s.episode_count) > 0
    );
  });
  if (!hasNext) return { status: "none" };

  return { status: "lookup_failed" };
}

/* ==================== 媒体对象组装 ==================== */

function makeMedia(options) {
  var show = options.show;
  var tmdbId = options.tmdbId;
  var tmdbShow = options.tmdbShow;
  var title = options.title;
  var year = options.year;
  var season = options.season;
  var episode = options.episode;
  var lines = options.lines;
  var lastWatchedAt = options.lastWatchedAt;

  var fallbackId =
    (show && show.ids && (show.ids.trakt || show.ids.tmdb)) || title;
  var media = {
    id: "tv." + (tmdbId || fallbackId),
    type: "tmdb",
    mediaType: "tv",
    title: title,
    year: year,
    description: lines.join("\n")
  };

  if (season > 0 && episode > 0) {
    media.currentSeason = season;
    media.currentEpisode = episode;
    media.currentEpisodeName = "第" + episode + "集";
  }

  var rating = normalizeRating(tmdbShow && tmdbShow.vote_average);
  if (rating > 0) media.rating = rating;
  if (tmdbId) media.tmdbId = tmdbId;
  if (tmdbShow && tmdbShow.poster_path)
    media.posterPath = TMDB_POSTER + tmdbShow.poster_path;
  if (tmdbShow && tmdbShow.backdrop_path)
    media.backdropPath = TMDB_BACKDROP + tmdbShow.backdrop_path;
  if (tmdbShow && tmdbShow.overview) media.overview = tmdbShow.overview;
  if (lastWatchedAt) media.lastWatchedAt = lastWatchedAt;

  var genreNames = toArray(tmdbShow && tmdbShow.genres)
    .map(function (g) {
      return g && g.name;
    })
    .filter(Boolean);
  if (genreNames.length) {
    media.genres = genreNames;
    media.tags = genreNames;
    media.genre = genreNames.join(",");
  }

  return media;
}

/* ==================== 继续观看条目构建 ==================== */

async function buildContinueItem(item, user, clientId) {
  var show = item && item.show;
  if (!show) return null;

  var stats = getWatchStats(item);
  var last = stats.last;
  var lastWatchedAt = item.last_watched_at;

  if (!last) return null;

  var tmdbId = toNumber(show.ids && show.ids.tmdb);
  var title =
    show.title ||
    show.original_title ||
    (show.ids && show.ids.slug) ||
    "未知剧集";
  var year = String(show.year || "");

  var results = await Promise.all([
    fetchHighestWatched(user, show, clientId),
    loadTmdbShow(tmdbId)
  ]);
  var history = results[0];
  var tmdbResult = results[1];
  var tmdbShow = tmdbResult.tmdbShow;
  var tmdbFailed = tmdbResult.failed;

  if (history && history.last) {
    last = history.last;
    lastWatchedAt = history.lastWatchedAt || lastWatchedAt;
  }

  var aired = toNumber(show.aired_episodes);
  var next = await inferNextEpisode(last, tmdbShow, show, aired, tmdbFailed);

  var displayTitle = (tmdbShow && tmdbShow.name) || title;

  var lines = [];
  lines.push("上次观看 " + formatSE(last.season, last.episode));

  if (lastWatchedAt) {
    var day = getDisplayDate(lastWatchedAt);
    if (day) lines.push("观看时间 " + day);
  }

  if (aired > 0 && stats.count > 0) {
    var pct = Math.min(100, Math.max(0, (stats.count / aired) * 100));
    lines.push(
      "进度 " + stats.count + "/" + aired + " (" + Math.round(pct) + "%)"
    );
  }

  if (next.status === "next" && next.next) {
    lines.push("下一集 " + formatSE(next.next.season, next.next.episode));
  } else if (next.status === "lookup_failed") {
    lines.push("下一集待确认");
  }

  var targetSeason =
    next.status === "next" && next.next ? next.next.season : last.season;
  var targetEpisode =
    next.status === "next" && next.next ? next.next.episode : last.episode;

  return makeMedia({
    show: show,
    tmdbId: tmdbId,
    tmdbShow: tmdbShow,
    title: displayTitle,
    year: year,
    season: targetSeason,
    episode: targetEpisode,
    lines: lines,
    lastWatchedAt: lastWatchedAt
  });
}

/* ==================== 主数据源函数 ==================== */

async function loadContinueWatching(params) {
  try {
    var user = getUser(params);
    if (!user) {
      return textItem(
        "need-user",
        "请先设置 Trakt 用户名",
        "在组件设置中填写你的 Trakt 用户名（不是邮箱）"
      );
    }

    var clientId = getClientId(params);
    if (!clientId) {
      return textItem(
        "need-client-id",
        "请配置 Trakt Client ID",
        "前往 trakt.tv/oauth/applications 创建应用后获取 Client ID"
      );
    }

    var paging = getPaging(params);
    var page = paging.page;
    var pageSize = paging.pageSize;
    var recentDays = getRecentDays(params);

    var watched = await fetchWatchedShows(user, clientId);
    if (!watched.length) {
      return textItem("empty", "没有观看记录", "该 Trakt 账号暂无剧集观看记录");
    }

    var recent = watched.filter(function (item) {
      return isRecent(item, recentDays);
    });

    if (!recent.length) {
      return textItem(
        "empty-recent",
        "暂无继续观看",
        "最近 " +
          (recentDays > 0 ? recentDays + " 天" : "一段时间") +
          "内没有新的观看记录"
      );
    }

    recent.sort(function (a, b) {
      return safeTime(b && b.last_watched_at) - safeTime(a && a.last_watched_at);
    });

    var start = (page - 1) * pageSize;
    var slice = recent.slice(start, start + pageSize);
    if (!slice.length) return [];

    var results = [];
    for (var i = 0; i < slice.length; i++) {
      try {
        var media = await buildContinueItem(slice[i], user, clientId);
        if (media) results.push(media);
      } catch (err) {
        console.warn(
          "[continue] buildContinueItem failed for index " + i + ":",
          err && err.message
        );
      }
    }

    return dedupeById(results, function (item) {
      return String(item && item.id ? item.id : "");
    });
  } catch (error) {
    console.error("加载失败:", error && error.message);
    return textItem(
      "err-load",
      "读取 Trakt 失败",
      (error && error.message) + "\n请稍后重试"
    );
  }
}
