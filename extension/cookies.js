// Plain ESM module, no `chrome.*` dependency — importable both by the
// background service worker and by a Node test runner (see
// apps/web/src/lib/plugins-extension.test.ts).
//
// Cloudflare's bot-management cookies are bound to the browser's IP/TLS
// fingerprint for the current session. Replaying them from Kiri's server (a
// different client) makes Cloudflare re-issue a challenge even with a valid
// cf_clearance — a manual cf_clearance paste omits them, which is why that
// works, so we drop them here too and rely on cf_clearance + a matching
// User-Agent. Ported from Kiri v1 (`extension/background.js:23-37`).
export const VOLATILE_COOKIE_NAMES = Object.freeze(["__cf_bm", "_cfuvid"]);
const VOLATILE_COOKIE_PREFIXES = Object.freeze(["cf_chl_"]);

export function isVolatileCookieName(name) {
  if (VOLATILE_COOKIE_NAMES.includes(name)) {
    return true;
  }
  return VOLATILE_COOKIE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Builds a `Cookie:` header value from `chrome.cookies.getAll()`-shaped
 * results (`{ name, value, ... }[]`): drops volatile Cloudflare cookies and
 * dedupes by name (the same cookie can appear for multiple domain scopes,
 * e.g. a host-only and a `.domain` `cf_clearance`) — last one wins, and
 * `chrome.cookies.getAll` returns broader-scoped cookies first, so the
 * more specific (host-only) value naturally wins the dedupe.
 */
export function buildCookieHeader(cookies) {
  const byName = new Map();
  for (const cookie of cookies) {
    if (!cookie || typeof cookie.name !== "string") continue;
    if (isVolatileCookieName(cookie.name)) continue;
    byName.set(cookie.name, cookie.value);
  }
  return Array.from(byName, ([name, value]) => `${name}=${value}`).join("; ");
}

/** The `cf_clearance` value in a raw cookie list, or null — used to decide whether a throttled re-send is still worth doing (see background.js's capture()). */
export function cfClearanceValue(cookies) {
  const match = cookies.find((cookie) => cookie?.name === "cf_clearance");
  return match ? match.value : null;
}

/**
 * Finds which known host (from the server's `GET /api/plugins/hosts` list)
 * a page/cookie hostname belongs to: an exact match, or a subdomain of one.
 * Returns null when no known host matches. Case-insensitive.
 */
export function matchKnownHost(hostname, knownHosts) {
  if (!hostname || !Array.isArray(knownHosts)) return null;
  const host = hostname.toLowerCase();
  return (
    knownHosts.find((known) => {
      const candidate = String(known).toLowerCase();
      return host === candidate || host.endsWith(`.${candidate}`);
    }) ?? null
  );
}
