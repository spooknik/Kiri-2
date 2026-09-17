import { describe, expect, it } from "vitest";
import {
  API_CACHE,
  chapterDetailPath,
  chapterListPath,
  isCacheableApiPath,
  isChapterDetailPath,
  isPageImagePath,
  isSeriesCoverPath,
  offlineManifestPath,
  shellCacheKey,
  SHELL_ROUTES,
  OFFLINE_CACHES,
  PAGES_CACHE,
  READER_CONTENT_CACHE,
  READER_IMAGES_CACHE,
} from "@/lib/offline/cache-names";

/**
 * These constants are the contract between `src/app/sw.ts` (compiled
 * separately, so it is never part of a normal type-check of the app) and the
 * downloader. Pinning the literals here is what makes a rename in one place
 * fail loudly instead of silently splitting the caches in two.
 */
describe("cache names", () => {
  it("are the four the service worker registers", () => {
    expect(OFFLINE_CACHES).toEqual(["pages", "api", "reader-images", "reader-content"]);
    expect([PAGES_CACHE, API_CACHE, READER_IMAGES_CACHE, READER_CONTENT_CACHE]).toEqual([
      ...OFFLINE_CACHES,
    ]);
  });
});

describe("path matchers", () => {
  it("recognises page images and series covers", () => {
    expect(isPageImagePath("/api/pages/abc-123/image")).toBe(true);
    expect(isPageImagePath("/api/pages/abc-123/image/extra")).toBe(false);
    expect(isPageImagePath("/api/pages/abc-123")).toBe(false);
    expect(isSeriesCoverPath("/api/series/abc/cover")).toBe(true);
    expect(isSeriesCoverPath("/api/series/abc/chapters")).toBe(false);
  });

  it("recognises the chapter detail route but not its sub-routes", () => {
    expect(isChapterDetailPath("/api/chapters/abc")).toBe(true);
    expect(isChapterDetailPath("/api/chapters/abc/read")).toBe(false);
    expect(isChapterDetailPath("/api/chapters")).toBe(false);
  });

  it("caches the reader/library JSON reads but never image bytes", () => {
    expect(isCacheableApiPath("/api/library")).toBe(true);
    expect(isCacheableApiPath("/api/library/continue")).toBe(true);
    expect(isCacheableApiPath("/api/notifications")).toBe(true);
    expect(isCacheableApiPath("/api/series/abc/chapters")).toBe(true);
    expect(isCacheableApiPath("/api/chapters/abc/read")).toBe(true);

    // Images and covers belong to reader-images (CacheFirst), not api.
    expect(isCacheableApiPath("/api/series/abc/cover")).toBe(false);
    expect(isCacheableApiPath("/api/pages/abc/image")).toBe(false);

    // Everything else falls through to defaultCache.
    expect(isCacheableApiPath("/api/auth/session")).toBe(false);
    expect(isCacheableApiPath("/api/jobs")).toBe(false);
    expect(isCacheableApiPath("/api/sync")).toBe(false);
  });
});

describe("shellCacheKey", () => {
  it("collapses every /read variant onto one cache key", () => {
    expect(SHELL_ROUTES).toContain("/read");
    const bare = shellCacheKey(new URL("https://kiri.test/read"));
    expect(shellCacheKey(new URL("https://kiri.test/read?series=a&chapter=b&page=3"))).toBe(bare);
    expect(bare).toBe("https://kiri.test/read");
  });

  it("leaves every other route keyed by its full URL", () => {
    expect(shellCacheKey(new URL("https://kiri.test/series/abc?tab=notes"))).toBe(
      "https://kiri.test/series/abc?tab=notes",
    );
    expect(shellCacheKey(new URL("https://kiri.test/"))).toBe("https://kiri.test/");
  });
});

describe("url builders", () => {
  it("match the URLs the reader and the manifest route actually use", () => {
    expect(chapterDetailPath("c1")).toBe("/api/chapters/c1");
    expect(chapterListPath("s1")).toBe("/api/series/s1/chapters");
    expect(offlineManifestPath("s1")).toBe("/api/series/s1/offline-manifest");
    expect(isChapterDetailPath(chapterDetailPath("c1"))).toBe(true);
    expect(isCacheableApiPath(chapterListPath("s1"))).toBe(true);
  });
});
