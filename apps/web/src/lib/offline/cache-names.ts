/**
 * CacheStorage names shared by the service worker and the downloader.
 *
 * This module is the single source of truth for both sides of offline mode:
 * `src/app/sw.ts` registers the runtime-caching strategies under these names,
 * and `src/lib/offline/downloads.ts` writes/evicts entries in the very same
 * caches. V1 kept the names in two files and a comment ("MUST stay in sync");
 * they are literals here so a rename can only ever happen in one place.
 *
 * Deliberately dependency-free and DOM-free: `sw.ts` is compiled separately by
 * esbuild (see serwist.config.mjs) with the WebWorker lib, so anything it
 * imports must be plain, browser-agnostic TypeScript.
 */

/** Navigation documents (`NetworkFirst`, 3 s). */
export const PAGES_CACHE = "pages";

/** JSON API reads the UI can survive without: library, series, chapters, notifications. */
export const API_CACHE = "api";

/** Page images and covers (`CacheFirst`, immutable URLs, app-managed eviction). */
export const READER_IMAGES_CACHE = "reader-images";

/** `GET /api/chapters/:id` payloads, written ahead of time by the downloader. */
export const READER_CONTENT_CACHE = "reader-content";

/** Every cache offline mode owns. Used by `deleteSeriesOffline` and diagnostics. */
export const OFFLINE_CACHES = [
  PAGES_CACHE,
  API_CACHE,
  READER_IMAGES_CACHE,
  READER_CONTENT_CACHE,
] as const;

export type OfflineCacheName = (typeof OFFLINE_CACHES)[number];

/* -------------------------------------------------------------------------- */
/* URL shapes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Path matchers, shared so the worker and the downloader cannot disagree about
 * which URL belongs in which cache. Kept as functions over a pathname (not
 * full-URL regexes) so they are trivially unit-testable.
 */
export const isPageImagePath = (pathname: string): boolean =>
  /^\/api\/pages\/[^/]+\/image$/.test(pathname);

export const isSeriesCoverPath = (pathname: string): boolean =>
  /^\/api\/series\/[^/]+\/cover$/.test(pathname);

/** `GET /api/chapters/:id` — the reader's chapter detail, not its sub-routes. */
export const isChapterDetailPath = (pathname: string): boolean =>
  /^\/api\/chapters\/[^/]+$/.test(pathname);

/** The JSON reads worth a `NetworkFirst` cache; covers/images are excluded. */
export const isCacheableApiPath = (pathname: string): boolean => {
  if (isPageImagePath(pathname) || isSeriesCoverPath(pathname)) return false;
  if (pathname === "/api/notifications") return true;
  if (pathname === "/api/library" || pathname.startsWith("/api/library/")) return true;
  if (pathname.startsWith("/api/series/")) return true;
  if (pathname.startsWith("/api/chapters/")) return true;
  return false;
};

/** Chapter-detail URL the reader fetches (`src/hooks/use-reader.ts`). */
export const chapterDetailPath = (chapterId: string): string => `/api/chapters/${chapterId}`;

/** Chapter-list URL the reader fetches, warmed during a download. */
export const chapterListPath = (seriesId: string): string => `/api/series/${seriesId}/chapters`;

/**
 * Client-rendered shells whose cached copy must serve *every* query string.
 *
 * `/read?series=…&chapter=…&page=…` is one HTML shell with three parameters;
 * caching it per URL would mean a chapter is only readable offline if that
 * exact link was visited online first. The service worker rewrites the cache
 * key for these routes, and `warmShellCache()` stores them under the bare path.
 */
export const SHELL_ROUTES = ["/read"] as const;

/**
 * The `pages` cache key for a request: the bare path for a shell route, the
 * full URL otherwise. Pure, and shared by the worker and the warmer so they
 * cannot disagree about where a shell lives.
 */
export const shellCacheKey = (url: URL): string => {
  if ((SHELL_ROUTES as readonly string[]).includes(url.pathname)) {
    return `${url.origin}${url.pathname}`;
  }
  return url.href;
};

/** `GET /api/series/:id/offline-manifest`. */
export const offlineManifestPath = (seriesId: string): string =>
  `/api/series/${seriesId}/offline-manifest`;
