import { describe, expect, it } from "vitest";
import type { OfflineSeriesRow } from "@/lib/offline/catalog";
import { reconcileRow, rowChanged, type ChapterPresence } from "@/lib/offline/reconcile";

function row(overrides: Partial<OfflineSeriesRow> = {}): OfflineSeriesRow {
  return {
    seriesId: "series-1",
    title: "Test Series",
    coverUrl: "/api/series/series-1/cover?v=1",
    chapters: [
      { id: "c1", title: "Chapter 1", number: 1, pageCount: 3, bytes: 300, state: "ready" },
      { id: "c2", title: "Chapter 2", number: 2, pageCount: 3, bytes: 300, state: "ready" },
    ],
    totalBytes: 600,
    downloadedBytes: 600,
    state: "ready",
    updatedAt: 1,
    error: null,
    ...overrides,
  };
}

const present = (id: string): ChapterPresence => ({
  chapterId: id,
  hasContent: true,
  hasImages: true,
});

describe("reconcileRow", () => {
  it("leaves a fully cached series alone", () => {
    const before = row();
    const after = reconcileRow(before, [present("c1"), present("c2")]);
    expect(after.state).toBe("ready");
    expect(after.chapters.map((chapter) => chapter.state)).toEqual(["ready", "ready"]);
    expect(rowChanged(before, after)).toBe(false);
  });

  it("marks a series partial when one chapter's images were evicted", () => {
    const before = row();
    const after = reconcileRow(before, [
      present("c1"),
      { chapterId: "c2", hasContent: true, hasImages: false },
    ]);
    expect(after.chapters.map((chapter) => chapter.state)).toEqual(["ready", "partial"]);
    expect(after.state).toBe("partial");
    expect(after.error).toMatch(/Some chapters/);
    expect(rowChanged(before, after)).toBe(true);
  });

  it("treats a missing chapter payload as partial even when the images survive", () => {
    const after = reconcileRow(row(), [
      { chapterId: "c1", hasContent: false, hasImages: true },
      present("c2"),
    ]);
    expect(after.chapters[0]?.state).toBe("partial");
    expect(after.state).toBe("partial");
  });

  it("falls back to error when nothing is left in the cache", () => {
    const after = reconcileRow(row(), []);
    expect(after.chapters.every((chapter) => chapter.state === "partial")).toBe(true);
    expect(after.state).toBe("error");
    expect(after.error).toMatch(/removed by the browser/);
  });

  it("recovers a row that was left partial once the bytes are back", () => {
    const before = row({
      state: "partial",
      error: "Some chapters were removed by the browser.",
      chapters: [
        { id: "c1", title: "Chapter 1", number: 1, pageCount: 3, bytes: 300, state: "partial" },
        { id: "c2", title: "Chapter 2", number: 2, pageCount: 3, bytes: 300, state: "ready" },
      ],
    });
    const after = reconcileRow(before, [present("c1"), present("c2")]);
    expect(after.state).toBe("ready");
    expect(after.error).toBeNull();
    expect(rowChanged(before, after)).toBe(true);
  });

  it("reports an empty catalog row as an error rather than 'ready'", () => {
    const after = reconcileRow(row({ chapters: [] }), []);
    expect(after.state).toBe("error");
  });
});
