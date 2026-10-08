/*
 * CapyPlayer Widget - Trakt片单
 * v2.0.0
 *
 * 核心逻辑：
 *   1. 读取 Trakt watched/shows?extended=progress
 *   2. 从 watched progress 找到每部剧最高已观看 S/E
 *   3. 用 item.last_watched_at 作为该剧最近观看时间
 *   4. 自动推断下一集：Trakt 当前季 → Trakt next_episode → TMDB 当前季 → TMDB 下一季
 *   5. 生成 CapyPlayer MediaItem
 *
 * 说明：
 *   recentDays 仍用于筛选最近观看的剧；
 */

var WidgetMetadata = {
    id: "trakt_continue_username",
    title: "Trakt片单",
    author: "Holyn",
    description: "同步 Trakt 观看进度，自动推断下一集并生成继续观看列表。",
    version: "2.0.0",
    requiredVersion: "0.0.4",

    globalParams: [
        { name: "traktUser", title: "Trakt 用户名", type: "input", value: "" }
    ],

    modules: [
        {
            title: "继续观看",
            functionName: "loadContinueWatching",
            type: "media_list",
            cacheDuration: 300,
            params: [
                { name: "page", title: "页码", type: "page" },
                {
                    name: "pageSize",
                    title: "每页数量",
                    type: "enumeration",
                    value: "15",
                    enumOptions: [
                        { title: "10", value: "10" },
                        { title: "15", value: "15" },
                        { title: "20", value: "20" }
                    ]
                },
                {
                    name: "recentDays",
                    title: "筛选范围",
                    type: "enumeration",
                    value: "60",
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

const TRAKT_CLIENT_ID =
    "95b59922670c84040db3632c7aac6f33704f6ffe5cbf3113a056e37cb45cb482";

const TRAKT_BASE = "https://api.trakt.tv";
const TMDB_POSTER = "https://image.tmdb.org/t/p/w500";
const TMDB_BACKDROP = "https://image.tmdb.org/t/p/w780";

const TRAKT_PAGE_LIMIT = 100;
const TRAKT_MAX_PAGES = 20;
const MAX_CONCURRENCY = 5;
const MAX_PAGE_SIZE = 50;

const HIDE_AFTER_DAYS = 60;

const TIMEOUT_TRAKT = 25000;
const TIMEOUT_TMDB = 25000;
const MAX_RETRY = 2;
const RETRY_DELAY_MS = 800;

const TTL_TMDB_SHOW = 24 * 3600 * 1000;
const TTL_TMDB_SEASON = 6 * 3600 * 1000;
const TTL_TRAKT_SEASON = 6 * 3600 * 1000;
const TTL_TRAKT_NEXT = 1 * 3600 * 1000;

/* ==================== 工具 ==================== */

const toArray = value => Array.isArray(value) ? value : [];

function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

const pad2 = value => String(toNumber(value)).padStart(2, "0");
const formatSE = (season, episode) => `S${pad2(season)}E${pad2(episode)}`;

function safeTime(value) {
    const time = new Date(value || 0).getTime();
    return Number.isNaN(time) ? 0 : time;
}

function formatPercent(value) {
    const n = Math.round(toNumber(value) * 10) / 10;
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

const getUser = params => String(params?.traktUser || "").trim();

function getPaging(params) {
    const rawPage = parseInt(params?.page || 1, 10) || 1;
    const rawSize = parseInt(params?.pageSize || 15, 10) || 15;

    return {
        page: Math.max(1, rawPage),
        pageSize: Math.min(MAX_PAGE_SIZE, Math.max(1, rawSize))
    };
}

function getRecentDays(params) {
    const raw = params?.recentDays;

    if (raw === undefined || raw === null || raw === "") {
        return HIDE_AFTER_DAYS;
    }

    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : HIDE_AFTER_DAYS;
}

/* ==================== 缓存 ==================== */

const CACHE_PREFIX = "traktList.v2:";

const tmdbShowCache = new Map();
const tmdbSeasonCache = new Map();
const traktSeasonCache = new Map();
const traktNextCache = new Map();

const pendingMap = new Map();

async function storageGet(key) {
    try {
        if (!Widget.storage || typeof Widget.storage.get !== "function") {
            return null;
        }

        const value = await Widget.storage.get(key);
        if (value == null) return null;

        return typeof value === "string" ? JSON.parse(value) : value;
    } catch {
        return null;
    }
}

async function storageSet(key, value) {
    try {
        if (!Widget.storage || typeof Widget.storage.set !== "function") {
            return;
        }

        await Widget.storage.set(key, value);
    } catch {}
}

async function cachedLoad(cache, key, loader, ttlMs = 0) {
    const now = Date.now();
    const memory = cache.get(key);

    if (memory && (!ttlMs || now - memory.t < ttlMs)) {
        return memory.v;
    }

    if (pendingMap.has(key)) {
        return pendingMap.get(key);
    }

    const task = (async () => {
        const persisted = await storageGet(CACHE_PREFIX + key);

        if (
            persisted &&
            persisted.v !== undefined &&
            (!ttlMs || Date.now() - persisted.t < ttlMs)
        ) {
            cache.set(key, persisted);
            return persisted.v;
        }

        const value = await loader();
        const entry = {
            v: value,
            t: Date.now()
        };

        cache.set(key, entry);
        storageSet(CACHE_PREFIX + key, entry);

        return value;
    })();

    pendingMap.set(key, task);

    try {
        return await task;
    } finally {
        pendingMap.delete(key);
    }
}

/* ==================== 日期 ==================== */

function getDisplayDate(value) {
    if (!value) return "";

    if (typeof value === "string") {
        const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})$/);
        if (match) return match[1];
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";

    try {
        return new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Shanghai",
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }).format(date);
    } catch {}

    const shifted = new Date(date.getTime() + 8 * 3600000);

    return [
        shifted.getUTCFullYear(),
        pad2(shifted.getUTCMonth() + 1),
        pad2(shifted.getUTCDate())
    ].join("-");
}

const today = () => getDisplayDate(new Date());

function hasAired(value) {
    if (!value) return false;

    const day = getDisplayDate(String(value).slice(0, 10));
    return !!day && day <= today();
}

/* ==================== Trakt ==================== */

const getTraktShowId = show =>
    show?.ids?.trakt || show?.ids?.slug || "";

function getTraktHeaders() {
    return {
        "Content-Type": "application/json",
        "trakt-api-version": "2",
        "trakt-api-key": TRAKT_CLIENT_ID
    };
}

async function traktRequest(path, strict = false) {
    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
        try {
            const response = await Widget.http.get(TRAKT_BASE + path, {
                headers: getTraktHeaders(),
                timeout: TIMEOUT_TRAKT
            });

            if (!response) {
                lastError = new Error("Trakt 返回为空");
            } else if (response.ok === false) {
                lastError = new Error(
                    `Trakt HTTP ${response.status || "unknown"}`
                );
            } else {
                const data = Array.isArray(response)
                    ? response
                    : response?.data !== undefined
                        ? response.data
                        : response;

                if (typeof data !== "string") {
                    return data;
                }

                if (!data.trim()) return null;

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
            console.warn(
                `Trakt 请求失败，${RETRY_DELAY_MS}ms 后重试 ` +
                `(${attempt + 1}/${MAX_RETRY})：${path}`
            );

            await new Promise(resolve =>
                setTimeout(resolve, RETRY_DELAY_MS)
            );
        }
    }

    if (strict) {
        throw lastError || new Error("Trakt 请求失败");
    }

    return null;
}

async function fetchAllTraktPages(pathBuilder) {
    const all = [];

    for (let page = 1; page <= TRAKT_MAX_PAGES; page++) {
        const data = await traktRequest(
            pathBuilder(page),
            page === 1
        );

        if (data == null) {
            if (page > 1) {
                console.warn(`Trakt 第 ${page} 页为空，提前结束`);
            }
            break;
        }

        const rows = toArray(data);
        if (!rows.length) break;

        all.push(...rows);

        if (rows.length < TRAKT_PAGE_LIMIT) {
            break;
        }
    }

    return all;
}

/*
 * 核心数据源：
 * 一次读取 watched/shows + progress。
 *
 * 不再针对每部剧调用：
 * /users/{user}/history/shows/{showId}
 *
 * watched progress 已用于计算最高已观看集；
 * item.last_watched_at 用于该剧的最近观看时间和排序。
 */
const fetchWatchedShows = user =>
    fetchAllTraktPages(page =>
        `/users/${encodeURIComponent(user)}/watched/shows` +
        `?extended=progress&page=${page}&limit=${TRAKT_PAGE_LIMIT}`
    );

async function fetchTraktSeason(show, season) {
    const id = getTraktShowId(show);
    if (!id || season <= 0) return [];

    const key = `trakt:season:${id}:${season}`;

    try {
        return await cachedLoad(
            traktSeasonCache,
            key,
            async () => {
                const data = await traktRequest(
                    `/shows/${encodeURIComponent(id)}/seasons/${season}?extended=full`
                );

                return Array.isArray(data)
                    ? data
                    : toArray(data?.episodes);
            },
            TTL_TRAKT_SEASON
        );
    } catch {
        return [];
    }
}

async function fetchTraktNext(show) {
    const id = getTraktShowId(show);
    if (!id) return null;

    try {
        return await cachedLoad(
            traktNextCache,
            `trakt:next:${id}`,
            async () => {
                const data = await traktRequest(
                    `/shows/${encodeURIComponent(id)}/next_episode?extended=full`
                );

                const season = toNumber(data?.season);
                const episode = toNumber(data?.number);

                if (season <= 0 || episode <= 0) {
                    return null;
                }

                return {
                    season,
                    episode,
                    firstAired:
                        data?.first_aired ||
                        data?.effective_release_date ||
                        null
                };
            },
            TTL_TRAKT_NEXT
        );
    } catch {
        return null;
    }
}

function isTraktEpisodeAired(episode) {
    const airedAt =
        episode?.first_aired ||
        episode?.effective_release_date;

    return airedAt ? hasAired(airedAt) : false;
}

/* ==================== TMDB ==================== */

function unpackResponse(response) {
    if (response == null) return null;

    const raw =
        response?.data !== undefined
            ? response.data
            : response;

    if (typeof raw !== "string") {
        return raw || null;
    }

    if (!raw.trim()) return null;

    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function fetchTmdbShow(id) {
    return await cachedLoad(
        tmdbShowCache,
        `tmdb:tv:${id}`,
        async () => {
            const data = unpackResponse(
                await Widget.tmdb.get(`/tv/${id}`, {
                    params: { language: "zh-CN" },
                    timeout: TIMEOUT_TMDB
                })
            );

            if (!data || typeof data !== "object") {
                throw new Error("TMDB 剧集详情为空");
            }

            return data;
        },
        TTL_TMDB_SHOW
    );
}

async function fetchTmdbSeason(id, season) {
    return await cachedLoad(
        tmdbSeasonCache,
        `tmdb:tv:${id}:season:${season}`,
        async () => {
            const data = unpackResponse(
                await Widget.tmdb.get(`/tv/${id}/season/${season}`, {
                    params: { language: "zh-CN" },
                    timeout: TIMEOUT_TMDB
                })
            );

            if (!data || typeof data !== "object") {
                throw new Error("TMDB 季详情为空");
            }

            return data;
        },
        TTL_TMDB_SEASON
    );
}

async function loadTmdbShow(tmdbId) {
    if (!tmdbId) {
        return {
            tmdbShow: null,
            failed: false
        };
    }

    try {
        return {
            tmdbShow: await fetchTmdbShow(tmdbId),
            failed: false
        };
    } catch (error) {
        console.warn("TMDB 剧集详情读取失败:", error?.message || error);
        return {
            tmdbShow: null,
            failed: true
        };
    }
}

/* ==================== 观看进度 ==================== */

/*
 * 从 Trakt watched/shows 的 progress 数据直接计算：
 *   count = 已观看集数
 *   last  = 最高已观看 S/E
 *   lastWatchedAt = 该剧最近一次观看时间
 *
 * 这里的 last 是“最高集数”，不是“最近一次观看的具体集”。
 * 对继续观看而言，最高 S/E 才适合推断下一集。
 */
function getWatchStats(item) {
    let count = 0;
    let last = null;

    for (const season of toArray(item?.seasons)) {
        const seasonNumber = toNumber(season?.number);
        if (seasonNumber <= 0) continue;

        for (const episode of toArray(season?.episodes)) {
            if (toNumber(episode?.plays) <= 0) continue;

            count++;

            const episodeNumber = toNumber(episode?.number);
            if (episodeNumber <= 0) continue;

            if (
                !last ||
                seasonNumber > last.season ||
                (
                    seasonNumber === last.season &&
                    episodeNumber > last.episode
                )
            ) {
                last = {
                    season: seasonNumber,
                    episode: episodeNumber
                };
            }
        }
    }

    return {
        count,
        last,
        lastWatchedAt: item?.last_watched_at || null
    };
}

function getAiredCount(show, tmdbShow) {
    return (
        toNumber(show?.aired_episodes) ||
        toNumber(tmdbShow?.number_of_episodes)
    );
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
    tmdbFailed
) {
    if (!last) {
        return { status: "none" };
    }

    const targetEpisode = last.episode + 1;

    /*
     * 1. Trakt 当前季
     *
     * 如果当前季明确存在下一集：
     *   已播 → 直接继续
     *   未播 → 不显示，避免提前进入未来集
     */
    const currentSeason = await fetchTraktSeason(
        show,
        last.season
    );

    const nextInCurrentSeason = currentSeason.find(
        episode =>
            toNumber(episode?.number) === targetEpisode
    );

    if (nextInCurrentSeason) {
        return isTraktEpisodeAired(nextInCurrentSeason)
            ? nextResult(last.season, targetEpisode)
            : { status: "none" };
    }

    /*
     * 2. Trakt next_episode
     *
     * 当前季找不到时，直接使用 Trakt 的下一集结果。
     */
    const traktNext = await fetchTraktNext(show);

    if (traktNext) {
        if (!traktNext.firstAired || hasAired(traktNext.firstAired)) {
            return nextResult(
                traktNext.season,
                traktNext.episode
            );
        }

        return { status: "none" };
    }

    if (!tmdbId || tmdbFailed) {
        return { status: "lookup_failed" };
    }

    /*
     * 3. TMDB 当前季
     */
    try {
        const seasonData = await fetchTmdbSeason(
            tmdbId,
            last.season
        );

        const nextOnTmdb = toArray(seasonData?.episodes).find(
            episode =>
                toNumber(episode?.episode_number) === targetEpisode
        );

        if (nextOnTmdb) {
            return hasAired(nextOnTmdb?.air_date)
                ? nextResult(last.season, targetEpisode)
                : { status: "none" };
        }

        /*
         * 4. TMDB 下一季
         *
         * 当前季没有下一集时，检查下一季第 1 集。
         */
        const nextSeason = last.season + 1;

        const hasNextSeason = toArray(tmdbShow?.seasons).some(
            season =>
                toNumber(season?.season_number) === nextSeason &&
                toNumber(season?.episode_count) > 0
        );

        if (!hasNextSeason) {
            return { status: "none" };
        }

        const nextSeasonData = await fetchTmdbSeason(
            tmdbId,
            nextSeason
        );

        const firstEpisode = toArray(
            nextSeasonData?.episodes
        ).find(
            episode =>
                toNumber(episode?.episode_number) === 1
        );

        if (!firstEpisode) {
            return { status: "none" };
        }

        return hasAired(firstEpisode?.air_date)
            ? nextResult(nextSeason, 1)
            : { status: "none" };
    } catch {
        return { status: "lookup_failed" };
    }
}

/* ==================== MediaItem ==================== */

function makeShowMeta(show, tmdbShow) {
    return {
        title:
            tmdbShow?.name ||
            show?.title ||
            tmdbShow?.original_name ||
            "未知剧集",

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
    count,
    aired
}) {
    /*
     * type=tmdb 时必须优先使用稳定的 TMDB ID。
     * 没有 TMDB ID 的剧不进入最终列表，避免生成无法正确定位的条目。
     */
    if (!tmdbId) return null;

    const progress =
        aired > 0
            ? `${formatPercent(
                Math.min(100, Math.max(0, count / aired * 100))
            )}%（${count}/${aired}）`
            : `${count} 集`;

    const media = {
        id: `tv.${tmdbId}`,
        type: "tmdb",
        mediaType: "tv",
        title,
        year,
        tmdbId,
        description:
            `▶️ ${formatSE(season, episode)} · 进度 ${progress}`,

        currentSeason: season,
        currentEpisode: episode
    };

    if (tmdbShow?.poster_path) {
        media.posterPath =
            TMDB_POSTER + tmdbShow.poster_path;
    }

    if (tmdbShow?.backdrop_path) {
        media.backdropPath =
            TMDB_BACKDROP + tmdbShow.backdrop_path;
    }

    return media;
}

/* ==================== 并发 ==================== */

async function mapWithConcurrency(
    items,
    concurrency,
    worker
) {
    const list = toArray(items);
    if (!list.length) return [];

    const results = new Array(list.length);
    let cursor = 0;

    const workerCount = Math.min(
        Math.max(1, concurrency || 1),
        list.length
    );

    await Promise.all(
        Array.from(
            { length: workerCount },
            async () => {
                while (cursor < list.length) {
                    const index = cursor++;

                    try {
                        results[index] =
                            await worker(list[index], index);
                    } catch {
                        results[index] = null;
                    }
                }
            }
        )
    );

    return results;
}

/* ==================== 最近观看筛选 ==================== */

function isRecentContinueItem(
    item,
    days = HIDE_AFTER_DAYS
) {
    const watchedAt =
        safeTime(item?.last_watched_at);

    if (watchedAt <= 0) return false;

    if (!days || days <= 0) return true;

    return (
        Date.now() - watchedAt <=
        days * 86400000
    );
}

/* ==================== 构建继续观看条目 ==================== */

async function buildContinueItem(item, stats) {
    const show = item?.show || {};

    const tmdbId =
        toNumber(show?.ids?.tmdb) || null;

    /*
     * 当前 MediaItem 使用 TMDB 类型。
     * 没有 TMDB ID 时不生成伪 tmdb 条目。
     */
    if (!tmdbId || !stats?.last) {
        return null;
    }

    const {
        tmdbShow,
        failed: tmdbFailed
    } = await loadTmdbShow(tmdbId);

    const result = await inferNextEpisode(
        stats.last,
        tmdbId,
        tmdbShow,
        show,
        tmdbFailed
    );

    if (result.status !== "next") {
        return null;
    }

    const season =
        toNumber(result.next?.season);

    const episode =
        toNumber(result.next?.episode);

    if (season <= 0 || episode <= 0) {
        return null;
    }

    const meta =
        makeShowMeta(show, tmdbShow);

    const aired =
        getAiredCount(show, tmdbShow);

    const media =
        makeMedia({
            show,
            tmdbId,
            tmdbShow,
            title: meta.title,
            year: meta.year,
            season,
            episode,
            count: stats.count,
            aired
        });

    if (!media) return null;

    return {
        media,
        show,
        tmdbShow,
        tmdbId,
        season,
        episode,
        lastWatchedAt:
            stats.lastWatchedAt
    };
}

/* ==================== TMDB 播放定位 ==================== */

async function attachEpisodeIds(data) {
    const media = data?.media;
    const tmdbId = data?.tmdbId;

    if (!media || !tmdbId) {
        return media || null;
    }

    const season =
        toNumber(media.currentSeason);

    const episode =
        toNumber(media.currentEpisode);

    if (season <= 0 || episode <= 0) {
        return media;
    }

    try {
        const seasonData =
            await fetchTmdbSeason(
                tmdbId,
                season
            );

        const seasonId =
            toNumber(seasonData?.id);

        if (seasonId > 0) {
            media.currentSeasonId =
                String(seasonId);
        }

        const targetEpisode =
            toArray(seasonData?.episodes).find(
                item =>
                    toNumber(item?.episode_number) ===
                    episode
            );

        const episodeId =
            toNumber(targetEpisode?.id);

        if (episodeId > 0) {
            media.currentEpisodeId =
                String(episodeId);
        }
    } catch (error) {
        /*
         * ID 同步失败不影响继续观看条目本身。
         */
        console.warn(
            "TMDB 季/集 ID 获取失败:",
            error?.message || error
        );
    }

    return media;
}

/* ==================== 主入口 ==================== */

async function loadContinueWatching(params = {}) {
    const user = getUser(params);

    const {
        page,
        pageSize
    } = getPaging(params);

    const recentDays =
        getRecentDays(params);

    if (!user) {
        console.error(
            "Trakt片单：未设置 Trakt 用户名"
        );
        return [];
    }

    try {
        const watched =
            await fetchWatchedShows(user);

        if (!watched.length) {
            console.warn(
                "Trakt片单：没有读取到观看记录"
            );
            return [];
        }

        /*
         * 先按 show 最近观看时间排序，
         * 再进行下一集推断。
         */
        watched.sort(
            (a, b) =>
                safeTime(b?.last_watched_at) -
                safeTime(a?.last_watched_at)
        );

        const candidates =
            watched
                .map(item => ({
                    item,
                    stats:
                        getWatchStats(item)
                }))
                .filter(
                    ({ item, stats }) =>
                        stats.count > 0 &&
                        !!stats.last &&
                        isRecentContinueItem(
                            item,
                            recentDays
                        )
                );

        const checked =
            await mapWithConcurrency(
                candidates,
                MAX_CONCURRENCY,
                async ({ item, stats }) => {
                    try {
                        return await buildContinueItem(
                            item,
                            stats
                        );
                    } catch (error) {
                        console.warn(
                            "继续观看条目处理失败:",
                            error?.message || error
                        );
                        return null;
                    }
                }
            );

        /*
         * 保持最近观看顺序。
         * 不再增加“最近播出”这一层排序。
         */
        const available =
            checked
                .filter(Boolean)
                .sort(
                    (a, b) =>
                        safeTime(
                            b.lastWatchedAt
                        ) -
                        safeTime(
                            a.lastWatchedAt
                        )
                );

        const start =
            (page - 1) * pageSize;

        const pageItems =
            available.slice(
                start,
                start + pageSize
            );

        if (!pageItems.length) {
            return [];
        }

        return await mapWithConcurrency(
            pageItems,
            MAX_CONCURRENCY,
            async data => {
                try {
                    return await attachEpisodeIds(
                        data
                    );
                } catch {
                    return data?.media || null;
                }
            }
        );
    } catch (error) {
        console.error(
            "Trakt片单加载失败:",
            error?.message || error
        );
        return [];
    }
}
