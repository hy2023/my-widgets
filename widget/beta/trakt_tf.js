/*
 * CapyPlayer Widget - Trakt 官方 Continue Watching
 * v2.0.0
 *
 * 严格遵照 CapyPlayer 组件开发指南编写：
 * 1. 使用全局 var WidgetMetadata
 * 2. 显式区分 type ("tmdb") 与 mediaType ("tv")
 * 3. 严格返回 MediaItem[] 数组
 */

var WidgetMetadata = {
    id: "trakt_continue_username",
    title: "Trakt片单",
    author: "Holyn",
    description: "使用 Trakt 官方 Continue Watching / Up Next 数据生成继续观看列表。",
    version: "2.0.0",

    globalParams: [
        {
            name: "traktUser",
            title: "Trakt 用户名（仅显示/兼容）",
            type: "string",
            defaultValue: ""
        },
        {
            name: "traktAccessToken",
            title: "Trakt Access Token",
            type: "string",
            defaultValue: ""
        }
    ],

    modules: [
        {
            id: "continue_watching",
            title: "继续观看",
            functionName: "loadContinueWatching",
            type: "media_list",
            cacheDuration: 300,
            timeoutSeconds: 25,
            retryCount: 2,
            params: [
                {
                    name: "page",
                    title: "页码",
                    type: "page"
                },
                {
                    name: "count",
                    title: "每页数量",
                    type: "count",
                    defaultValue: "15"
                }
            ]
        }
    ]
};

/* ==================== 常量 ==================== */

var TRAKT_BASE = "https://api.trakt.tv";
var TRAKT_CLIENT_ID =
    "95b59922670c84040db3632c7aac6f33704f6ffe5cbf3113a056e37cb45cb482";

var TMDB_POSTER = "https://image.tmdb.org/t/p/w500";
var TMDB_BACKDROP = "https://image.tmdb.org/t/p/w780";

var TIMEOUT_TRAKT = 25000;
var TIMEOUT_TMDB = 25000;
var MAX_RETRY = 2;
var RETRY_DELAY_MS = 800;
var MAX_PAGE_SIZE = 50;

var tmdbShowCache = new Map();
var tmdbSeasonCache = new Map();
var pendingMap = new Map();

/* ==================== 基础工具 ==================== */

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

function getUser(params) {
    return String(params && params.traktUser || "").trim();
}

function getAccessToken(params) {
    return String(params && params.traktAccessToken || "").trim();
}

function getPaging(params) {
    var rawPage = parseInt(params && params.page || 1, 10) || 1;
    var rawCount = parseInt(params && (params.count || params.pageSize) || 15, 10) || 15;

    return {
        page: Math.max(1, rawPage),
        pageSize: Math.min(MAX_PAGE_SIZE, Math.max(1, rawCount))
    };
}

/* ==================== Trakt 请求 ==================== */

function getTraktHeaders(accessToken) {
    var headers = {
        "Content-Type": "application/json",
        "trakt-api-version": "2",
        "trakt-api-key": TRAKT_CLIENT_ID
    };

    if (accessToken) {
        headers.Authorization = "Bearer " + accessToken;
    }

    return headers;
}

async function traktRequest(path, accessToken, strict) {
    var lastError = null;

    for (var attempt = 0; attempt <= MAX_RETRY; attempt++) {
        try {
            var response = await Widget.http.get(
                TRAKT_BASE + path,
                {
                    headers: getTraktHeaders(accessToken),
                    timeout: TIMEOUT_TRAKT
                }
            );

            if (!response) {
                lastError = new Error("Trakt 返回为空");
            } else if (response.ok === false) {
                lastError = new Error(
                    "Trakt HTTP " + (response.status || "unknown")
                );
            } else {
                var data = response.data !== undefined
                    ? response.data
                    : response;

                if (typeof data !== "string") {
                    return data;
                }

                if (!data.trim()) {
                    return null;
                }

                try {
                    return JSON.parse(data);
                } catch (error) {
                    lastError = error;
                }
            }
        } catch (error) {
            lastError = error;
        }

        if (attempt < MAX_RETRY) {
            await new Promise(function(resolve) {
                setTimeout(resolve, RETRY_DELAY_MS);
            });
        }
    }

    if (strict) {
        throw lastError || new Error("Trakt 请求失败");
    }

    return null;
}

/* ==================== TMDB ==================== */

