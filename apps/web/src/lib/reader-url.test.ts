import { describe, expect, it } from "vitest";
import type { ChapterListItem, ReadingPositionView } from "./contracts/content";
import { buildContinueReadingHref, buildReadHref } from "./reader-url";

function makeChapter(overrides: Partial<ChapterListItem> = {}): ChapterListItem {
  return {
    id: "chapter-1",
    slug: "chapter-1",
    title: "Chapter 1",
    number: 1,
    pageCount: 10,
    volume: null,
    status: "COMPLETED",
    origin: "MANUAL",
    bytes: 100,
    sourceUrl: null,
    releaseDate: null,
    downloadedAt: null,
    sortIndex: 0,
    read: false,
    readAt: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildReadHref", () => {
  it("builds series+chapter without a page when page is omitted", () => {
    expect(buildReadHref("series-1", "chapter-1")).toBe("/read?series=series-1&chapter=chapter-1");
  });

  it("includes page when given", () => {
    expect(buildReadHref("series-1", "chapter-1", 5)).toBe(
      "/read?series=series-1&chapter=chapter-1&page=5",
    );
  });
});

describe("buildContinueReadingHref", () => {
  it("uses the saved position's chapter and pageIndex + 1 when present", () => {
    const position: ReadingPositionView = {
      chapterId: "chapter-2",
      pageIndex: 4,
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    expect(buildContinueReadingHref("series-1", position, [])).toBe(
      "/read?series=series-1&chapter=chapter-2&page=5",
    );
  });

  it("falls back to the first unread readable chapter (by sortIndex) at page 1 when there's no position", () => {
    const chapters = [
      makeChapter({ id: "c1", sortIndex: 0, read: true }),
      makeChapter({ id: "c3", sortIndex: 2, read: false }),
      makeChapter({ id: "c2", sortIndex: 1, read: false }),
    ];
    expect(buildContinueReadingHref("series-1", null, chapters)).toBe(
      "/read?series=series-1&chapter=c2&page=1",
    );
  });

  it("falls back to the first readable chapter when every chapter is already read", () => {
    const chapters = [
      makeChapter({ id: "c1", sortIndex: 0, read: true }),
      makeChapter({ id: "c2", sortIndex: 1, read: true }),
    ];
    expect(buildContinueReadingHref("series-1", null, chapters)).toBe(
      "/read?series=series-1&chapter=c1&page=1",
    );
  });

  it("ignores chapters that aren't readable (not COMPLETED, or no pages)", () => {
    const chapters = [
      makeChapter({ id: "c1", status: "PENDING", read: false }),
      makeChapter({ id: "c2", status: "COMPLETED", pageCount: 0, read: false }),
    ];
    expect(buildContinueReadingHref("series-1", null, chapters)).toBeNull();
  });

  it("returns null when there are no chapters at all", () => {
    expect(buildContinueReadingHref("series-1", null, [])).toBeNull();
  });
});
