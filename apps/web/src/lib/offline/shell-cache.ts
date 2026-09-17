/**
 * Warms the reader shell into the `pages` cache.
 *
 * `/read` cannot be precached: it is gated by `src/proxy.ts`, and a precache
 * request is not a navigation (no `text/html` in `Accept`, no `RSC` header), so
 * the proxy answers it with a 401 — which deadlocks Serwist's install (see the
 * long note in serwist.config.mjs). Fetching it from the page, where a session
 * cookie exists and an explicit `Accept: text/html` makes the proxy treat it as
 * a navigation, gets the real shell; storing it under the bare `/read` key is
 * what lets the worker serve every `?series=…&chapter=…` variant from it.
 *
 * Best effort throughout: a failure here costs offline *navigation* to the
 * reader, never a download and never an online read.
 */
import { PAGES_CACHE, SHELL_ROUTES, shellCacheKey } from "@/lib/offline/cache-names";

/**
 * Fetch each shell route and store it under its bare path.
 *
 * A redirected response is discarded: signed out, `/read` redirects to
 * `/login`, and caching *that* under `/read` would show a login form to
 * someone opening a downloaded chapter in airplane mode.
 */
export async function warmShellCache(): Promise<void> {
  if (typeof caches === "undefined" || typeof location === "undefined") return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;

  try {
    const cache = await caches.open(PAGES_CACHE);
    await Promise.all(
      SHELL_ROUTES.map(async (route) => {
        try {
          const response = await fetch(route, {
            credentials: "same-origin",
            headers: { Accept: "text/html,application/xhtml+xml" },
          });
          if (!response.ok || response.redirected) return;
          if (!response.headers.get("content-type")?.includes("text/html")) return;
          await cache.put(shellCacheKey(new URL(route, location.origin)), response);
        } catch {
          // Offline or blocked: the next load tries again.
        }
      }),
    );
  } catch {
    // CacheStorage unavailable (private mode): nothing to do.
  }
}
