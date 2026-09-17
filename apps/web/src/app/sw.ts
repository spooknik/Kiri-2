/**
 * Kiri's service worker.
 *
 * Compiled by `@serwist/cli` ("configurator mode": `serwist build
 * serwist.config.mjs` runs AFTER `next build`, see serwist.config.mjs for why
 * the webpack-plugin mode cannot be used with Turbopack) into `public/sw.js`,
 * which `next start` serves at `/sw.js`.
 *
 * Excluded from the app's tsconfig (`exclude: ["src/app/sw.ts"]`) because the
 * WebWorker globals used here clash with the DOM lib the rest of the app is
 * compiled against; `tsconfig.sw.json` type-checks it on its own terms
 * (`npm run typecheck:sw`).
 *
 * Strategy table (first match wins; entries are GET-only unless stated):
 *
 *   precache                    build assets, /manifest.json, /icons/*, and the
 *                               one *public* prerendered shell, /offline (see
 *                               serwist.config.mjs for why a gated route must
 *                               never be precached)
 *   navigations                 NetworkFirst 3 s -> `pages`, with /read?… keyed
 *                               as bare /read so one warmed shell serves every
 *                               chapter; fallback: precached /offline
 *   /api/pages/:id/image        CacheFirst -> `reader-images`
 *   /api/series/:id/cover       CacheFirst -> `reader-images`
 *   /api/chapters/:id           NetworkFirst 3 s -> `reader-content`
 *   /api/library*, /api/series/*,
 *   /api/chapters/*, /api/notifications
 *                               NetworkFirst 3 s -> `api`
 *   everything else             @serwist/next defaultCache
 *   catch-all failure           navigations -> precached /offline
 *                               otherwise  -> 503 {"error":{"code":"OFFLINE"}}
 *
 * There is deliberately no `purgeOnQuotaError` on `reader-images`: the app owns
 * eviction per series (see `deleteSeriesOffline`), and a quota-triggered wipe
 * would silently desynchronise the IndexedDB catalog from the bytes on disk.
 */
import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { CacheFirst, ExpirationPlugin, NetworkFirst, Serwist } from "serwist";
// Relative, not "@/...": esbuild compiles this file outside the app's tsconfig
// include, so a path alias would be one more thing that can silently break the
// build. cache-names.ts is plain constants for exactly this reason.
import {
  API_CACHE,
  isCacheableApiPath,
  isChapterDetailPath,
  isPageImagePath,
  isSeriesCoverPath,
  PAGES_CACHE,
  READER_CONTENT_CACHE,
  READER_IMAGES_CACHE,
  shellCacheKey,
} from "../lib/offline/cache-names";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

/** Reader/library query params that must not fragment a precache lookup. */
const IGNORED_PARAMS = [/^series$/, /^chapter$/, /^page$/, /^q$/];

const NETWORK_TIMEOUT_SECONDS = 3;

/** Cache lookups ignore `Vary`: Next varies responses on headers the reader never replays. */
const MATCH_OPTIONS: CacheQueryOptions = { ignoreVary: true };

const serwist = new Serwist({
  // Injected by `serwist build`. Two hard rules, both explained at length in
  // serwist.config.mjs: never list one of these URLs a second time by hand
  // (`add-to-cache-list-conflicting-entries` aborts the install), and never let
  // a URL into the manifest that can answer with anything but a 2xx (a rejected
  // precache request wedges Serwist's installer forever).
  precacheEntries: self.__SW_MANIFEST,
  precacheOptions: { ignoreURLParametersMatching: IGNORED_PARAMS },
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  disableDevLogs: true,
  // Applied to every runtime strategy as a `handlerDidError` plugin; the
  // matcher keeps it to navigations. `/offline` is the only entry because it is
  // the only prerendered shell that is precachable at all — `/read` is served
  // out of the `pages` cache below, warmed by `warmShellCache()`.
  fallbacks: {
    entries: [
      {
        url: "/offline",
        matcher: ({ request }) => request.mode === "navigate",
      },
    ],
  },
  runtimeCaching: [
    {
      matcher: ({ request, sameOrigin }) => sameOrigin && request.mode === "navigate",
      handler: new NetworkFirst({
        cacheName: PAGES_CACHE,
        networkTimeoutSeconds: NETWORK_TIMEOUT_SECONDS,
        matchOptions: MATCH_OPTIONS,
        plugins: [
          {
            // `/read?series=…&chapter=…&page=…` is one shell with three
            // parameters. Keying it by the bare path is what makes a chapter
            // downloaded today readable offline from a link never visited
            // before.
            cacheKeyWillBeUsed: async ({ request }) => shellCacheKey(new URL(request.url)),
          },
          new ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 * 30 }),
        ],
      }),
    },
    {
      // Immutable bytes: `/api/pages/:id/image` is stable for the life of the
      // page row (optimisation rewrites the file, not the id), and covers carry
      // a `?v=` stamp, so a replaced cover is simply a different URL.
      matcher: ({ url, sameOrigin }) =>
        sameOrigin && (isPageImagePath(url.pathname) || isSeriesCoverPath(url.pathname)),
      handler: new CacheFirst({
        cacheName: READER_IMAGES_CACHE,
        matchOptions: MATCH_OPTIONS,
      }),
    },
    {
      matcher: ({ url, sameOrigin }) => sameOrigin && isChapterDetailPath(url.pathname),
      handler: new NetworkFirst({
        cacheName: READER_CONTENT_CACHE,
        networkTimeoutSeconds: NETWORK_TIMEOUT_SECONDS,
        matchOptions: MATCH_OPTIONS,
      }),
    },
    {
      matcher: ({ url, sameOrigin }) => sameOrigin && isCacheableApiPath(url.pathname),
      handler: new NetworkFirst({
        cacheName: API_CACHE,
        networkTimeoutSeconds: NETWORK_TIMEOUT_SECONDS,
        matchOptions: MATCH_OPTIONS,
        plugins: [new ExpirationPlugin({ maxEntries: 256, maxAgeSeconds: 60 * 60 * 24 * 30 })],
      }),
    },
    ...defaultCache,
  ],
});

/**
 * Last resort when a strategy cannot produce a response at all. Without it
 * Serwist rejects with `no-response`, which surfaces as noisy uncaught promise
 * errors and — for navigations — as the browser's own offline page.
 */
serwist.setCatchHandler(async ({ request }) => {
  if (request.mode === "navigate") {
    return (await serwist.matchPrecache("/offline")) ?? Response.error();
  }
  return Response.json(
    { error: { code: "OFFLINE", message: "You are offline and this is not cached" } },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
});

/**
 * `skipWaiting: true` already activates a new worker straight away, but the
 * update toast posts this explicitly so the flow keeps working if that option is
 * ever turned off, and so a worker left waiting by an older SW generation can be
 * retired without a second reload.
 */
self.addEventListener("message", (event: ExtendableMessageEvent) => {
  if ((event.data as { type?: string } | null)?.type === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});

serwist.addEventListeners();
