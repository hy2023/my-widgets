from pathlib import Path
import textwrap

code = r'''/*
 * CapyPlayer Widget - Trakt 官方 Continue Watching
 * v2.0.0
 *
 * 核心逻辑：
 *   Trakt /sync/progress/up_next
 *       ↓
 *   Trakt 官方计算的“下一集”
 *       ↓
 *   TMDB 补充海报 / 背景 / 季集 ID
 *       ↓
 *   输出 CapyPlayer MediaItem[]
 *
 * 重要：
 *   本版本不再使用：
 *     - /users/{user}/watched/shows
 *     - /users/{user}/history/shows
 *     - 本地最高观看集数推断
 *     - /shows/{id}/next_episode 作为继续观看判定
 *     - 自定义 recentDays 过滤
 *
 *   继续观看的候选与下一集判定完全交给 Trakt：
 *     GET /sync/progress/up_next
 *
 *   该接口属于用户同步/进度接口，需要 Trakt OAuth Access Token。
 */

var WidgetMetadata = {
    id: "trakt_continue_username",
    title: "Trakt片单",
    author: "Holyn",
    description: "使用 Trakt 官方 Continue Watching / Up Next 数据生成继续观看列表。",
    version: "2.0.0",
    requiredVersion: "0.0.4",

    globalParams: [
        {
            name: "traktUser",
            title: "Trakt 用户名（仅显示/兼容）",
            type: "string",
            value: ""
        },
        {
            name: "traktAccessToken",
            title: "Trakt Access Token",
            type: "string",
            value: ""
        }
    ],

    modules: [
        {
            title: "继续观看",
            functionName: "loadContinueWatching",
            type: "media_list",
            cacheDuration: 300,
            params: [
                {
                    name: "page",
                    title: "页码",
                    type: "page"
                },
                {
                    name: "pageSize",
                    title: "每页数量",
                    type: "enum",
                    value: "15",
                    enumOptions: [
                        { title: "10", value: "10" },
                        { title: "15", value: "15" },
                        { title: "20", value: "20" },
                        { title: "30", value: "30" }
                    ]
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

function safeTime(value) {
    var time = new Date(value || 0).getTime();
    return Number.isNaN(time) ? 0 : time;
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
    var rawSize = parseInt(params && params.pageSize || 15, 10) || 15;

    return {
        page: Math.max(1, rawPage),
        pageSize: Math.min(MAX_PAGE_SIZE, Math.max(1, rawSize))
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

/*
 * Trakt 官方接口：
 *
 * GET /sync/progress/up_next
 *
 * 该接口直接返回用户应该继续观看的剧集/下一集，
 * 不再由本组件根据 watched/history 自行推算。
 *
 * page / limit / sort_by / sort_how 均交给 Trakt。
 */
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

    /*
     * 兼容部分 API 返回结构：
     * progress.next_episode
     */
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

/* ==================== MediaItem ==================== */

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
        mediaType: "tv",
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
        media.currentEpisodeId = String(
            episode.ids.tmdb
        );
    } else if (tmdbSeason && tmdbSeason.episodes) {
        var tmdbEpisode = toArray(tmdbSeason.episodes).find(
            function(ep) {
                return toNumber(ep.episode_number) === episodeNumber;
            }
        );

        if (tmdbEpisode && tmdbEpisode.id) {
            media.currentEpisodeId = String(
                tmdbEpisode.id
            );
        }
    }

    if (tmdbSeason && tmdbSeason.id) {
        media.currentSeasonId = String(
            tmdbSeason.id
        );
    }

    if (tmdbShow && tmdbShow.poster_path) {
        media.posterUrl =
            TMDB_POSTER + tmdbShow.poster_path;
    }

    if (tmdbShow && tmdbShow.backdrop_path) {
        media.backdropUrl =
            TMDB_BACKDROP + tmdbShow.backdrop_path;
    }

    var rating = toNumber(
        tmdbShow && tmdbShow.vote_average
    );

    if (rating > 0) {
        media.rating = rating;
    }

    var genres = toArray(
        tmdbShow && tmdbShow.genres
    ).map(function(genre) {
        return genre && genre.name;
    }).filter(Boolean);

    if (genres.length) {
        media.genres = genres;
    }

    /*
     * 保留 Trakt 官方 progress 信息，
     * 但不参与“下一集”判定。
     */
    var completed = toNumber(progress.completed);
    var aired = toNumber(progress.aired);

    if (aired > 0 && completed >= 0) {
        var percent = Math.min(
            100,
            Math.max(
                0,
                completed / aired * 100
            )
        );

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

/* ==================== 并发 ==================== */

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
                        results[index] =
                            await worker(list[index], index);
                    } catch (error) {
                        console.error(
                            "处理 Trakt 条目失败:",
                            error
                        );
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
    var user = getUser(params);
    var paging = getPaging(params);

    if (!accessToken) {
        console.error(
            "Trakt Continue Watching 需要 OAuth Access Token"
        );
        return [];
    }

    try {
        /*
         * 关键：
         * 这里不读取 History，也不计算最高观看集数。
         * 列表本身直接来自 Trakt 官方 Up Next。
         */
        var officialItems =
            await fetchOfficialContinueWatching(
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
                        tmdbShow =
                            await fetchTmdbShow(tmdbId);
                    } catch (error) {
                        console.error(
                            "TMDB 剧集信息读取失败:",
                            error
                        );
                    }
                }

                var episode =
                    getEpisodeFromUpNext(item);
                var season =
                    getEpisodeSeason(episode);

                if (tmdbId && season > 0) {
                    try {
                        tmdbSeason =
                            await fetchTmdbSeason(
                                tmdbId,
                                season
                            );
                    } catch (error) {
                        console.error(
                            "TMDB 季信息读取失败:",
                            error
                        );
                    }
                }

                return buildMediaItem(
                    item,
                    tmdbShow,
                    tmdbSeason
                );
            }
        );

        return result.filter(Boolean);
    } catch (error) {
        console.error(
            "Trakt 官方 Continue Watching 加载失败:",
            error
        );
        return [];
    }
}
'''

path = Path("/mnt/data/Trakt片单_官方ContinueWatching版.js")
path.write_text(code, encoding="utf-8")
print(f"已生成：{path}")
print(f"行数：{len(code.splitlines())}")
