/**
 * Manifest ingest against a real database and a real (temporary) DATA_ROOT
 * with real PNG files, because the parts most likely to break — page
 * dimensions from sharp, idempotence, and the "never delete" rules — only show
 * up when the bytes actually exist.
 */
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestUser, resetDatabase } from "../../../test/factories";
import { resetEnvCache } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { toSortTitle } from "@/lib/text";
import { ingestManifest } from "./ingest";
import { chapterDir, manifestPath, writeFileAtomic } from "./store";

const DATA_ROOT = path.resolve(process.cwd(), "data", `test-content-ingest-${process.pid}`);

interface ChapterSpec {
  slug: string;
  images?: number;
  title?: string;
  status?: string;
  chapterOrder?: number;
  number?: number;
  externalId?: string;
  source?: string;
  missingFromSource?: boolean;
  files?: string[];
}

async function seedSeries(title = "Ingest Test"): Promise<string> {
  const user = await createTestUser();
  const series = await prisma.series.create({
    data: { title, sortTitle: toSortTitle(title), createdById: user.id },
    select: { id: true },
  });
  return series.id;
}

function pageName(index: number): string {
  return `${String(index).padStart(3, "0")}.png`;
}

/** `index`-th page is (8 + index) x 12 so the test can tell them apart. */
async function writePages(seriesId: string, slug: string, count: number): Promise<void> {
  const dir = chapterDir(seriesId, slug);
  await mkdir(dir, { recursive: true });
  for (let index = 1; index <= count; index += 1) {
    const png = await sharp({
      create: {
        width: 8 + index,
        height: 12,
        channels: 3,
        background: { r: 10 * index, g: 40, b: 60 },
      },
    })
      .png()
      .toBuffer();
    await writeFile(path.join(dir, pageName(index)), png);
  }
}

function chapterEntry(spec: ChapterSpec): Record<string, unknown> {
  const files = spec.files ?? Array.from({ length: spec.images ?? 0 }, (_, i) => pageName(i + 1));
  return {
    slug: spec.slug,
    title: spec.title ?? spec.slug,
    status: spec.status ?? (files.length > 0 ? "completed" : "pending"),
    ...(spec.chapterOrder === undefined ? {} : { chapterOrder: spec.chapterOrder }),
    ...(spec.number === undefined ? {} : { number: spec.number }),
    ...(spec.externalId === undefined ? {} : { externalId: spec.externalId }),
    ...(spec.source === undefined ? {} : { source: spec.source }),
    ...(spec.missingFromSource === undefined ? {} : { missingFromSource: spec.missingFromSource }),
    imageCount: files.length,
    images: files.map((file, i) => ({ index: i + 1, file })),
  };
}

async function writeManifest(seriesId: string, chapters: ChapterSpec[]): Promise<void> {
  await writeFileAtomic(
    manifestPath(seriesId),
    JSON.stringify({
      version: 2,
      site: "test",
      series: { slug: "ingest-test", title: "Ingest Test" },
      chapters: chapters.map(chapterEntry),
    }),
  );
}

function loadChapters(seriesId: string) {
  return prisma.chapter.findMany({
    where: { seriesId },
    orderBy: { sortIndex: "asc" },
    include: { pages: { orderBy: { index: "asc" } } },
  });
}

beforeAll(() => {
  process.env.DATA_ROOT = DATA_ROOT;
  resetEnvCache();
});

