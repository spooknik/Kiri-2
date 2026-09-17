/**
 * Every rule in the plan's V1 → V2 mapping table, one assertion at a time.
 * These are the transforms an integration test can only check in aggregate.
 */
import { describe, expect, it } from "vitest";
import {
  COOKIE_MAX_AGE_DAYS,
  isCookieStale,
  isLocalV1Site,
  mapAutoSyncMode,
  mapChapterOrigin,
  mapCookie,
  mapMediaType,
  mapNotificationType,
  mapReadingStatus,
  mapRipJobKind,
  mapRipJobStatus,
  mapRipStatus,
  notificationCutoff,
  planCover,
  rewriteSeriesLink,
  ripSlugFromOutputDir,
  seriesMatchKey,
  stripVolatileCookies,
} from "./mapping";

const NOW = new Date("2026-01-20T12:00:00.000Z");
const days = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe("mapMediaType", () => {
  it("maps the five original V1 enum values 1:1", () => {
    for (const value of ["MANGA", "MANHWA", "MANHUA", "LIGHT_NOVEL", "BOOK"] as const) {
      expect(mapMediaType(value)).toEqual({ mediaType: value, extraTag: null });
    }
  });

  it("accepts COMIC and NOVEL, which only exist in V2", () => {
    expect(mapMediaType("COMIC").mediaType).toBe("COMIC");
    expect(mapMediaType("NOVEL").mediaType).toBe("NOVEL");
  });

  it("normalises spelling before matching", () => {
    expect(mapMediaType("light novel").mediaType).toBe("LIGHT_NOVEL");
    expect(mapMediaType(" Manhwa ").mediaType).toBe("MANHWA");
    expect(mapMediaType("light-novel").mediaType).toBe("LIGHT_NOVEL");
  });

  it("falls back to OTHER and keeps the raw value as a tag", () => {
    expect(mapMediaType("Doujinshi")).toEqual({ mediaType: "OTHER", extraTag: "Doujinshi" });
  });

  it("treats an empty media type as the V1 column default", () => {
    expect(mapMediaType(null)).toEqual({ mediaType: "MANGA", extraTag: null });
    expect(mapMediaType("  ")).toEqual({ mediaType: "MANGA", extraTag: null });
  });
});

describe("mapReadingStatus / mapAutoSyncMode", () => {
  it("passes through the shared vocabulary", () => {
    expect(mapReadingStatus("READING")).toBe("READING");
    expect(mapReadingStatus("PLAN_TO_READ")).toBe("PLAN_TO_READ");
    expect(mapAutoSyncMode("CUSTOM")).toBe("CUSTOM");
  });

  it("falls back to the schema default for anything unknown", () => {
    expect(mapReadingStatus("WHATEVER")).toBe("PLAN_TO_READ");
    expect(mapReadingStatus(null)).toBe("PLAN_TO_READ");
    expect(mapAutoSyncMode(null)).toBe("INHERIT");
  });
});

describe("mapRipStatus", () => {
  it("maps RipStatus to SourceStatus when a plugin is installed", () => {
    expect(mapRipStatus("UNSUPPORTED", true)).toBe("UNCONFIGURED");
    expect(mapRipStatus("PENDING", true)).toBe("PENDING");
    expect(mapRipStatus("RUNNING", true)).toBe("PENDING");
    expect(mapRipStatus("READY", true)).toBe("READY");
    expect(mapRipStatus("FAILED", true)).toBe("FAILED");
  });

  it("is NEEDS_PLUGIN whenever no plugin handles the site", () => {
    for (const status of ["UNSUPPORTED", "PENDING", "RUNNING", "READY", "FAILED"]) {
      expect(mapRipStatus(status, false)).toBe("NEEDS_PLUGIN");
    }
  });
});

describe("isLocalV1Site", () => {
  it("knows the two sites that never had a ripper", () => {
    expect(isLocalV1Site("pdf")).toBe(true);
    expect(isLocalV1Site("manual")).toBe(true);
    expect(isLocalV1Site("MANUAL")).toBe(true);
    expect(isLocalV1Site("mangadex")).toBe(false);
    expect(isLocalV1Site(null)).toBe(false);
  });
});

