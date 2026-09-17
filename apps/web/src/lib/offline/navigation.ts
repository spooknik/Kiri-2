/**
 * The rule `AppLink` applies to a click.
 *
 * Kept here, pure and browser-free, because it is the decision that made V1's
 * offline mode feel broken: offline, a client-side transition fires an RSC
 * request for a route the service worker has never seen, that request 503s, and
 * the router leaves the user staring at the page they were already on.
 *
 *   online                     -> "client"  (ordinary next/link behaviour)
 *   offline, target cached     -> "document" (full navigation; the SW serves
 *                                 the cached document, and the reader/hub
 *                                 hydrate from CacheStorage + the persisted
 *                                 query cache)
 *   offline, target not cached -> "offline"  (go to the hub instead of a dead
 *                                 end)
 *
 * A full navigation rather than `router.push` for the cached case is
 * deliberate: the document is in the cache, the RSC payload for it is not.
 */
export type NavigationDecision = "client" | "document" | "offline";

export interface NavigationContext {
  online: boolean;
  /** Whether the target document is in the `pages` cache. */
  cached: boolean;
}

export function decideNavigation({ online, cached }: NavigationContext): NavigationDecision {
  if (online) return "client";
  return cached ? "document" : "offline";
}

/** Where a decision sends the browser, or null to let `next/link` proceed. */
export function navigationTarget(decision: NavigationDecision, href: string): string | null {
  switch (decision) {
    case "client":
      return null;
    case "document":
      return href;
    case "offline":
      return "/offline";
  }
}

/**
 * Clicks `AppLink` must never intercept: modified clicks and anything opening
 * in a new context are the browser's business. Pure, so the rule is testable
 * without synthesising DOM events.
 */
export function isPlainLeftClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}): boolean {
  if (event.defaultPrevented) return false;
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * `caches.match(href)` against the navigation cache. Resolves false when
 * CacheStorage is unavailable, which is the safe answer: the click then goes to
 * the offline hub instead of a browser error page.
 */
export async function isNavigationCached(href: string): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  try {
    return Boolean(await caches.match(href, { ignoreVary: true, ignoreSearch: false }));
  } catch {
    return false;
  }
}