function cachedLoad(cache, key, loader, ttlMs) {
    var now = Date.now();
    var mem = cache.get(key);

    if (mem && (!ttlMs || now - mem.t < ttlMs)) {
        return Promise.resolve(mem.v);
    }

    if (pendingMap.has(key)) {
        return pendingMap.get(key);
    }

    var task = (async function() {
        var value = await loader();
        cache.set(key, {
            v: value,
            t: Date.now()
        });
        return value;
    })();

    pendingMap.set(key, task);

    return task.finally(function() {
        pendingMap.delete(key);
    });
}

async function fetchTmdbShow(tmdbId) {
    if (!tmdbId) return null;

    return cachedLoad(
        tmdbShowCache,
        "tmdb:show:" + tmdbId,
        async function() {
            var data = await Widget.tmdb.get(
                "/tv/" + encodeURIComponent(tmdbId),
                {
                    params: {
                        language: "zh-CN"
                    },
                    timeout: TIMEOUT_TMDB
                }
            );

            if (!data || typeof data !== "object") {
                throw new Error("TMDB 剧集详情为空");
            }

            return data;
        },
        24 * 3600 * 1000
    );
}

async function fetchTmdbSeason(tmdbId, season) {
    if (!tmdbId || season <= 0) return null;

    return cachedLoad(
        tmdbSeasonCache,
        "tmdb:season:" + tmdbId + ":" + season,
        async function() {
            var data = await Widget.tmdb.get(
                "/tv/" +
                encodeURIComponent(tmdbId) +
                "/season/" +
                encodeURIComponent(season),
                {
                    params: {
                        language: "zh-CN"
                    },
                    timeout: TIMEOUT_TMDB
                }
            );

            if (!data || typeof data !== "object") {
                throw new Error("TMDB 季详情为空");
            }

            return data;
        },
        6 * 3600 * 1000
    );
}

/* ==================== 官方 Continue Watching ==================== */

async function fetchOfficialContinueWatching(accessToken, page, pageSize) {
    var path =
        "/sync/progress/up_next" +
        "?page=" + encodeURIComponent(page) +
        "&limit=" + encodeURIComponent(pageSize) +
        "&extended=full";

    var data = await traktRequest(path, accessToken, true);

    return toArray(data);
}

/* ==================== 官方条目解析 ==================== */

function getShowFromUpNext(item) {
    if (item && item.show) return item.show;
    if (item && item.media_type === "show" && item.media) return item.media;
    return {};
}

function getEpisodeFromUpNext(item) {
    if (item && item.episode) return item.episode;

    if (
        item &&
        item.progress &&
        item.progress.next_episode
    ) {
        return item.progress.next_episode;
    }

    if (item && item.next_episode) return item.next_episode;

    return {};
}

function getProgressFromUpNext(item) {
    if (item && item.progress) return item.progress;
    return {};
}

function getTraktShowId(show) {
    return (
        show &&
        show.ids &&
        (
            show.ids.trakt ||
            show.ids.tmdb ||
            show.ids.slug
        )
    ) || "";
}

function getTmdbId(show) {
    return toNumber(
        show &&
        show.ids &&
        show.ids.tmdb
    );
}

function getEpisodeSeason(episode) {
    return toNumber(
        episode &&
        (
            episode.season ||
            episode.season_number
        )
    );
}

function getEpisodeNumber(episode) {
    return toNumber(
        episode &&
        (
            episode.number ||
            episode.episode_number
        )
    );
}

/* ==================== MediaItem 构建 ==================== */