describe("ripSlugFromOutputDir", () => {
  it("takes the basename of a POSIX or Windows path", () => {
    expect(ripSlugFromOutputDir("/data/rips/mangadex/solo-leveling")).toBe("solo-leveling");
    expect(ripSlugFromOutputDir("D:\\kiri\\data\\rips\\manual\\abc-123")).toBe("abc-123");
  });

  it("ignores trailing separators and empty input", () => {
    expect(ripSlugFromOutputDir("/data/rips/pdf/xyz/")).toBe("xyz");
    expect(ripSlugFromOutputDir("")).toBeNull();
    expect(ripSlugFromOutputDir(null)).toBeNull();
  });
});

describe("stripVolatileCookies", () => {
  it("removes Cloudflare's fingerprint-bound cookies", () => {
    expect(stripVolatileCookies("cf_clearance=abc; __cf_bm=xyz; _cfuvid=q; other=1")).toBe(
      "cf_clearance=abc; other=1",
    );
  });

  it("removes every cf_chl_ challenge cookie", () => {
    expect(stripVolatileCookies("cf_chl_2=a; cf_chl_rc_ni=b; keep=c")).toBe("keep=c");
  });

  it("leaves a bare cf_clearance value alone", () => {
    expect(stripVolatileCookies("justthevalue")).toBe("justthevalue");
  });
});

describe("isCookieStale", () => {
  it("is fresh inside the window and stale outside it", () => {
    expect(isCookieStale(days(1), NOW)).toBe(false);
    expect(isCookieStale(days(COOKIE_MAX_AGE_DAYS - 1), NOW)).toBe(false);
    expect(isCookieStale(days(COOKIE_MAX_AGE_DAYS + 1), NOW)).toBe(true);
  });

  it("treats an undated cookie as stale (V1's own epoch-0 rule)", () => {
    expect(isCookieStale(null, NOW)).toBe(true);
    expect(isCookieStale(undefined, NOW)).toBe(true);
  });
});

describe("mapCookie", () => {
  it("keeps a fresh cookie with its User-Agent, stripped", () => {
    expect(mapCookie("cf_clearance=x; __cf_bm=y", "Mozilla/5.0", days(2), NOW)).toEqual({
      cookie: "cf_clearance=x",
      userAgent: "Mozilla/5.0",
      dropped: null,
    });
  });

  it("drops a stale cookie together with its User-Agent", () => {
    expect(mapCookie("cf_clearance=x", "Mozilla/5.0", days(30), NOW)).toEqual({
      cookie: null,
      userAgent: null,
      dropped: "stale",
    });
  });

  it("reports an empty cookie separately from a stale one", () => {
    expect(mapCookie(null, "Mozilla/5.0", days(1), NOW).dropped).toBe("empty");
    expect(mapCookie("   ", null, days(1), NOW).dropped).toBe("empty");
  });

  it("drops a cookie that is nothing but volatile names", () => {
    expect(mapCookie("__cf_bm=y; _cfuvid=z", "UA", days(1), NOW)).toEqual({
      cookie: null,
      userAgent: null,
      dropped: "empty",
    });
  });
});

describe("mapNotificationType", () => {
  it("renames the rip types and passes the rest through", () => {
    expect(mapNotificationType("RIP_COMPLETED")).toBe("SYNC_COMPLETED");
    expect(mapNotificationType("RIP_FAILED")).toBe("SYNC_FAILED");
    expect(mapNotificationType("BOOK_CLUB_ADDED")).toBe("BOOK_CLUB_ADDED");
    expect(mapNotificationType("NEW_CHAPTER")).toBe("NEW_CHAPTER");
  });

  it("is null for a type V1 never had", () => {
    expect(mapNotificationType("PLUGIN_INSTALLED")).toBeNull();
    expect(mapNotificationType(null)).toBeNull();
  });
});

