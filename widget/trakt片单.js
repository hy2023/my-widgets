/*
 * CapyPlayer Widget - trakt片单
 * v1.3.0
 *
 * 模块：继续观看
 *
 * 符号：继续观看 ▶️   完结统一用 🏁
 *
 * 预告获取（4 级兜底）：
 *   1) Trakt 当前季未来集
 *   2) Trakt next_episode
 *   3) TMDB next_episode_to_air
 *   4) TMDB 当前季未来集
 *
 * 完结判断（Trakt 首选）：
 *   - 本季播完 + 有下一季 → 🏁 本季已完结
 *   - 本季播完 + 无下一季 → 🏁 全剧已完结
 *
 * 类型：把 TMDB genres 塞进 media.genres / tags / genre
 *
 * 用 TMDB currentSeasonId / currentEpisodeId 覆盖 App 内部播放记录
 *
 * 观看时间范围（recentDays）：60 / 180 / 365 / 不限
 *
 * ------------------------------------------------------------------
 * v1.3.0 优化摘要（对照指南）
 *   [优化-1] Widget.tmdb.get / Widget.http.get 使用内置 timeout
 *   [优化-2] 慢变数据（TMDB 详情 / 季 / Trakt 评分 / 历史）接入
 *            Widget.storage 持久化缓存（自动降级为内存缓存）
 *   [优化-3] getPaging 增加 pageSize 上限，防止一次抓取过多
 *   [优化-4] isSingleSeason 由 <=1 改为 ===1，避免 TMDB 缺数据时
 *            被误判为单季导致完结判断错误
 *   [优化-5] 条目 id 不再用中文 title 兜底，改走 trakt/slug/tmdb
 *   [优化-6] 移除自建 withSoftTimeout，统一走内置 timeout
 *   [优化-7] 缓存并发合并（pending 表），避免同 key 多次请求
 *   [优化-8] requiredVersion 提升为 0.0.4（依据使用到的 API 面）
 * ------------------------------------------------------------------
 *
 * 发布检查清单核对：
 *   [x] 顶层 var WidgetMetadata
 *   [x] functionName 可定位全局函数 loadContinueWatching
 *   [x] 每条目有字符串 id + title
 *   [x] 无 link 条目，不需要 loadDetail
 *   [x] functionName 仅标识符路径
 *   [x] 仅使用 Widget.http / Widget.tmdb / Widget.storage / console
 *   [x] 空结果返回 []（首页为空时返回提示条，见 noticeItem 注释）
 * ------------------------------------------------------------------
 */

