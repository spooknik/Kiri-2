/**
 * Real-DB, real-file integration test for optimizeChapter: creates a
 * series/chapter/pages with actual PNGs (via sharp) under a temp DATA_ROOT,
 * inserts Page rows directly with prisma, runs the optimizer, and asserts
 * the files on disk, the updated rows, and that Page ids/index never move.
 */
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestUser, resetDatabase } from "../../../test/factories";
import { resetEnvCache } from "@/lib/env";
import { optimizeChapter } from "@/lib/media/optimizer";
import { prisma } from "@/lib/prisma";
import { toSortTitle } from "@/lib/text";

const DATA_ROOT = path.resolve(process.cwd(), "data", `test-media-optimizer-${process.pid}`);

beforeAll(() => {
  process.env.DATA_ROOT = DATA_ROOT;
  resetEnvCache();
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await rm(DATA_ROOT, { recursive: true, force: true });
  delete process.env.DATA_ROOT;
  resetEnvCache();
});

/** Random-noise raster: lossless PNG stores it near-incompressibly, so a lossy WebP re-encode reliably shrinks it. */
async function writeNoisePng(filePath: string, width: number, height: number): Promise<number> {
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let i = 0; i < raw.length; i += 1) raw[i] = Math.floor(Math.random() * 256);
  await sharp(raw, { raw: { width, height, channels } }).png().toFile(filePath);
  return (await stat(filePath)).size;
}

async function chapterDir(seriesId: string, slug: string): Promise<string> {
  const dir = path.join(DATA_ROOT, "library", seriesId, slug);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function seedSeriesAndChapter(): Promise<{
  seriesId: string;
  chapterId: string;
  slug: string;
}> {
  const user = await createTestUser();
  const series = await prisma.series.create({
    data: { title: "Test Series", sortTitle: toSortTitle("Test Series"), createdById: user.id },
    select: { id: true },
  });
  const slug = "manual-1";
  const chapter = await prisma.chapter.create({
    data: {
      seriesId: series.id,
      slug,
      title: "Chapter 1",
      status: "COMPLETED",
      origin: "MANUAL",
      sortIndex: 0,
      pageCount: 0,
    },
    select: { id: true },
  });
  return { seriesId: series.id, chapterId: chapter.id, slug };
}

describe("optimizeChapter", () => {
  it("re-encodes non-webp pages, updates rows, recomputes Chapter.bytes, and leaves ids/index untouched", async () => {
    const { seriesId, chapterId, slug } = await seedSeriesAndChapter();
    const dir = await chapterDir(seriesId, slug);

    const page1Bytes = await writeNoisePng(path.join(dir, "001.png"), 200, 300);
    const page2Bytes = await writeNoisePng(path.join(dir, "002.jpg"), 180, 260);
    // Pre-existing webp page must be left completely alone.
    await sharp(Buffer.alloc(50 * 50 * 3, 128), { raw: { width: 50, height: 50, channels: 3 } })
      .webp({ quality: 80 })
      .toFile(path.join(dir, "003.webp"));
    const page3Stat = await stat(path.join(dir, "003.webp"));

    const page1 = await prisma.page.create({
      data: { chapterId, index: 1, file: "001.png", bytes: page1Bytes, mime: "image/png" },
    });
    const page2 = await prisma.page.create({
      data: { chapterId, index: 2, file: "002.jpg", bytes: page2Bytes, mime: "image/jpeg" },
    });
    const page3 = await prisma.page.create({
      data: { chapterId, index: 3, file: "003.webp", bytes: page3Stat.size, mime: "image/webp" },
    });

    const result = await optimizeChapter({ chapterId, format: "WEBP", quality: 80 });

    expect(result.pagesConverted).toBe(2);
    expect(result.bytesBefore).toBe(page1Bytes + page2Bytes);
    expect(result.bytesAfter).toBeGreaterThan(0);
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);

    // Old originals are gone; only webp files remain.
    const files = (await readdir(dir)).sort();
    expect(files).toEqual(["001.webp", "002.webp", "003.webp"]);

    const [row1, row2, row3] = await Promise.all([
      prisma.page.findUniqueOrThrow({ where: { id: page1.id } }),
      prisma.page.findUniqueOrThrow({ where: { id: page2.id } }),
      prisma.page.findUniqueOrThrow({ where: { id: page3.id } }),
    ]);

    // ids and index are never touched — notes anchor to them.
    expect(row1.id).toBe(page1.id);
    expect(row1.index).toBe(1);
    expect(row2.id).toBe(page2.id);
    expect(row2.index).toBe(2);
    expect(row3.id).toBe(page3.id);
    expect(row3.index).toBe(3);

    expect(row1.file).toBe("001.webp");
    expect(row1.mime).toBe("image/webp");
    expect(row1.bytes).toBeGreaterThan(0);
    expect(row1.bytes).toBeLessThan(page1Bytes);
    expect(row1.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row1.width).toBe(200);
    expect(row1.height).toBe(300);

    expect(row2.file).toBe("002.webp");
    expect(row2.mime).toBe("image/webp");

    // Untouched: same file name, same byte count, same content.
    expect(row3.file).toBe("003.webp");
    expect(row3.bytes).toBe(page3Stat.size);
    const finalBuffer = await readFile(path.join(dir, "003.webp"));
    expect(finalBuffer.byteLength).toBe(page3Stat.size);

    const finalChapter = await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } });
    const expectedTotal = row1.bytes + row2.bytes + row3.bytes;
    expect(finalChapter.bytes).toBe(BigInt(expectedTotal));
  });

  it("is a no-op (no writes) when every page is already webp", async () => {
    const { seriesId, chapterId, slug } = await seedSeriesAndChapter();
    const dir = await chapterDir(seriesId, slug);
    await sharp(Buffer.alloc(20 * 20 * 3, 10), { raw: { width: 20, height: 20, channels: 3 } })
      .webp({ quality: 80 })
      .toFile(path.join(dir, "001.webp"));
    const original = await stat(path.join(dir, "001.webp"));
    await prisma.page.create({
      data: { chapterId, index: 1, file: "001.webp", bytes: original.size, mime: "image/webp" },
    });

    const result = await optimizeChapter({ chapterId, format: "WEBP", quality: 80 });

    expect(result).toEqual({ pagesConverted: 0, bytesBefore: 0, bytesAfter: 0 });
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } });
    expect(chapter.bytes).toBe(0n);
  });

  it("reports progress once per page in order", async () => {
    const { seriesId, chapterId, slug } = await seedSeriesAndChapter();
    const dir = await chapterDir(seriesId, slug);
    await writeNoisePng(path.join(dir, "001.png"), 40, 40);
    await writeNoisePng(path.join(dir, "002.png"), 40, 40);
    await prisma.page.createMany({
      data: [
        { chapterId, index: 1, file: "001.png", bytes: 1 },
        { chapterId, index: 2, file: "002.png", bytes: 1 },
      ],
    });

    const calls: Array<[number, number]> = [];
    await optimizeChapter({
      chapterId,
      format: "WEBP",
      quality: 80,
      onProgress: (current, total) => {
        calls.push([current, total]);
      },
    });

    expect(calls).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});