function buildMediaItem(item, tmdbShow, tmdbSeason) {
    var show = getShowFromUpNext(item);
    var episode = getEpisodeFromUpNext(item);
    var progress = getProgressFromUpNext(item);

    var tmdbId = getTmdbId(show);
    var season = getEpisodeSeason(episode);
    var episodeNumber = getEpisodeNumber(episode);

    if (season <= 0 || episodeNumber <= 0) {
        return null;
    }

    var title =
        (tmdbShow && (
            tmdbShow.name ||
            tmdbShow.original_name
        )) ||
        show.title ||
        "未知剧集";

    var year =
        show.year ||
        String(
            tmdbShow && tmdbShow.first_air_date || ""
        ).slice(0, 4);

    var media = {
        id: "trakt-up-next." + (
            getTraktShowId(show) ||
            tmdbId ||
            title
        ),
        type: "tmdb",          // 严格显式指定条目类型为 tmdb
        mediaType: "tv",       // 媒体内容类型为剧集
        title: title,
        year: String(year || ""),
        currentSeason: season,
        currentEpisode: episodeNumber,
        description:
            "▶️ " +
            formatSE(season, episodeNumber) +
            (
                episode.title
                    ? " · " + episode.title
                    : ""
            )
    };

    if (tmdbId) {
        media.tmdbId = tmdbId;
    }

    if (episode.ids && episode.ids.tmdb) {
        media.currentEpisodeId = String(episode.ids.tmdb);
    } else if (tmdbSeason && tmdbSeason.episodes) {
        var tmdbEpisode = toArray(tmdbSeason.episodes).find(
            function(ep) {
                return toNumber(ep.episode_number) === episodeNumber;
            }
        );

        if (tmdbEpisode && tmdbEpisode.id) {
            media.currentEpisodeId = String(tmdbEpisode.id);
        }
    }

    if (tmdbSeason && tmdbSeason.id) {
        media.currentSeasonId = String(tmdbSeason.id);
    }

    if (tmdbShow && tmdbShow.poster_path) {
        media.posterUrl = TMDB_POSTER + tmdbShow.poster_path;
    }

    if (tmdbShow && tmdbShow.backdrop_path) {
        media.backdropUrl = TMDB_BACKDROP + tmdbShow.backdrop_path;
    }

    var rating = toNumber(tmdbShow && tmdbShow.vote_average);
    if (rating > 0) {
        media.rating = rating;
    }

    var genres = toArray(tmdbShow && tmdbShow.genres).map(function(genre) {
        return genre && genre.name;
    }).filter(Boolean);

    if (genres.length) {
        media.genres = genres;
    }

    var completed = toNumber(progress.completed);
    var aired = toNumber(progress.aired);

    if (aired > 0 && completed >= 0) {
        var percent = Math.min(100, Math.max(0, completed / aired * 100));
        media.description +=
            " · 进度 " +
            Math.round(percent * 10) / 10 +
            "%（" +
            completed +
            "/" +
            aired +
            "）";
    }

    return media;
}

/* ==================== 并发工具 ==================== */

async function mapWithConcurrency(items, concurrency, worker) {
    var list = toArray(items);

    if (!list.length) {
        return [];
    }

    var results = new Array(list.length);
    var cursor = 0;
    var count = Math.min(
        Math.max(1, concurrency || 1),
        list.length
    );

    await Promise.all(
        Array.from(
            { length: count },
            async function() {
                while (cursor < list.length) {
                    var index = cursor++;
                    try {
                        results[index] = await worker(list[index], index);
                    } catch (error) {
                        console.error("处理 Trakt 条目失败:", error);
                        results[index] = null;
                    }
                }
            }
        )
    );

    return results;
}

/* ==================== 主函数 ==================== */

async function loadContinueWatching(params) {
    params = params || {};

    var accessToken = getAccessToken(params);
    var paging = getPaging(params);

    if (!accessToken) {
        console.error("Trakt Continue Watching 需要 OAuth Access Token");
        return [];
    }

    try {
        var officialItems = await fetchOfficialContinueWatching(
            accessToken,
            paging.page,
            paging.pageSize
        );

        if (!officialItems.length) {
            return [];
        }

        var result = await mapWithConcurrency(
            officialItems,
            5,
            async function(item) {
                var show = getShowFromUpNext(item);
                var tmdbId = getTmdbId(show);

                var tmdbShow = null;
                var tmdbSeason = null;

                if (tmdbId) {
                    try {
                        tmdbShow = await fetchTmdbShow(tmdbId);
                    } catch (error) {
                        console.error("TMDB 剧集信息读取失败:", error);
                    }
                }

                var episode = getEpisodeFromUpNext(item);
                var season = getEpisodeSeason(episode);

                if (tmdbId && season > 0) {
                    try {
                        tmdbSeason = await fetchTmdbSeason(tmdbId, season);
                    } catch (error) {
                        console.error("TMDB 季信息读取失败:", error);
                    }
                }

                return buildMediaItem(item, tmdbShow, tmdbSeason);
            }
        );

        return result.filter(Boolean);
    } catch (error) {
        console.error("Trakt 官方 Continue Watching 加载失败:", error);
        return [];
    }
}
