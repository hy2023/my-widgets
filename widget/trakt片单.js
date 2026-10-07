/* * CapyPlayer Widget - 我的片单（重写版）
 * 模块：继续观看
 * 功能：
 *   - 从 Trakt 同步观看记录，推断下一集
 *   - 预告获取（4 级兜底）：Trakt 当前季未来集 → Trakt next_episode
 *     → TMDB next_episode_to_air → TMDB 当前季未来集
 *   - 完结判断（Trakt 首选）：本季播完 + 有下一季 → 本季已完结；
 *     本季播完 + 无下一季 → 全剧已完结
 *   - 用 TMDB genres 填充 media.genres / tags / genre
 *   - 用 TMDB currentSeason / currentEpisode 覆盖 App 内部播放记录
 * 类型：CapyPlayer media_list
 */

var WidgetMetadata = {
  id: "trakt_continue_username",
  title: "我的片单",
  author: "Blue",
  description: "同步 Trakt 观看记录，自动推断下一集并生成继续观看列表。",
  version: "2.0.0",
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
      defaultValue: "95b59922670c84040db3632c7aac6f33704f6ffe5cbf3113a056e37cb45cb482"
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
            { title: "20", value: "20" }
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

const TRAKT_BASE = "https://api.trakt.tv";
const TMDB_POSTER = "https://image.tmdb.org/t/p/w500";
const TMDB_BACKDROP = "https://image.tmdb.org/t/p/w780";
const TRAKT_PAGE_LIMIT = 100;
const TRAKT_MAX_PAGES = 20;
const MAX_CONCURRENCY = 5;
const MAX_CACHE_SIZE = 300;
const REQUEST_TIMEOUT_MS = 15000;
const HIDE_AFTER_DAYS = 60;

/* ==================== 工具 ==================== */

const toArray = (value) => (Array.isArray(value) ? value : []);

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

const pad2 = (value) => String(toNumber(value)).padStart(2, "0");

const formatSE = (season, episode) => `S${pad2(season)}E${pad2(episode)}`;

function safeTime(value) {
  const time = new Date(value || 0).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function normalizeRating(value) {
  const n = toNumber(value);
  return n > 0 ? Math.round(n * 10) / 10 : 0;
}

function textItem(id, title, description = "") {
  const item = { id, type: "text", title };
  if (description) item.description = description;
  return [item];
}

function loadError(error) {
  const message = error?.message || String(error);
  console.error("加载失败:", message);
  return textItem("err-load", "读取 Trakt 失败", `${message}\n请稍后重试`);
}

function getUser(params) {
  return String(params?.traktUser || "").trim();
}

function getClientId(params) {
  const custom = String(params?.traktClientId || "").trim();
  return custom || "95b59922670c84040db3632c7aac6f33704f6ffe5cbf3113a056e37cb45cb482";
}

function getPaging(params) {
  return {
    page: Math.max(1, parseInt(params?.page || 1, 10) || 1),
    pageSize: Math.max(1, parseInt(params?.pageSize || 15, 10) || 15)
  };
}

function getRecentDays(params) {
  const raw = params?.recentDays;
  if (raw === undefined || raw === null || raw === "") return HIDE_AFTER_DAYS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : HIDE_AFTER_DAYS;
}

function uniqueNumbers(values) {
  return [...new Set(toArray(values).map(toNumber).filter((n) => n > 0))].sort(
    (a, b) => a - b
  );
}

function dedupeById(arr, keyFn) {
  const seen = new Set();
  return toArray(arr).filter((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ==================== 缓存（LRU 上限） ==================== */

const tmdbShowCache = new Map();
const tmdbSeasonCache = new Map();
const traktRatingCache = new Map();
const traktSeasonCache = new Map();
const traktNextCache = new Map();
const traktHistoryCache = new Map();

async function cachedLoad(cache, key, loader) {
  if (cache.has(key)) return await cache.get(key);
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  const promise = Promise.resolve().then(loader);
  cache.set(key, promise);
  try {
    const value = await promise;
    cache.set(key, value);
    return value;
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}

/* ==================== 日期 / 时间 ==================== */

function getDisplayDate(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const matched = value.trim().match(/^(\d{4}-\d{2}-\d{2})$/);
    if (matched) return matched[1];
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    if (map.year && map.month && map.day) {
      return `${map.year}-${map.month}-${map.day}`;
    }
  } catch (_) {
    /* fallthrough */
  }
  const shifted = new Date(date.getTime() + 8 * 3600000);
  return [
    shifted.getUTCFullYear(),
    pad2(shifted.getUTCMonth() + 1),
    pad2(shifted.getUTCDate())
  ].join("-");
}

function formatAiredTime(value) {
  if (!value || typeof value !== "string" || !value.includes("T")) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(date);
    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    if (map.hour && map.minute) return `${map.hour}:${map.minute}`;
  } catch (_) {
    /* ignore */
  }
  return "";
}

function dayNumber(day) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || "");
  if (!matched) return NaN;
  return (
    Date.UTC(toNumber(matched[1]), toNumber(matched[2]) - 1, toNumber(matched[3])) /
    86400000
  );
}

const today = () => getDisplayDate(new Date());

function hasAired(value) {
  if (!value) return false;
  const day = getDisplayDate(String(value).slice(0, 10));
  return !!day && day <= today();
}

function remainingText(targetDay) {
  const target = dayNumber(targetDay);
  const current = dayNumber(today());
  if (!Number.isFinite(target) || !Number.isFinite(current)) return "";
  const diff = target - current;
  if (diff === 0) return "今天播出";
  if (diff === 1) return "明天播出";
  return diff > 0 ? `还有 ${diff} 天` : "";
}

/* ==================== Trakt 客户端 ==================== */

const getTraktShowId = (show) => show?.ids?.trakt || show?.ids?.slug || "";

function getTraktHeaders(clientId) {
  return {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": clientId
  };
}

async function traktRequest(path, clientId, strict = false) {
  const response = await Widget.http.get(TRAKT_BASE + path, {
    headers: getTraktHeaders(clientId),
    timeout: REQUEST_TIMEOUT_MS
  });
  if (!response) {
    if (strict) throw new Error("Trakt 返回为空");
    return null;
  }
  if (response.ok === false) {
    if (strict) throw new Error(`Trakt HTTP ${response.status || "unknown"}`);
    return null;
  }
  let data = Array.isArray(response)
    ? response
    : response?.data !== undefined
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
  const all = [];
  for (let page = 1; page <= TRAKT_MAX_PAGES; page++) {
    const data = await traktRequest(pathBuilder(page), clientId, page === 1);
    if (data == null) {
      if (page > 1) console.warn(`Trakt 第 ${page} 页为空，提前结束`);
      break;
    }
    const rows = toArray(data);
    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < TRAKT_PAGE_LIMIT) break;
  }
  return all;
}

const fetchWatchedShows = (user, clientId) =>
  fetchAllTraktPages(
    (page) =>
      `/users/${encodeURIComponent(user)}/watched/shows` +
      `?extended=progress&page=${page}&limit=${TRAKT_PAGE_LIMIT}`,
    clientId
  );

const fetchShowHistory = (user, showId, clientId) =>
  fetchAllTraktPages(
    (page) =>
      `/users/${encodeURIComponent(user)}/history/shows/` +
      `${encodeURIComponent(showId)}?page=${page}&limit=${TRAKT_PAGE_LIMIT}`,
    clientId
  );

async function fetchTraktSeason(show, season, clientId) {
  const id = getTraktShowId(show);
  if (!id || season <= 0) return [];
  const key = `trakt:${id}:${season}`;
  try {
    return await cachedLoad(traktSeasonCache, key, async () => {
      const data = await traktRequest(
        `/shows/${encodeURIComponent(id)}/seasons/${season}?extended=full`,
        clientId
      );
      return Array.isArray(data) ? data : toArray(data?.episodes);
    });
  } catch (err) {
    console.warn(`[trakt] fetchTraktSeason failed for ${id} S${season}:`, err?.message || err);
    return [];
  }
}

async function fetchTraktRating(show, clientId) {
  const id = getTraktShowId(show);
  if (!id) return 0;
  try {
    return await cachedLoad(traktRatingCache, `trakt:${id}`, async () => {
      const data = await traktRequest(
        `/shows/${encodeURIComponent(id)}/ratings`,
        clientId
      );
      return normalizeRating(data?.rating);
    });
  } catch (err) {
    console.warn(`[trakt] fetchTraktRating failed for ${id}:`, err?.message || err);
    return 0;
  }
}

async function fetchTraktNext(show, clientId) {
  const id = getTraktShowId(show);
  if (!id) return null;
  try {
    return await cachedLoad(traktNextCache, `trakt:${id}`, async () => {
      const data = await traktRequest(
        `/shows/${encodeURIComponent(id)}/next_episode?extended=full`,
        clientId
      );
      const s = toNumber(data?.season);
      const n = toNumber(data?.number);
      if (s <= 0 || n <= 0) return null;
      return {
        season: s,
        number: n,
        title: data?.title || "",
        firstAired:
          data?.first_aired || data?.effective_release_date || null
      };
    });
  } catch (err) {
    console.warn(`[trakt] fetchTraktNext failed for ${id}:`, err?.message || err);
    return null;
  }
}

function isTraktEpisodeAired(episode) {
  const value = episode?.first_aired || episode?.effective_release_date;
  return value ? hasAired(value) : false;
}

/* ==================== TMDB 客户端 ==================== */

function unpackResponse(response) {
  if (response == null) return null;
  const raw = response?.data !== undefined ? response.data : response;
  if (typeof raw !== "string") return raw || null;
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

async function fetchTmdbShow(id) {
  return await cachedLoad(tmdbShowCache, `tmdb:tv:${id}`, async () => {
    const data = unpackResponse(
      await Widget.tmdb.get(`/tv/${id}`, { params: { language: "zh-CN" } })
    );
    if (!data || typeof data !== "object") throw new Error("TMDB 剧集详情为空");
    return data;
  });
}

async function fetchTmdbSeason(id, season) {
  return await cachedLoad(tmdbSeasonCache, `tmdb:tv:${id}:${season}`, async () => {
    const data = unpackResponse(
      await Widget.tmdb.get(`/tv/${id}/season/${season}`, {
        params: { language: "zh-CN" }
      })
    );
    if (!data || typeof data !== "object") throw new Error("TMDB 季详情为空");
    return data;
  });
}

async function loadTmdbShow(tmdbId) {
  if (!tmdbId) return { tmdbShow: null, failed: false };
  try {
    return { tmdbShow: await fetchTmdbShow(tmdbId), failed: false };
  } catch (err) {
    console.warn(`[tmdb] loadTmdbShow failed for ${tmdbId}:`, err?.message || err);
    return { tmdbShow: null, failed: true };
  }
}

/* ==================== 观看统计与历史 ==================== */

function getWatchStats(item) {
  let count = 0;
  let last = null;
  for (const season of toArray(item?.seasons)) {
    const sn = toNumber(season?.number);
    if (sn <= 0) continue;
    for (const episode of toArray(season?.episodes)) {
      if (toNumber(episode?.plays) <= 0) continue;
      count++;
      const en = toNumber(episode?.number);
      if (en <= 0) continue;
      const isNewer =
        !last || sn > last.season || (sn === last.season && en > last.episode);
      if (isNewer) last = { season: sn, episode: en };
    }
  }
  return { count, last };
}

async function fetchHighestWatched(user, show, clientId) {
  const showId = getTraktShowId(show);
  if (!user || !showId) return null;
  return await cachedLoad(traktHistoryCache, `${user}:${showId}`, async () => {
    const rows = await fetchShowHistory(user, showId, clientId);
    let last = null;
    let lastWatchedAt = null;
    for (const row of rows) {
      const episode = row?.episode;
      if (!episode) continue;
      const s = toNumber(episode.season);
      const n = toNumber(episode.number);
      if (s <= 0 || n <= 0) continue;
      const isNewer =
        !last || s > last.season || (s === last.season && n > last.episode);
      if (isNewer) last = { season: s, episode: n };
      const watchedAt = row?.watched_at || row?.created_at;
      if (safeTime(watchedAt) > safeTime(lastWatchedAt)) {
        lastWatchedAt = watchedAt;
      }
    }
    return last ? { last, lastWatchedAt } : null;
  });
}

const getAiredCount = (show, tmdbShow) =>
  toNumber(show?.aired_episodes) || toNumber(tmdbShow?.number_of_episodes);

/* ==================== 媒体对象组装 ==================== */

function makeShowMeta(show, tmdbShow) {
  return {
    title:
      tmdbShow?.name || show?.title || tmdbShow?.original_name || "未知剧集",
    year: String(
      show?.year ||
        String(tmdbShow?.first_air_date || "").slice(0, 4) ||
        ""
    )
  };
}

function makeMedia({
  show,
  tmdbId,
  tmdbShow,
  title,
  year,
  season,
  episode,
  lines
}) {
  const fallbackId = show?.ids?.trakt || show?.ids?.tmdb || title;
  const media = {
    id: `tv.${tmdbId || fallbackId}`,
    type: "tmdb",
    mediaType: "tv",
    title,
    year,
    description: lines.join("\n")
  };
  if (season > 0 && episode > 0) {
    media.currentSeason = season;
    media.currentEpisode = episode;
    media.currentEpisodeName = `第${episode}集`;
  }
  const rating = normalizeRating(tmdbShow?.vote_average);
  if (rating > 0) media.rating = rating;
  if (tmdbId) media.tmdbId = tmdbId;
  if (tmdbShow?.poster_path) media.posterPath = TMDB_POSTER + tmdbShow.poster_path;
  if (tmdbShow?.backdrop_path)
    media.backdropPath = TMDB_BACKDROP + tmdbShow.backdrop_path;
  if (tmdbShow?.overview) media.overview = tmdbShow.overview;

  const genreNames = toArray(tmdbShow?.genres)
    .map((g) => g?.name)
    .filter(Boolean);
  if (genreNames.length) {
    media.genres = genreNames;
    media.tags = genreNames;
    media.genre = genreNames.join(",");
  }
  return media;
}

/* ==================== 下一集推断 ==================== */

const nextResult = (season, episode) => ({
  status: "next",
  next: { season, episode }
});

async function inferNextEpisode(
  last,
  tmdbId,
  tmdbShow,
  show,
  aired,
  tmdbFailed,
  clientId
) {
  if (!last) return { status: "none" };

  // 1. Trakt 当前季
  const curSeason = await fetchTraktSeason(show, last.season, clientId);
  const nextInCur = curSeason.find(
    (ep) => toNumber(ep?.number) === last.episode + 1
  );
  if (nextInCur) {
    if (isTraktEpisodeAired(nextInCur)) {
      return nextResult(last.season, last.episode + 1);
    }
    return { status: "none" };
  }

  // 2. Trakt 下一季
  const nextSeasonData = await fetchTraktSeason(show, last.season + 1, clientId);
  const firstOfNext = nextSeasonData.find(
    (ep) => toNumber(ep?.number) === 1
  );
  if (firstOfNext) {
    if (isTraktEpisodeAired(firstOfNext)) {
      return nextResult(last.season + 1, 1);
    }
    return { status: "none" };
  }

  // 3. 兜底
  const canFallback =
    last.season === 1 &&
    toNumber(aired || show?.aired_episodes) > last.episode;
  const fallback = () =>
    canFallback ? nextResult(last.season, last.episode + 1) : { status: "lookup_failed" };
  if (!tmdbId || tmdbFailed) return fallback();

  // 4. TMDB 当前季
  let seasonData;
  try {
    seasonData = await fetchTmdbSeason(tmdbId, last.season);
  } catch (_) {
    return fallback();
  }
  const nextOnTmdb = toArray(seasonData?.episodes).find(
    (ep) => toNumber(ep?.episode_number) === last.episode + 1
  );
  if (nextOnTmdb) {
    return hasAired(nextOnTmdb?.air_date)
      ? nextResult(last.season, toNumber(nextOnTmdb.episode_number))
      : { status: "none" };
  }
  const latest = tmdbShow?.last_episode_to_air;
  if (
    latest &&
    toNumber(latest.season_number) === last.season &&
    toNumber(latest.episode_number) >= last.episode + 1
  ) {
    return nextResult(last.season, last.episode + 1);
  }
  if (canFallback) return fallback();

  // 5. TMDB 下一季
  const nextSeasonNo = last.season + 1;
  const hasNext = toArray(tmdbShow?.seasons).some(
    (s) =>
      toNumber(s?.season_number) === nextSeasonNo &&
      toNumber(s?.episode_count) > 0
  );
  if (!hasNext) return { status: "none" };
  try {
    const ns = await fetchTmdbSeason(tmdbId, nextSeasonNo);
    const ep1 = toArray(ns?.episodes).find(
      (ep) => toNumber(ep?.episode_number) === 1 && hasAired(ep?.air_date)
    );
    return ep1 ? nextResult(nextSeasonNo, 1) : { status: "none" };
  } catch (_) {
    return { status: "lookup_failed" };
  }
}

/* ==================== 预告（4 级兜底） ==================== */

async function resolveSeasonPreview(
  show,
  tmdbId,
  tmdbShow,
  currentSeason,
  currentEpisode,
  clientId
) {
  const [episodes, next] = await Promise.all([
    fetchTraktSeason(show, currentSeason, clientId),
    fetchTraktNext(show, clientId)
  ]);
  const preview = findNearestFutureBatch(episodes, currentSeason, currentEpisode);
  if (preview) return preview;
  if (next) {
    const nextSeason = toNumber(next.season);
    const nextEpisode = toNumber(next.number);
    if (nextSeason > 0 && nextEpisode > 0) {
      const fallback = {
        season: nextSeason,
        episodes: [nextEpisode],
        firstAired: next.firstAired || null,
        displayDay: getDisplayDate(next.firstAired)
      };
      if (nextSeason === currentSeason) return fallback;
      const nextEpisodes = await fetchTraktSeason(show, nextSeason, clientId);
      const p = findNearestFutureBatch(nextEpisodes, nextSeason, 0);
      return p || fallback;
    }
  }
  const tmdbNext = tmdbShow?.next_episode_to_air;
  if (tmdbNext) {
    const ns = toNumber(tmdbNext.season_number);
    const ne = toNumber(tmdbNext.episode_number);
    const day = getDisplayDate(tmdbNext.air_date);
    if (ns > 0 && ne > 0 && day && day >= today()) {
      return {
        season: ns,
        episodes: [ne],
        firstAired: tmdbNext.air_date || null,
        displayDay: day
      };
    }
  }
  if (tmdbId) {
    try {
      const seasonData = await fetchTmdbSeason(tmdbId, currentSeason);
      const future = toArray(seasonData?.episodes)
        .filter((ep) => {
          const n = toNumber(ep?.episode_number);
          if (n <= currentEpisode) return false;
          const d = getDisplayDate(ep?.air_date);
          return !!d && d >= today();
        })
        .sort(
          (a, b) =>
            toNumber(a?.episode_number) - toNumber(b?.episode_number)
        );
      if (future.length) {
        const ep = future[0];
        return {
          season: currentSeason,
          episodes: [toNumber(ep?.episode_number)],
          firstAired: ep?.air_date || null,
          displayDay: getDisplayDate(ep?.air_date)
        };
      }
    } catch (err) {
      console.warn("[tmdb] preview season fetch failed:", err?.message || err);
    }
  }
  return null;
}

function findNearestFutureBatch(episodes, season, afterEpisode) {
  const list = toArray(episodes);
  if (!list.length) return null;
  const todayStr = today();
  const future = list
    .map((ep) => {
      const fa = ep?.first_aired || ep?.effective_release_date || null;
      return {
        season: toNumber(ep?.season || season),
        episode: toNumber(ep?.number),
        firstAired: fa,
        displayDay: getDisplayDate(fa)
      };
    })
    .filter(
      (ep) =>
        ep.season > 0 &&
        ep.episode > 0 &&
        ep.displayDay &&
        !(ep.season === season && ep.episode <= afterEpisode) &&
        ep.displayDay >= todayStr
    );
  if (!future.length) return null;
  future.sort(
    (a, b) =>
      a.displayDay.localeCompare(b.displayDay) ||
      a.season - b.season ||
      a.episode - b.episode
  );
  const first = future[0];
  const nums = uniqueNumbers(
    future
      .filter(
        (ep) => ep.displayDay === first.displayDay && ep.season === first.season
      )
      .map((ep) => ep.episode)
  );
  if (!nums.length) return null;
  return {
    season: first.season,
    episodes: nums,
    firstAired: first.firstAired,
    displayDay: first.displayDay
  };
}

function seRange(season, episodes) {
  const list = uniqueNumbers(episodes);
  if (season <= 0 || !list.length) return "";
  const prefix = `S${pad2(season)}`;
  if (list.length === 1) return `${prefix}E${pad2(list[0])}`;
  const continuous = list.every(
    (n, i) => i === 0 || n === list[i - 1] + 1
  );
  if (continuous) {
    return `${prefix}E${pad2(list[0])}-E${pad2(list[list.length - 1])}`;
  }
  return prefix + list.map((n) => `E${pad2(n)}`).join(",");
}

function buildPreviewText(preview) {
  if (!preview) return "";
  const range = seRange(toNumber(preview.season), preview.episodes);
  if (!range) return "";
  const d = preview.displayDay || getDisplayDate(preview.firstAired);
  if (!d) return ` ${range}`;
  const time = formatAiredTime(preview.firstAired);
  const rem = remainingText(d);
  if (rem === "今天播出") {
    return time ? ` ${range} · 今天 ${time}` : ` ${range} · 今天播出`;
  }
  if (rem === "明天播出") {
    return time ? ` ${range} · 明天 ${time}` : ` ${range} · 明天播出`;
  }
  const shortDate = d.slice(5).replace("-", "/");
  return time
    ? ` ${range} · ${shortDate} ${time} 更新`
    : ` ${range} · ${shortDate} 更新`;
}

/* ==================== 继续观看条目构建 ==================== */

function isRecentContinueItem(item, days = HIDE_AFTER_DAYS) {
  const t = safeTime(item?.last_watched_at);
  if (t <= 0) return false;
  if (!days || days <= 0) return true;
  const diff = Date.now() - t;
  return diff >= 0 && diff <= days * 86400000;
}

async function buildContinueItem(item, user, clientId) {
  const show = item?.show;
  const last = getWatchStats(item).last;
  const lastWatchedAt = item?.last_watched_at;

  if (!last) return null;

  const tmdbId = toNumber(show?.ids?.tmdb);
  const meta = makeShowMeta(show, null);

  const [history, tmdbResult] = await Promise.all([
    fetchHighestWatched(user, show, clientId),
    loadTmdbShow(tmdbId)
  ]);
  const { tmdbShow, failed: tmdbFailed } = tmdbResult;

  const aired = getAiredCount(show, tmdbShow);
  const result = await inferNextEpisode(
    last,
    tmdbId,
    tmdbShow,
    show,
    aired,
    tmdbFailed,
    clientId
  );

  const lines = [];
  lines.push(`上次观看 ${formatSE(last.season, last.episode)}`);

  if (lastWatchedAt) {
    const day = getDisplayDate(lastWatchedAt);
    const time = formatAiredTime(lastWatchedAt);
    if (day) {
      lines.push(`观看时间 ${day}${time ? " " + time : ""}`);
    }
  }

  const totalEpisodes = toNumber(show?.aired_episodes);
  const watchedCount = getWatchStats(item).count;
  if (totalEpisodes > 0 && watchedCount > 0) {
    const pct = Math.min(100, Math.max(0, (watchedCount / totalEpisodes) * 100));
    lines.push(`进度 ${watchedCount}/${totalEpisodes} (${Math.round(pct)}%)`);
  }

  if (result.status === "next" && result.next) {
    lines.push(`下一集 ${formatSE(result.next.season, result.next.episode)}`);
  } else if (result.status === "lookup_failed") {
    lines.push("下一集待确认");
  }

  try {
    const preview = await resolveSeasonPreview(
      show,
      tmdbId,
      tmdbShow,
      last.season,
      last.episode,
      clientId
    );
    const previewText = buildPreviewText(preview);
    if (previewText) lines.push(`预告${previewText}`);
  } catch (err) {
    console.warn("[preview] resolve failed:", err?.message || err);
  }

  const media = makeMedia({
    show,
    tmdbId,
    tmdbShow,
    title: tmdbShow?.name || show?.title || meta.title,
    year: meta.year,
    season: result.status === "next" && result.next ? result.next.season : last.season,
    episode:
      result.status === "next" && result.next
        ? result.next.episode
        : last.episode,
    lines
  });

  if (lastWatchedAt) media.lastWatchedAt = lastWatchedAt;

  return media;
}

/* ==================== 主数据源函数 ==================== */

async function loadContinueWatching(params) {
  try {
    const user = getUser(params);
    if (!user) {
      return textItem(
        "need-user",
        "请先设置 Trakt 用户名",
        "在组件设置中填写你的 Trakt 用户名（不是邮箱）"
      );
    }

    const clientId = getClientId(params);
    const { page, pageSize } = getPaging(params);
    const recentDays = getRecentDays(params);

    const watched = await fetchWatchedShows(user, clientId);
    if (!watched.length) {
      return textItem("empty", "没有观看记录", "该 Trakt 账号暂无剧集观看记录");
    }

    const recent = watched.filter((item) =>
      isRecentContinueItem(item, recentDays)
    );

    if (!recent.length) {
      return textItem(
        "empty-recent",
        "暂无继续观看",
        `最近 ${recentDays > 0 ? recentDays + " 天" : "一段时间"}内没有新的观看记录`
      );
    }

    recent.sort(
      (a, b) => safeTime(b?.last_watched_at) - safeTime(a?.last_watched_at)
    );

    const start = (page - 1) * pageSize;
    const slice = recent.slice(start, start + pageSize);

    if (!slice.length) return [];

    const results = [];
    for (let i = 0; i < slice.length; i++) {
      try {
        const media = await buildContinueItem(slice[i], user, clientId);
        if (media) results.push(media);
      } catch (err) {
        console.warn(
          `[continue] buildContinueItem failed for index ${i}:`,
          err?.message || err
        );
      }
    }

    return dedupeById(results, (item) => String(item?.id || ""));
  } catch (error) {
    return loadError(error);
  }
}
