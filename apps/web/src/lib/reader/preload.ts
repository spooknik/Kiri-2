/**
 * Image preloading. Page images are served with immutable cache headers, so
 * warming them through `new Image()` is enough: by the time the reader turns
 * the page, the browser serves it from the HTTP cache (or, offline, from the
 * service worker's page cache).
 *
 * A module-level set keeps us from re-creating `Image` objects for URLs already
 * requested this session; the browser would dedupe anyway, but the set also
 * keeps the reader from holding references to hundreds of decoded bitmaps.
 */
const requested = new Set<string>();

/** How many pages ahead the reader warms by default. */
export const PRELOAD_AHEAD = 3;

export interface PreloadablePage {
  url: string;
}

/**
 * URLs for the next `count` pages after `fromIndex` (exclusive). Pure, so the
 * caller can test what would be preloaded without touching the DOM.
 */
export function nextPageUrls(
  pages: readonly PreloadablePage[],
  fromIndex: number,
  count = PRELOAD_AHEAD,
): string[] {
  const urls: string[] = [];
  for (let offset = 1; offset <= count; offset += 1) {
    const page = pages[fromIndex + offset];
    if (!page) break;
    urls.push(page.url);
  }
  return urls;
}

/** Fire-and-forget warm-up. No-op on the server and for already-seen URLs. */
export function preloadImages(urls: Iterable<string>): void {
  if (typeof window === "undefined" || typeof window.Image !== "function") return;
  for (const url of urls) {
    if (!url || requested.has(url)) continue;
    requested.add(url);
    const image = new window.Image();
    image.decoding = "async";
    image.src = url;
  }
}

/** Test hook: forget which URLs have been warmed. */
export function resetPreloadCache(): void {
  requested.clear();
}