var WidgetMetadata = {
    id: "trakt_continue_username",
    title: "Trakt片单",
    author: "Blue",
    description: "同步 Trakt 观看记录，自动推断下一集并生成继续观看列表。",
    version: "1.3.0",
    // [优化-8] 依据本组件使用的 API 面（Widget.tmdb / Widget.http / Widget.storage）
    // 设定最低版本；如实际最低版本更早，请在此下调。
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
                    title: "时间范围",
                    type: "enumeration",
                    value: "60",
                    enumOptions: [
                        { title: "最近 60 天",  value: "60"  },
                        { title: "最近 180 天", value: "180" },
                        { title: "最近 365 天", value: "365" },
                        { title: "不限时间",    value: "0"   }
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

// [优化-3] pageSize 硬上限，防止一次拉取过多剧集导致请求风暴
const MAX_PAGE_SIZE = 50;

const HIDE_AFTER_DAYS = 60;
const RECENT_AIR_DAYS = 3;

// [优化-1] 各类请求超时
const TIMEOUT_TRAKT = 10000;
const TIMEOUT_TMDB = 10000;

// [优化-2] 持久化缓存 TTL
const TTL_TMDB_SHOW = 24 * 3600 * 1000;
const TTL_TMDB_SEASON = 6 * 3600 * 1000;
const TTL_TRAKT_SEASON = 6 * 3600 * 1000;
const TTL_TRAKT_RATING = 24 * 3600 * 1000;
const TTL_TRAKT_NEXT = 1 * 3600 * 1000;
const TTL_TRAKT_HISTORY = 5 * 60 * 1000;

/* ==================== 工具 ==================== */

const toArray = value => (Array.isArray(value) ? value : []);

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

function normalizeRating(value) {
    const n = toNumber(value);
    return n > 0 ? Math.round(n * 10) / 10 : 0;
}

function formatPercent(value) {
    const n = Math.round(toNumber(value) * 10) / 10;
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * 提示条目。
 * 指南中正式条目类型为 link / url / tmdb / imdb / douban。
 * 本组件在"错误 / 空数据"等需要明确文案给用户的场景返回该扩展结构，
 * 若 App 不支持 type="text"，可整体替换为 []（交由 App 空态呈现）。
 */
function noticeItem(id, title, description = "") {
    const item = { id, type: "text", title };
    if (description) item.description = description;
    return [item];
}

function loadError(error) {
    const message = error?.message || String(error);
    console.error("加载失败:", message);
    return noticeItem("err-load", "读取 Trakt 失败", `${message}\n请稍后重试`);
}

const getUser = params => String(params?.traktUser || "").trim();

// [优化-3] pageSize 增加上限
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
    if (raw === undefined || raw === null || raw === "") return HIDE_AFTER_DAYS;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : HIDE_AFTER_DAYS;
}

function uniqueNumbers(values) {
    return [...new Set(
        toArray(values).map(toNumber).filter(n => n > 0)
    )].sort((a, b) => a - b);
}

/* ==================== 缓存（内存 + 持久化，含并发合并） ==================== */

const CACHE_PREFIX = "myList.v1:";

const tmdbShowCache = new Map();
const tmdbSeasonCache = new Map();
const traktRatingCache = new Map();
const traktSeasonCache = new Map();
const traktNextCache = new Map();
const traktHistoryCache = new Map();

// [优化-7] 同 key 并发请求合并
const pendingMap = new Map();

async function storageGet(key) {
    try {
        if (!Widget.storage || typeof Widget.storage.get !== "function") return null;
        const v = await Widget.storage.get(key);
        if (v == null) return null;
        return typeof v === "string" ? JSON.parse(v) : v;
    } catch {
        return null;
    }
}

async function storageSet(key, value) {
    try {
        if (!Widget.storage || typeof Widget.storage.set !== "function") return;
        await Widget.storage.set(key, value);
    } catch {}
}

/**
 * 通用缓存加载：
 *   1) 内存命中 → 直接返回
 *   2) 同 key 有 pending → 复用
 *   3) storage 命中（且在 TTL 内）→ 提升到内存并返回
 *   4) 执行 loader → 写入内存 + storage
 */
async function cachedLoad(cache, key, loader, ttlMs = 0) {
    const now = Date.now();

    const mem = cache.get(key);
    if (mem && (!ttlMs || now - mem.t < ttlMs)) return mem.v;

    if (pendingMap.has(key)) return pendingMap.get(key);

    const task = (async () => {
        const persisted = await storageGet(CACHE_PREFIX + key);
        if (persisted
            && persisted.v !== undefined
            && (!ttlMs || Date.now() - persisted.t < ttlMs)) {
            cache.set(key, persisted);
            return persisted.v;
        }

        const value = await loader();
        const entry = { v: value, t: Date.now() };
        cache.set(key, entry);
        // storage 写入不阻塞主流程
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
        // en-CA 直接输出 YYYY-MM-DD
        return new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Shanghai",
            year: "numeric", month: "2-digit", day: "2-digit"
        }).format(date);
    } catch {}

    const shifted = new Date(date.getTime() + 8 * 3600000);
    return [
        shifted.getUTCFullYear(),
        pad2(shifted.getUTCMonth() + 1),
        pad2(shifted.getUTCDate())
    ].join("-");
}

function formatAiredTime(value) {
    if (!value || typeof value !== "string" || !value.includes("T")) {
        return "";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";

    try {
        const parts = new Intl.DateTimeFormat("en-GB", {
            timeZone: "Asia/Shanghai",
            hour: "2-digit", minute: "2-digit", hour12: false
        }).formatToParts(date);
        const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
        if (map.hour && map.minute) return `${map.hour}:${map.minute}`;
    } catch {}

    return "";
}

function dayNumber(day) {
    const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || "");
    if (!matched) return NaN;
    return Date.UTC(
        toNumber(matched[1]),
        toNumber(matched[2]) - 1,
        toNumber(matched[3])
    ) / 86400000;
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

/* ==================== 通用辅助 ==================== */

const getTraktShowId = show => show?.ids?.trakt || show?.ids?.slug || "";

/* ==================== Trakt 客户端 ==================== */

function getTraktHeaders() {
    return {
        "Content-Type": "application/json",
        "trakt-api-version": "2",
        "trakt-api-key": TRAKT_CLIENT_ID
    };
}

async function traktRequest(path, strict = false) {
    let response;
    try {
        // [优化-1] 使用内置 timeout
        response = await Widget.http.get(TRAKT_BASE + path, {
            headers: getTraktHeaders(),
            timeout: TIMEOUT_TRAKT
        });
    } catch (error) {
        if (strict) throw error;
        return null;
    }

    if (!response) {
        if (strict) throw new Error("Trakt 返回为空");
        return null;
    }
    if (response.ok === false) {
        if (strict) throw new Error(`Trakt HTTP ${response.status || "unknown"}`);
        return null;
    }

    const data = Array.isArray(response)
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

async function fetchAllTraktPages(pathBuilder) {
    const all = [];

    for (let page = 1; page <= TRAKT_MAX_PAGES; page++) {
        const data = await traktRequest(pathBuilder(page), page === 1);

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

const fetchWatchedShows = user =>
    fetchAllTraktPages(page =>
        `/users/${encodeURIComponent(user)}/watched/shows` +
        `?extended=progress&page=${page}&limit=${TRAKT_PAGE_LIMIT}`
    );

const fetchShowHistory = (user, showId) =>
    fetchAllTraktPages(page =>
        `/users/${encodeURIComponent(user)}/history/shows/` +
        `${encodeURIComponent(showId)}?page=${page}&limit=${TRAKT_PAGE_LIMIT}`
    );

async function fetchTraktSeason(show, season) {
    const id = getTraktShowId(show);
    if (!id || season <= 0) return [];

    const key = `trakt:season:${id}:${season}`;

    try {
        return await cachedLoad(traktSeasonCache, key, async () => {
            const data = await traktRequest(
                `/shows/${encodeURIComponent(id)}/seasons/${season}?extended=full`
            );
            return Array.isArray(data) ? data : toArray(data?.episodes);
        }, TTL_TRAKT_SEASON);
    } catch {
        return [];
    }
}

async function fetchTraktRating(show) {
    const id = getTraktShowId(show);
    if (!id) return 0;

    try {
        return await cachedLoad(traktRatingCache, `trakt:rating:${id}`, async () => {
            const data = await traktRequest(
                `/shows/${encodeURIComponent(id)}/ratings`
            );
            return normalizeRating(data?.rating);
        }, TTL_TRAKT_RATING);
    } catch {
        return 0;
    }
}

async function fetchTraktNext(show) {
    const id = getTraktShowId(show);
    if (!id) return null;

    try {
        return await cachedLoad(traktNextCache, `trakt:next:${id}`, async () => {
            const data = await traktRequest(
                `/shows/${encodeURIComponent(id)}/next_episode?extended=full`
            );
            const s = toNumber(data?.season);
            const n = toNumber(data?.number);
            if (s <= 0 || n <= 0) return null;

            return {
                season: s,
                number: n,
                title: data?.title || "",
                firstAired: data?.first_aired || data?.effective_release_date || null
            };
        }, TTL_TRAKT_NEXT);
    } catch {
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
    } catch {
        return null;
    }
}

async function fetchTmdbShow(id) {
    return await cachedLoad(tmdbShowCache, `tmdb:tv:${id}`, async () => {
        const data = unpackResponse(
            await Widget.tmdb.get(`/tv/${id}`, {
                params: { language: "zh-CN" },
                timeout: TIMEOUT_TMDB
            })
        );
        if (!data || typeof data !== "object") throw new Error("TMDB 剧集详情为空");
        return data;
    }, TTL_TMDB_SHOW);
}

async function fetchTmdbSeason(id, season) {
    return await cachedLoad(tmdbSeasonCache, `tmdb:tv:${id}:season:${season}`, async () => {
        const data = unpackResponse(
            await Widget.tmdb.get(`/tv/${id}/season/${season}`, {
                params: { language: "zh-CN" },
                timeout: TIMEOUT_TMDB
            })
        );
        if (!data || typeof data !== "object") throw new Error("TMDB 季详情为空");
        return data;
    }, TTL_TMDB_SEASON);
}

async function loadTmdbShow(tmdbId) {
    if (!tmdbId) return { tmdbShow: null, failed: false };
    try {
        return { tmdbShow: await fetchTmdbShow(tmdbId), failed: false };
    } catch {
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

            const isNewer = !last
                || sn > last.season
                || (sn === last.season && en > last.episode);

            if (isNewer) last = { season: sn, episode: en };
        }
    }

    return { count, last };
}

async function fetchHighestWatched(user, show) {
    const showId = getTraktShowId(show);
    if (!user || !showId) return null;

    return await cachedLoad(
        traktHistoryCache,
        `${user}:${showId}`,
        async () => {
            const rows = await fetchShowHistory(user, showId);
            let last = null;
            let lastWatchedAt = null;

            for (const row of rows) {
                const episode = row?.episode;
                if (!episode) continue;

                const s = toNumber(episode.season);
                const n = toNumber(episode.number);
                if (s <= 0 || n <= 0) continue;

                const isNewer = !last
                    || s > last.season
                    || (s === last.season && n > last.episode);

                if (isNewer) last = { season: s, episode: n };

                const watchedAt = row?.watched_at || row?.created_at;
                if (safeTime(watchedAt) > safeTime(lastWatchedAt)) {
                    lastWatchedAt = watchedAt;
                }
            }

            return last ? { last, lastWatchedAt } : null;
        },
        TTL_TRAKT_HISTORY
    );
}

const getAiredCount = (show, tmdbShow) =>
    toNumber(show?.aired_episodes) || toNumber(tmdbShow?.number_of_episodes);

/* ==================== 媒体对象组装 ==================== */

function makeShowMeta(show, tmdbShow) {
    return {
        title: tmdbShow?.name || show?.title || tmdbShow?.original_name || "未知剧集",
        year: String(
            show?.year ||
            String(tmdbShow?.first_air_date || "").slice(0, 4) ||
            ""
        )
    };
}

function makeMedia({
    show, tmdbId, tmdbShow,
    title, year, season, episode, lines
}) {
    // [优化-5] 不再用中文 title 作 id 兜底，改用稳定标识
    const fallbackId =
        show?.ids?.trakt ||
        show?.ids?.slug ||
        show?.ids?.tmdb ||
        "unknown";

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
    if (tmdbShow?.backdrop_path) media.backdropPath = TMDB_BACKDROP + tmdbShow.backdrop_path;

    const genreNames = toArray(tmdbShow?.genres)
        .map(g => g?.name)
        .filter(Boolean);
    if (genreNames.length) {
        media.genres = genreNames;
        media.tags = genreNames;
        media.genre = genreNames.join(",");
    }

    return media;
}

/* ==================== 下一集推断 ==================== */

const nextResult = (season, episode) => ({ status: "next", next: { season, episode } });

async function inferNextEpisode(last, tmdbId, tmdbShow, show, aired, tmdbFailed) {
    if (!last) return { status: "none" };

    // 1. Trakt 当前季
    const curSeason = await fetchTraktSeason(show, last.season);
    const nextInCur = curSeason.find(ep => toNumber(ep?.number) === last.episode + 1);
    if (nextInCur) {
        if (isTraktEpisodeAired(nextInCur)) {
            return nextResult(last.season, last.episode + 1);
        }
        return { status: "none" };
    }

    // 2. Trakt 下一季
    const nextSeasonData = await fetchTraktSeason(show, last.season + 1);
    const firstOfNext = nextSeasonData.find(ep => toNumber(ep?.number) === 1);
    if (firstOfNext) {
        if (isTraktEpisodeAired(firstOfNext)) {
            return nextResult(last.season + 1, 1);
        }
        return { status: "none" };
    }

    // 3. 兜底
    const canFallback = last.season === 1
        && toNumber(aired || show?.aired_episodes) > last.episode;
    const fallback = () =>
        canFallback ? nextResult(last.season, last.episode + 1)
                    : { status: "lookup_failed" };

    if (!tmdbId || tmdbFailed) return fallback();

    // 4. TMDB 当前季
    let seasonData;
    try {
        seasonData = await fetchTmdbSeason(tmdbId, last.season);
    } catch {
        return fallback();
    }

    const nextOnTmdb = toArray(seasonData?.episodes).find(
        ep => toNumber(ep?.episode_number) === last.episode + 1
    );
    if (nextOnTmdb) {
        return hasAired(nextOnTmdb?.air_date)
            ? nextResult(last.season, toNumber(nextOnTmdb.episode_number))
            : { status: "none" };
    }

    const latest = tmdbShow?.last_episode_to_air;
    if (latest
        && toNumber(latest.season_number) === last.season
        && toNumber(latest.episode_number) >= last.episode + 1) {
        return nextResult(last.season, last.episode + 1);
    }

    if (canFallback) return fallback();

    // 5. TMDB 下一季
    const nextSeasonNo = last.season + 1;
    const hasNext = toArray(tmdbShow?.seasons).some(
        s => toNumber(s?.season_number) === nextSeasonNo
          && toNumber(s?.episode_count) > 0
    );
    if (!hasNext) return { status: "none" };

    try {
        const ns = await fetchTmdbSeason(tmdbId, nextSeasonNo);
        const ep1 = toArray(ns?.episodes).find(
            ep => toNumber(ep?.episode_number) === 1 && hasAired(ep?.air_date)
        );
        return ep1 ? nextResult(nextSeasonNo, 1) : { status: "none" };
    } catch {
        return { status: "lookup_failed" };
    }
}

/* ==================== 预告（4 级兜底） ==================== */

async function resolveSeasonPreview(show, tmdbId, tmdbShow, currentSeason, currentEpisode) {
    const [episodes, next] = await Promise.all([
        fetchTraktSeason(show, currentSeason),
        fetchTraktNext(show)
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

            const nextEpisodes = await fetchTraktSeason(show, nextSeason);
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
                .filter(ep => {
                    const n = toNumber(ep?.episode_number);
                    if (n <= currentEpisode) return false;
                    const d = getDisplayDate(ep?.air_date);
                    return !!d && d >= today();
                })
                .sort((a, b) =>
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
        } catch {}
    }

    return null;
}

function findNearestFutureBatch(episodes, season, afterEpisode) {
    const list = toArray(episodes);
    if (!list.length) return null;

    const todayStr = today();

    const future = list
        .map(ep => {
            const fa = ep?.first_aired || ep?.effective_release_date || null;
            return {
                season: toNumber(ep?.season || season),
                episode: toNumber(ep?.number),
                firstAired: fa,
                displayDay: getDisplayDate(fa)
            };
        })
        .filter(ep =>
            ep.season > 0 &&
            ep.episode > 0 &&
            ep.displayDay &&
            !(ep.season === season && ep.episode <= afterEpisode) &&
            ep.displayDay >= todayStr
        );

    if (!future.length) return null;

    future.sort((a, b) =>
        a.displayDay.localeCompare(b.displayDay) ||
        a.season - b.season ||
        a.episode - b.episode
    );

    const first = future[0];
    const nums = uniqueNumbers(
        future
            .filter(ep => ep.displayDay === first.displayDay && ep.season === first.season)
            .map(ep => ep.episode)
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

    const continuous = list.every((n, i) => i === 0 || n === list[i - 1] + 1);
    if (continuous) {
        return `${prefix}E${pad2(list[0])}-E${pad2(list[list.length - 1])}`;
    }
    return prefix + list.map(n => `E${pad2(n)}`).join(",");
}

function buildPreviewText(preview) {
    if (!preview) return "";
    const range = seRange(toNumber(preview.season), preview.episodes);
    if (!range) return "";

    const d = preview.displayDay || getDisplayDate(preview.firstAired);
    if (!d) return `📆 ${range}`;

    const time = formatAiredTime(preview.firstAired);
    const rem = remainingText(d);

    if (rem === "今天播出") {
        return time
            ? `📆 ${range} · 今天 ${time}`
            : `📆 ${range} · 今天播出`;
    }
    if (rem === "明天播出") {
        return time
            ? `📆 ${range} · 明天 ${time}`
            : `📆 ${range} · 明天播出`;
    }

    const shortDate = d.slice(5).replace("-", "/");
    return time
        ? `📆 ${range} · ${shortDate} ${time} 更新`
        : `📆 ${range} · ${shortDate} 更新`;
}

/* ==================== 完结判断（Trakt 首选） ==================== */

function buildCompletionText({ tmdbShow, seasonData, currentSeason, traktShow }) {
    if (currentSeason <= 0) return "";

    const seasons = toArray(tmdbShow?.seasons).filter(
        s => toNumber(s?.season_number) > 0
    );
    const seasonInfo = seasons.find(
        s => toNumber(s?.season_number) === currentSeason
    );

    const traktAired = toNumber(traktShow?.aired_episodes);
    const showTotal = toNumber(tmdbShow?.number_of_episodes);

    // [优化-4] 仅当 TMDB 明确返回"恰好一季"时才按单季处理；
    // seasons 为空（TMDB 缺数据）不再误判
    const isSingleSeason = seasons.length === 1;

    let seasonCount = toNumber(seasonInfo?.episode_count);
    if (seasonData) {
        const eps = toArray(seasonData?.episodes).filter(
            e => toNumber(e?.episode_number) > 0
        );
        if (eps.length > seasonCount) seasonCount = eps.length;
    }
    if (isSingleSeason) {
        seasonCount = Math.max(seasonCount, showTotal, traktAired);
    }
    if (seasonCount <= 0) return "";

    // 判断"本季是否播完"
    let seasonAllAired = false;

    // 首选：Trakt
    if (traktAired > 0 && traktAired >= seasonCount) {
        seasonAllAired = true;
    }

    // 备选 1：TMDB last_episode_to_air
    if (!seasonAllAired) {
        const last = tmdbShow?.last_episode_to_air;
        const lastSeasonNo = toNumber(last?.season_number);
        const lastEpNum = toNumber(last?.episode_number);
        const lastAired = !!last?.air_date && hasAired(last.air_date);
        if (lastAired
            && lastSeasonNo === currentSeason
            && lastEpNum >= seasonCount) {
            seasonAllAired = true;
        }
    }

    // 备选 2：TMDB seasonData 全播完
    if (!seasonAllAired && seasonData) {
        const eps = toArray(seasonData?.episodes).filter(
            e => toNumber(e?.episode_number) > 0
        );
        if (eps.length >= seasonCount
            && eps.every(e => e?.air_date && hasAired(e.air_date))) {
            seasonAllAired = true;
        }
    }

    if (!seasonAllAired) return "";

    // 判断是否有下一季
    const next = tmdbShow?.next_episode_to_air;
    const nextSeasonNo = toNumber(next?.season_number);
    const hasNextEpisodeInNextSeason = nextSeasonNo > currentSeason;
    const hasNextSeason = seasons.some(
        s => toNumber(s?.season_number) > currentSeason
          && toNumber(s?.episode_count) > 0
    );
    const status = String(tmdbShow?.status || "").trim().toLowerCase();
    const statusReturning =
        status === "returning series" || status === "in production";

    const hasNext = hasNextEpisodeInNextSeason || hasNextSeason || statusReturning;

    if (hasNext) {
        return `🏁 本季已完结 · 共${seasonCount}集`;
    }

    const total = Math.max(showTotal, traktAired, seasonCount);
    return total > 0 ? `🏁 全剧已完结 · 共${total}集` : "🏁 全剧已完结";
}

/* ==================== 并发 ==================== */

async function mapWithConcurrency(items, concurrency, worker) {
    const list = toArray(items);
    if (!list.length) return [];

    const results = new Array(list.length);
    let cursor = 0;
    const n = Math.min(Math.max(1, concurrency || 1), list.length);

    await Promise.all(Array.from({ length: n }, async () => {
        while (cursor < list.length) {
            const i = cursor++;
            try { results[i] = await worker(list[i], i); }
            catch { results[i] = null; }
        }
    }));

    return results;
}

/* ==================== 继续观看 ==================== */

async function didAirRecently(show, season, episode, days = RECENT_AIR_DAYS) {
    if (season <= 0 || episode <= 0) return false;
    try {
        const eps = await fetchTraktSeason(show, season);
        const target = eps.find(ep => toNumber(ep?.number) === episode);
        const fa = target?.first_aired || target?.effective_release_date;
        if (!fa) return false;

        const aired = dayNumber(getDisplayDate(fa));
        const now = dayNumber(today());
        if (!Number.isFinite(aired) || !Number.isFinite(now)) return false;

        const diff = now - aired;
        return diff >= 0 && diff < days;
    } catch {
        return false;
    }
}

function isRecentContinueItem(item, days = HIDE_AFTER_DAYS) {
    const t = safeTime(item?.last_watched_at);
    if (t <= 0) return false;
    if (!days || days <= 0) return true;
    return Date.now() - t <= days * 86400000;
}

async function buildContinueItem(user, item, stats) {
    const show = item?.show || {};
    const tmdbId = toNumber(show?.ids?.tmdb) || null;

    const history = await fetchHighestWatched(user, show);
    const { count, last } = history?.last
        ? { count: stats.count, last: history.last }
        : stats;
    if (!last) return null;

    const { tmdbShow, tmdbFailed } = await loadTmdbShow(tmdbId);
    const aired = getAiredCount(show, tmdbShow);

    const result = await inferNextEpisode(last, tmdbId, tmdbShow, show, aired, tmdbFailed);
    if (result.status !== "next") return null;

    const season = toNumber(result.next.season);
    const episode = toNumber(result.next.episode);
    const meta = makeShowMeta(show, tmdbShow);

    const pct = aired > 0 ? Math.min(100, Math.max(0, count / aired * 100)) : 0;
    const progress = aired > 0
        ? `${formatPercent(pct)}%（${count}/${aired}）`
        : `${count} 集`;

    const lastWatchedAt = history?.lastWatchedAt || item?.last_watched_at || null;

    const media = makeMedia({
        show, tmdbId, tmdbShow,
        title: meta.title, year: meta.year,
        season, episode,
        lines: [`▶️ ${formatSE(season, episode)} · 进度 ${progress}`]
    });

    const recentUpdate = await didAirRecently(show, season, episode);

    return { media, show, tmdbShow, tmdbId, recentUpdate, lastWatchedAt };
}

async function loadContinueWatching(params = {}) {
    const user = getUser(params);
    const { page, pageSize } = getPaging(params);
    const recentDays = getRecentDays(params);

    if (!user) return noticeItem("err-no-user", "请在设置中填写 Trakt 用户名");

    try {
        const watched = await fetchWatchedShows(user);
        if (!watched.length) {
            return noticeItem("empty", "没有读取到观看记录",
                "请检查 Trakt 用户名以及账号隐私设置");
        }

        watched.sort((a, b) =>
            safeTime(b?.last_watched_at) - safeTime(a?.last_watched_at)
        );

        const candidates = watched
            .map(item => ({ item, stats: getWatchStats(item) }))
            .filter(({ item, stats }) =>
                stats.count > 0 && isRecentContinueItem(item, recentDays)
            );

        const checked = await mapWithConcurrency(
            candidates, MAX_CONCURRENCY,
            async ({ item, stats }) => {
                try { return await buildContinueItem(user, item, stats); }
                catch { return null; }
            }
        );

        const available = checked.filter(Boolean);

        available.sort((a, b) =>
            (Number(!!b.recentUpdate) - Number(!!a.recentUpdate)) ||
            safeTime(b.lastWatchedAt) - safeTime(a.lastWatchedAt)
        );

        return await finalizePage(available, page, pageSize);
    } catch (error) {
        return loadError(error);
    }
}

/* ==================== 最终化 ==================== */

async function finalizeMediaItem(data) {
    const { media, show, tmdbShow, tmdbId } = data || {};
    if (!media) return null;

    const season = toNumber(media.currentSeason);
    const episode = toNumber(media.currentEpisode);

    // [优化-1] / [优化-6]：timeout 已内置在 fetch 层，不再外包 withSoftTimeout
    const [rating, preview, seasonData] = await Promise.all([
        fetchTraktRating(show).catch(() => 0),
        resolveSeasonPreview(show, tmdbId, tmdbShow, season, episode).catch(() => null),
        tmdbId ? fetchTmdbSeason(tmdbId, season).catch(() => null) : Promise.resolve(null)
    ]);

    if (toNumber(rating) > 0) media.rating = toNumber(rating);

    // 用 TMDB 季/集 ID 覆盖 App 内部播放记录
    if (seasonData) {
        const seasonId = toNumber(seasonData?.id);
        if (seasonId > 0) {
            media.currentSeasonId = String(seasonId);
        }

        const episodes = toArray(seasonData?.episodes);
        const targetEp = episodes.find(
            e => toNumber(e?.episode_number) === episode
        );
        const epId = toNumber(targetEp?.id);
        if (epId > 0) {
            media.currentEpisodeId = String(epId);
        }
    }

    const previewText = buildPreviewText(preview);
    if (previewText) {
        media.description += `\n${previewText}`;
        return media;
    }

    const completionText = buildCompletionText({
        tmdbShow, seasonData, currentSeason: season, traktShow: show
    });
    if (completionText) media.description += `\n${completionText}`;

    return media;
}

/* ==================== 分页 ==================== */

async function finalizePage(items, page, pageSize) {
    const start = (page - 1) * pageSize;
    const pageItems = items.slice(start, start + pageSize);

    if (!pageItems.length) {
        if (page !== 1) return [];
        return noticeItem("empty-progress", "暂无可继续观看的新集",
            "已追到当前最新集，新剧集播出后会重新显示");
    }

    const output = await mapWithConcurrency(pageItems, MAX_CONCURRENCY,
        async data => {
            try { return await finalizeMediaItem(data); }
            catch { return data?.media || null; }
        }
    );

    return output.filter(Boolean);
}
