import { describe, expect, it } from "vitest";
import type { OfflineManifest } from "@/lib/contracts/offline";
import {
  evaluateQuota,
  QUOTA_HEADROOM,
  selectChapters,
  synthesizeChapterDetail,
} from "@/lib/offline/downloads";

function manifest(): OfflineManifest {
  const chapter = (id: string, index: number, pages: number) => ({
    id,
    slug: `chapter-${index}`,
    title: `Chapter ${index}`,
    number: index,
    sortIndex: index,
    pageCount: pages,
    bytes: pages * 100,
    pages: Array.from({ length: pages }, (_, i) => ({
      id: `${id}-p${i + 1}`,
      index: i + 1,
      url: `/api/pages/${id}-p${i + 1}/image`,
      width: 800,
      height: 1200,
      bytes: 100,
    })),
  });

  return {
    series: {
      id: "series-1",
      title: "Test Series",
      mediaType: "MANHWA",
      coverUrl: "/api/series/series-1/cover?v=7",
    },
    generatedAt: "2026-01-01T00:00:00.000Z",
    chapters: [chapter("c1", 1, 3), chapter("c2", 2, 2), chapter("c3", 3, 4)],
    totalBytes: 900,
  };
}

describe("evaluateQuota", () => {
  it("allows a download that fits with 10% headroom", () => {
    const check = evaluateQuota(1_000, { quota: 10_000, usage: 8_800 });
    expect(check.ok).toBe(true);
    expect(check.available).toBe(1_200);
  });

  it("refuses a download that fits only without the headroom", () => {
    // 1 050 free for a 1 000 byte download: enough raw, not enough headroom.
    const check = evaluateQuota(1_000, { quota: 10_000, usage: 8_950 });
    expect(check.available).toBe(1_050);
    expect(1_000 * QUOTA_HEADROOM).toBe(1_100);
    expect(check.ok).toBe(false);
  });

  it("allows the download when the browser withholds an estimate", () => {
    expect(evaluateQuota(5_000, null).ok).toBe(true);
    expect(evaluateQuota(5_000, {}).ok).toBe(true);
    expect(evaluateQuota(5_000, { quota: 10 }).ok).toBe(true);
    expect(evaluateQuota(5_000, null).available).toBeNull();
  });

  it("refuses when nothing is left at all", () => {
    expect(evaluateQuota(1, { quota: 100, usage: 100 }).ok).toBe(false);
  });
});

describe("selectChapters", () => {
  it("returns the manifest untouched when no subset is given", () => {
    const full = manifest();
    expect(selectChapters(full)).toBe(full);
  });

  it("keeps only the chosen chapters and recomputes the byte total", () => {
    const subset = selectChapters(manifest(), ["c1", "c3"]);
    expect(subset.chapters.map((chapter) => chapter.id)).toEqual(["c1", "c3"]);
    expect(subset.totalBytes).toBe(300 + 400);
    expect(subset.series).toEqual(manifest().series);
  });

  it("ignores ids that are not in the manifest", () => {
    const subset = selectChapters(manifest(), ["c2", "nope"]);
    expect(subset.chapters).toHaveLength(1);
    expect(subset.totalBytes).toBe(200);
  });
});

describe("synthesizeChapterDetail", () => {
  it("produces the shape the reader fetches, with neighbours inside the download", () => {
    const detail = synthesizeChapterDetail(manifest(), 1);
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe("c2");
    expect(detail?.seriesId).toBe("series-1");
    expect(detail?.seriesTitle).toBe("Test Series");
    expect(detail?.status).toBe("COMPLETED");
    expect(detail?.prev?.id).toBe("c1");
    expect(detail?.next?.id).toBe("c3");
    expect(detail?.pages).toHaveLength(2);
    expect(detail?.pages[0]).toMatchObject({
      index: 1,
      url: "/api/pages/c2-p1/image",
      width: 800,
      height: 1200,
    });
  });

  it("has no previous chapter at the start and no next at the end", () => {
    expect(synthesizeChapterDetail(manifest(), 0)?.prev).toBeNull();
    expect(synthesizeChapterDetail(manifest(), 2)?.next).toBeNull();
  });

  it("returns null for an index outside the manifest", () => {
    expect(synthesizeChapterDetail(manifest(), 9)).toBeNull();
  });
});