beforeEach(async () => {
  await resetDatabase();
  await rm(DATA_ROOT, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(DATA_ROOT, { recursive: true, force: true });
  delete process.env.DATA_ROOT;
  resetEnvCache();
});

describe("ingestManifest", () => {
  it("creates chapters and pages with real dimensions and updates the counters", async () => {
    const seriesId = await seedSeries();
    await writePages(seriesId, "chapter-1", 2);
    await writePages(seriesId, "chapter-2", 3);
    await writeManifest(seriesId, [
      { slug: "chapter-1", images: 2, chapterOrder: 1 },
      { slug: "chapter-2", images: 3, chapterOrder: 2 },
    ]);

    const result = await ingestManifest(seriesId, { reason: "sync" });

    expect(result.chaptersCreated).toBe(2);
    expect(result.chaptersUpdated).toBe(0);
    expect(result.pagesUpserted).toBe(5);
    expect(result.warnings).toEqual([]);
    expect(result.newlyCompleted.map((chapter) => chapter.slug)).toEqual([
      "chapter-1",
      "chapter-2",
    ]);

    const chapters = await loadChapters(seriesId);
    expect(chapters.map((chapter) => chapter.slug)).toEqual(["chapter-1", "chapter-2"]);
    expect(chapters.map((chapter) => chapter.sortIndex)).toEqual([0, 1]);

    const first = chapters[0];
    expect(first?.status).toBe("COMPLETED");
    expect(first?.origin).toBe("PLUGIN");
    expect(first?.number).toBe(1);
    expect(first?.pageCount).toBe(2);
    expect(first?.pages.map((page) => page.index)).toEqual([1, 2]);
    expect(first?.pages[0]).toMatchObject({ width: 9, height: 12, mime: "image/png" });
    expect(first?.pages[1]).toMatchObject({ width: 10, height: 12 });
    expect(Number(first?.bytes)).toBe(
      (first?.pages ?? []).reduce((total, page) => total + page.bytes, 0),
    );

    const series = await prisma.series.findUniqueOrThrow({ where: { id: seriesId } });
    expect(series.chapterCount).toBe(2);
    expect(series.lastChapterAt).not.toBeNull();
  });

  it("is idempotent: a second run changes nothing and keeps page ids", async () => {
    const seriesId = await seedSeries();
    await writePages(seriesId, "chapter-1", 2);
    await writeManifest(seriesId, [{ slug: "chapter-1", images: 2, chapterOrder: 1 }]);

    await ingestManifest(seriesId);
    const before = await loadChapters(seriesId);
    const seriesBefore = await prisma.series.findUniqueOrThrow({ where: { id: seriesId } });

    const second = await ingestManifest(seriesId);

    expect(second).toMatchObject({
      chaptersCreated: 0,
      chaptersUpdated: 0,
      chaptersMissing: 0,
      pagesUpserted: 0,
      newlyCompleted: [],
    });

    const after = await loadChapters(seriesId);
    expect(after[0]?.pages.map((page) => page.id)).toEqual(before[0]?.pages.map((page) => page.id));
    expect(after[0]?.updatedAt).toEqual(before[0]?.updatedAt);
    const seriesAfter = await prisma.series.findUniqueOrThrow({ where: { id: seriesId } });
    expect(seriesAfter.updatedAt).toEqual(seriesBefore.updatedAt);
  });

  it("flags a chapter that vanished from the manifest without deleting anything", async () => {
    const seriesId = await seedSeries();
    await writePages(seriesId, "chapter-1", 2);
    await writePages(seriesId, "chapter-2", 2);
    await writeManifest(seriesId, [
      { slug: "chapter-1", images: 2, chapterOrder: 1 },
      { slug: "chapter-2", images: 2, chapterOrder: 2 },
    ]);
    await ingestManifest(seriesId);

    await writeManifest(seriesId, [{ slug: "chapter-1", images: 2, chapterOrder: 1 }]);
    const result = await ingestManifest(seriesId);

    expect(result.chaptersMissing).toBe(1);
    const chapters = await loadChapters(seriesId);
    expect(chapters).toHaveLength(2);
    const vanished = chapters.find((chapter) => chapter.slug === "chapter-2");
    expect(vanished?.status).toBe("MISSING_FROM_SOURCE");
    expect(vanished?.pages).toHaveLength(2);

    const series = await prisma.series.findUniqueOrThrow({ where: { id: seriesId } });
    expect(series.chapterCount).toBe(1);

    // Flagging happens once; a later run reports no new losses.
    expect((await ingestManifest(seriesId)).chaptersMissing).toBe(0);
  });

  it("never flags manual or PDF chapters, and honours the source field", async () => {
    const seriesId = await seedSeries();
    await writePages(seriesId, "manual-1", 1);
    await writeManifest(seriesId, [{ slug: "manual-1", images: 1, source: "manual" }]);
    await ingestManifest(seriesId, { reason: "import" });

    expect((await loadChapters(seriesId))[0]?.origin).toBe("MANUAL");

    await writeManifest(seriesId, []);
    const result = await ingestManifest(seriesId);

    expect(result.chaptersMissing).toBe(0);
    expect((await loadChapters(seriesId))[0]?.status).toBe("COMPLETED");
  });

  it("adds and removes pages when the image list changes", async () => {
    const seriesId = await seedSeries();
    await writePages(seriesId, "chapter-1", 3);
    await writeManifest(seriesId, [{ slug: "chapter-1", images: 2 }]);
    await ingestManifest(seriesId);

    const grown = await (async () => {
      await writeManifest(seriesId, [{ slug: "chapter-1", images: 3 }]);
      return ingestManifest(seriesId);
    })();
    expect(grown.pagesUpserted).toBe(1);
    expect(grown.chaptersUpdated).toBe(1);
    expect((await loadChapters(seriesId))[0]?.pageCount).toBe(3);

    await writeManifest(seriesId, [{ slug: "chapter-1", images: 2 }]);
    const shrunk = await ingestManifest(seriesId);
    expect(shrunk.pagesUpserted).toBe(1);
    const chapters = await loadChapters(seriesId);
    expect(chapters[0]?.pageCount).toBe(2);
    expect(chapters[0]?.pages.map((page) => page.index)).toEqual([1, 2]);
  });

  it("reports a chapter as newly completed exactly once", async () => {
    const seriesId = await seedSeries();
    await writeManifest(seriesId, [{ slug: "chapter-1", images: 0, status: "pending" }]);
    const first = await ingestManifest(seriesId);
    expect(first.chaptersCreated).toBe(1);
    expect(first.newlyCompleted).toEqual([]);

    await writePages(seriesId, "chapter-1", 2);
    await writeManifest(seriesId, [{ slug: "chapter-1", images: 2, status: "completed" }]);
    const second = await ingestManifest(seriesId);
    expect(second.newlyCompleted.map((chapter) => chapter.slug)).toEqual(["chapter-1"]);

    const third = await ingestManifest(seriesId);
    expect(third.newlyCompleted).toEqual([]);
  });

  it("orders fractional numbers in place and unnumbered chapters last", async () => {
    const seriesId = await seedSeries();
    for (const slug of ["chapter-2", "chapter-1-5", "chapter-1", "bonus-art"]) {
      await writePages(seriesId, slug, 1);
    }
    await writeManifest(seriesId, [
      { slug: "chapter-2", images: 1 },
      { slug: "bonus-art", images: 1 },
      { slug: "chapter-1-5", images: 1 },
      { slug: "chapter-1", images: 1 },
    ]);

    await ingestManifest(seriesId);

    const chapters = await loadChapters(seriesId);
    expect(chapters.map((chapter) => chapter.slug)).toEqual([
      "chapter-1",
      "chapter-1-5",
      "chapter-2",
      "bonus-art",
    ]);
    expect(chapters.map((chapter) => chapter.number)).toEqual([1, 1.5, 2, null]);
    expect(chapters.map((chapter) => chapter.sortIndex)).toEqual([0, 1, 2, 3]);
  });

  it("matches by externalId when the slug changed upstream", async () => {
    const seriesId = await seedSeries();
    await writePages(seriesId, "old-slug", 1);
    await writeManifest(seriesId, [{ slug: "old-slug", images: 1, externalId: "ext-7" }]);
    await ingestManifest(seriesId);
    const before = await loadChapters(seriesId);

    await writePages(seriesId, "new-slug", 1);
    await writeManifest(seriesId, [{ slug: "new-slug", images: 1, externalId: "ext-7" }]);
    const result = await ingestManifest(seriesId);

    expect(result.chaptersCreated).toBe(0);
    const after = await loadChapters(seriesId);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[0]?.slug).toBe("new-slug");
  });

  it("fails a completed chapter that has no pages", async () => {
    const seriesId = await seedSeries();
    await writeManifest(seriesId, [{ slug: "chapter-1", images: 0, status: "completed" }]);

    await ingestManifest(seriesId);

    const chapters = await loadChapters(seriesId);
    expect(chapters[0]?.status).toBe("FAILED");
    expect(chapters[0]?.lastError).toBe("no pages");
    const series = await prisma.series.findUniqueOrThrow({ where: { id: seriesId } });
    expect(series.chapterCount).toBe(0);
  });

  it("skips images whose file is missing on disk and warns", async () => {
    const seriesId = await seedSeries();
    await writePages(seriesId, "chapter-1", 1);
    await writeManifest(seriesId, [{ slug: "chapter-1", files: [pageName(1), pageName(2)] }]);

    const result = await ingestManifest(seriesId);

    expect(result.warnings.some((line) => line.includes("missing on disk"))).toBe(true);
    const chapters = await loadChapters(seriesId);
    expect(chapters[0]?.pageCount).toBe(1);
    expect(chapters[0]?.status).toBe("COMPLETED");
  });

  it("throws when the manifest is missing", async () => {
    const seriesId = await seedSeries();
    await expect(ingestManifest(seriesId)).rejects.toThrow(/No manifest/);
  });
});
