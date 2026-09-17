import { serwist } from "@serwist/next/config";

/**
 * Serwist "configurator mode": the service worker is bundled by `@serwist/cli`
 * (`serwist build serwist.config.mjs`) AFTER `next build`, independently of
 * Next's own bundler. That is what keeps `next build` on Turbopack — the
 * webpack-plugin mode of `@serwist/next` cannot run under Next 16's default
 * Turbopack build.
 *
 * `serwist(...)` loads next.config.ts to find the dist dir, globs the build
 * output plus `public/` into the precache manifest, compiles `src/app/sw.ts`
 * with esbuild and writes `public/sw.js` (served at `/sw.js` by `next start`,
 * and copied into the Docker runner by the existing `public/` COPY).
 *
 * TWO RULES ABOUT THE PRECACHE LIST, BOTH LEARNED THE HARD WAY
 * -----------------------------------------------------------
 * 1. **Never list a URL by hand that the globs already produce.** Two entries
 *    for one URL abort installation with `add-to-cache-list-conflicting-entries`
 *    and the worker registers no handlers at all. That is the bug that broke
 *    offline mode in Kiri v1, and it is why `precachePrerendered` (on by
 *    default) is left to do its own thing below.
 *
 * 2. **Never precache a URL that can answer with anything but a 2xx.** Serwist
 *    installs the whole manifest through `parallel()` in `@serwist/utils`,
 *    whose worker promises are constructed as `new Promise(async (resolve) =>
 *    …)` — with no `reject`. A single rejected precache request therefore never
 *    settles its queue, `Promise.all` never resolves, and the service worker
 *    sits in `installing` **forever**: no error, no `redundant`, just a PWA
 *    that silently never works.
 *
 *    Rule 2 is what `keepOnlyPublicShells` below enforces. `src/proxy.ts` gates
 *    every non-public route, and a precache request is *not* a navigation (its
 *    `Accept` is `* / *` and it carries no `RSC` header), so the proxy answers
 *    it with a 401 JSON body rather than a redirect. Precaching `/read`,
 *    `/add` or `/logout` therefore deadlocks the install even for a signed-in
 *    user. `/offline` is the one prerendered shell on the public list
 *    (`src/lib/auth/public-paths.ts`), so it is the one shell that can be
 *    precached.
 *
 *    `/read` still works offline: `OfflineBootstrap` warms it into the `pages`
 *    cache with an `Accept: text/html` request (which the proxy *does* treat as
 *    a navigation), and the worker's `pages` strategy strips the query string
 *    from `/read?series=…` so every chapter URL resolves to that one shell. See
 *    `src/lib/offline/shell-cache.ts` and `src/app/sw.ts`.
 *
 *    The same rule applies to anything dropped into `public/`: it is globbed
 *    into the precache list, and it must be reachable without a session.
 */

/** Prerendered shells that are public, and therefore safe to precache. */
const PRECACHEABLE_SHELLS = new Set(["/offline"]);

/**
 * Drops every prerendered HTML shell that is not on the public list. Runs
 * before the configurator's own transform, so URLs are still raw build paths
 * (`.next/server/app/read.html`).
 */
const keepOnlyPublicShells = (entries) => ({
  manifest: entries.filter((entry) => {
    const match = /\/server\/(?:app|pages)\/(.*)\.html$/.exec(entry.url.replace(/\\/g, "/"));
    if (!match) return true;
    return PRECACHEABLE_SHELLS.has(`/${match[1]}`);
  }),
  warnings: [],
});

export default serwist({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  manifestTransforms: [keepOnlyPublicShells],
});
