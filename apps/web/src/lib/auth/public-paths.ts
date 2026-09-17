/**
 * Which paths are reachable without a session.
 *
 * Pure path matching, kept out of src/proxy.ts so it can be unit tested and
 * reused by anything else that needs the same answer. Note that `/read` is
 * deliberately *not* public: the reader shell is precached by the service
 * worker but its data still requires a session.
 */

/** Exact paths that never require a session. */
const PUBLIC_EXACT = new Set([
  "/login",
  "/register",
  "/setup",
  "/offline",
  "/api/health",
  "/api/version",
  // The Kiri Cookie Bridge extension authenticates with its own bearer token,
  // not a session cookie, so the proxy must not 401 it before the route's own
  // check runs. Listed exactly: everything else under /api/plugins (install,
  // resolve, admin actions) stays session-gated.
  "/api/plugins/hosts",
  "/api/plugins/credentials",
  "/manifest.json",
  "/favicon.ico",
  "/sw.js",
]);

/** Prefixes (matched as `prefix` or `prefix/...`) that never require a session. */
const PUBLIC_PREFIXES = ["/api/auth", "/_next", "/icons", "/offline"] as const;

/** Normalize a pathname: strip the query/hash and any trailing slash. */
export function normalizePathname(pathname: string): string {
  const withoutQuery = pathname.split("?")[0]?.split("#")[0] ?? "/";
  if (withoutQuery.length > 1 && withoutQuery.endsWith("/")) {
    return withoutQuery.replace(/\/+$/, "") || "/";
  }
  return withoutQuery || "/";
}

export function isPublicPath(pathname: string): boolean {
  const path = normalizePathname(pathname);
  if (PUBLIC_EXACT.has(path)) return true;
  return PUBLIC_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** True for JSON API routes, which get a 401 body instead of a redirect. */
export function isApiPath(pathname: string): boolean {
  const path = normalizePathname(pathname);
  return path === "/api" || path.startsWith("/api/");
}
