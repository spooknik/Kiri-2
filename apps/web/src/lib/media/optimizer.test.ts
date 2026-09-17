/**
 * Pure unit tests for optimizeChapter's decision branches (already-webp skip,
 * no-savings skip, error codes) with prisma/fs/sharp fully mocked so they run
 * without a database or real images. See optimizer.int.test.ts for the
 * real-DB, real-file happy path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chapterFindUnique: vi.fn(),
  chapterUpdate: vi.fn(),
  pageFindMany: vi.fn(),
  pageAggregate: vi.fn(),
  pageUpdate: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
  sharpToBuffer: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    chapter: { findUnique: mocks.chapterFindUnique, update: mocks.chapterUpdate },
    page: { findMany: mocks.pageFindMany, aggregate: mocks.pageAggregate },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({ page: { update: mocks.pageUpdate } }),
    ),
  },
}));

vi.mock("@/lib/content/store", () => ({
  getDataRoot: () => "/fake-root",
  resolveInside: (base: string, ...segments: string[]) => [base, ...segments].join("/"),
}));

vi.mock("node:fs/promises", () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  rename: mocks.rename,
  rm: mocks.rm,
  stat: mocks.stat,
}));

vi.mock("sharp", () => ({
  default: vi.fn(() => ({
    webp: () => ({ toBuffer: mocks.sharpToBuffer }),
  })),
}));

const { optimizeChapter } = await import("./optimizer");

const CHAPTER = { id: "chapter-1", seriesId: "series-1", slug: "chap-1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.chapterFindUnique.mockResolvedValue(CHAPTER);
  mocks.stat.mockResolvedValue({ size: 500 });
  mocks.pageAggregate.mockResolvedValue({ _sum: { bytes: 500 } });
});

describe("optimizeChapter", () => {
  it("skips pages already in webp format without touching sharp or the DB", async () => {
    mocks.pageFindMany.mockResolvedValue([{ id: "p1", index: 1, file: "001.webp", bytes: 100 }]);

    const result = await optimizeChapter({ chapterId: "chapter-1", format: "WEBP", quality: 80 });

    expect(result).toEqual({ pagesConverted: 0, bytesBefore: 0, bytesAfter: 0 });
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.pageUpdate).not.toHaveBeenCalled();
    expect(mocks.chapterUpdate).not.toHaveBeenCalled();
  });

  it("skips a page when re-encoding would not shrink it", async () => {
    mocks.pageFindMany.mockResolvedValue([{ id: "p1", index: 1, file: "001.png", bytes: 50 }]);
    mocks.readFile.mockResolvedValue(Buffer.alloc(50));
    mocks.sharpToBuffer.mockResolvedValue({
      data: Buffer.alloc(60),
      info: { width: 10, height: 10 },
    });

    const result = await optimizeChapter({ chapterId: "chapter-1", format: "WEBP", quality: 80 });

    expect(result).toEqual({ pagesConverted: 0, bytesBefore: 0, bytesAfter: 0 });
    expect(mocks.pageUpdate).not.toHaveBeenCalled();
    expect(mocks.chapterUpdate).not.toHaveBeenCalled();
  });

  it("converts a shrinking page, replaces the file atomically and updates the row", async () => {
    mocks.pageFindMany.mockResolvedValue([{ id: "p1", index: 1, file: "001.png", bytes: 500 }]);
    mocks.readFile.mockResolvedValue(Buffer.alloc(500));
    mocks.sharpToBuffer.mockResolvedValue({
      data: Buffer.alloc(200),
      info: { width: 10, height: 20 },
    });

    const result = await optimizeChapter({ chapterId: "chapter-1", format: "WEBP", quality: 80 });

    expect(result).toEqual({ pagesConverted: 1, bytesBefore: 500, bytesAfter: 200 });
    expect(mocks.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("001.tmp-opt-p1.webp"),
      expect.any(Buffer),
    );
    expect(mocks.rename).toHaveBeenCalledWith(
      expect.stringContaining("001.tmp-opt-p1.webp"),
      expect.stringContaining("001.webp"),
    );
    expect(mocks.pageUpdate).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: {
        file: "001.webp",
        bytes: 200,
        sha256: expect.any(String),
        width: 10,
        height: 20,
        mime: "image/webp",
      },
    });
    expect(mocks.chapterUpdate).toHaveBeenCalledWith({
      where: { id: "chapter-1" },
      data: { bytes: 500n },
    });
  });

  it("throws CHAPTER_NOT_FOUND when the chapter does not exist", async () => {
    mocks.chapterFindUnique.mockResolvedValue(null);
    await expect(
      optimizeChapter({ chapterId: "missing", format: "WEBP", quality: 80 }),
    ).rejects.toMatchObject({ code: "CHAPTER_NOT_FOUND" });
  });

  it("throws UNSUPPORTED_FORMAT for a non-WEBP format", async () => {
    await expect(
      // @ts-expect-error exercising the runtime guard against an invalid format
      optimizeChapter({ chapterId: "chapter-1", format: "AVIF", quality: 80 }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
  });

  it("throws CANCELLED when the signal is already aborted", async () => {
    mocks.pageFindMany.mockResolvedValue([{ id: "p1", index: 1, file: "001.png", bytes: 500 }]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      optimizeChapter({
        chapterId: "chapter-1",
        format: "WEBP",
        quality: 80,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