describe("rewriteSeriesLink", () => {
  const resolve = (id: string) => (id === "v1-a" ? "v2-a" : undefined);

  it("rewrites the series id", () => {
    expect(rewriteSeriesLink("/series/v1-a", resolve)).toBe("/series/v2-a");
  });

  it("keeps the query string V1 attached", () => {
    expect(rewriteSeriesLink("/series/v1-a?fix=cookie", resolve)).toBe("/series/v2-a?fix=cookie");
  });

  it("drops a deeper path that V2 has no route for", () => {
    expect(rewriteSeriesLink("/series/v1-a/reader", resolve)).toBe("/series/v2-a");
  });

  it("nulls a link whose series did not import", () => {
    expect(rewriteSeriesLink("/series/unknown", resolve)).toBeNull();
  });

  it("nulls anything that is not a series link", () => {
    expect(rewriteSeriesLink("/notifications", resolve)).toBeNull();
    expect(rewriteSeriesLink("https://example.com/series/v1-a", resolve)).toBeNull();
    expect(rewriteSeriesLink(null, resolve)).toBeNull();
    expect(rewriteSeriesLink("", resolve)).toBeNull();
  });
});

describe("mapRipJobKind / mapRipJobStatus", () => {
  it("renames the rip kinds", () => {
    expect(mapRipJobKind("SYNC")).toBe("SOURCE_SYNC");
    expect(mapRipJobKind("VERIFY")).toBe("SOURCE_VERIFY");
    expect(mapRipJobKind("OPTIMIZE")).toBe("OPTIMIZE");
    expect(mapRipJobKind("PDF_IMPORT")).toBe("PDF_IMPORT");
    expect(mapRipJobKind("NOPE")).toBeNull();
  });

  it("accepts terminal statuses only", () => {
    expect(mapRipJobStatus("SUCCEEDED")).toBe("SUCCEEDED");
    expect(mapRipJobStatus("FAILED")).toBe("FAILED");
    expect(mapRipJobStatus("CANCELLED")).toBe("CANCELLED");
    expect(mapRipJobStatus("QUEUED")).toBeNull();
    expect(mapRipJobStatus("RUNNING")).toBeNull();
  });
});

describe("planCover", () => {
  it("recognises the V1 local cover route", () => {
    expect(planCover("/api/series/abc/cover", "abc")).toEqual({ kind: "local", v1SeriesId: "abc" });
  });

  it("does not treat another series' cover route as local", () => {
    expect(planCover("/api/series/other/cover", "abc")).toEqual({ kind: "none" });
  });

  it("records a remote URL without fetching it", () => {
    expect(planCover("https://cdn.example.com/a.jpg", "abc")).toEqual({
      kind: "remote",
      url: "https://cdn.example.com/a.jpg",
    });
  });

  it("is none for an empty or unusable value", () => {
    expect(planCover(null, "abc")).toEqual({ kind: "none" });
    expect(planCover("/static/x.png", "abc")).toEqual({ kind: "none" });
  });
});

describe("mapChapterOrigin", () => {
  it("mirrors what ingest does with manifest `source`", () => {
    expect(mapChapterOrigin("manual")).toBe("MANUAL");
    expect(mapChapterOrigin("pdf")).toBe("PDF");
    expect(mapChapterOrigin(undefined)).toBe("PLUGIN");
    expect(mapChapterOrigin("mangadex")).toBe("PLUGIN");
  });
});

describe("seriesMatchKey / notificationCutoff", () => {
  it("keys the title fallback case-insensitively per creator", () => {
    expect(seriesMatchKey(" Solo Leveling ", "u1")).toBe(seriesMatchKey("solo leveling", "u1"));
    expect(seriesMatchKey("Solo Leveling", "u1")).not.toBe(seriesMatchKey("Solo Leveling", "u2"));
  });

  it("puts the notification cutoff 30 days back", () => {
    expect(notificationCutoff(NOW).toISOString()).toBe("2025-12-21T12:00:00.000Z");
  });
});
