import { describe, expect, it } from "vitest";
import type { InfiniteData } from "@tanstack/react-query";
import type { LibraryPage, ReadingStatus, SeriesSummary } from "@/lib/contracts";
import { flattenLibraryPages } from "./use-library";

function makeSeries(id: string): SeriesSummary {
  return {
    id,
    title: `Series ${id}`,
    originalTitle: null,
    mediaType: "MANGA",
    visibility: "SHARED",
    isAdult: false,
    isBookClub: false,
    coverUrl: null,
    tags: [],
    chapterCount: 0,
    lastChapterAt: null,
    totalChapters: null,
    createdBy: { id: "user-1", displayName: "Alice" },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    entry: null,
    readerCount: 1,
    canEdit: true,
  };
}

const EMPTY_STATUS_COUNTS: Record<ReadingStatus, number> = {
  READING: 0,
  COMPLETED: 0,
  ON_HOLD: 0,
  DROPPED: 0,
  PLAN_TO_READ: 0,
};

function makePage(overrides: Partial<LibraryPage> = {}): LibraryPage {
  return {
    items: [],
    nextCursor: null,
    total: 0,
    statusCounts: EMPTY_STATUS_COUNTS,
    ...overrides,
  };
}

describe("flattenLibraryPages", () => {
  it("returns an empty array when there is no data", () => {
    expect(flattenLibraryPages(undefined)).toEqual([]);
  });

  it("returns an empty array when there are pages but no items", () => {
    const data: InfiniteData<LibraryPage> = { pages: [makePage()], pageParams: [undefined] };
    expect(flattenLibraryPages(data)).toEqual([]);
  });

  it("flattens items across pages in order", () => {
    const data: InfiniteData<LibraryPage> = {
      pages: [
        makePage({ items: [makeSeries("a"), makeSeries("b")], nextCursor: "cursor-1" }),
        makePage({ items: [makeSeries("c")] }),
      ],
      pageParams: [undefined, "cursor-1"],
    };

    expect(flattenLibraryPages(data).map((s) => s.id)).toEqual(["a", "b", "c"]);
  });
});
