/**
 * Re-encode a chapter's page images to WebP. Ported from V1
 * (`src/lib/media-optimizer.ts`, `optimizeSeriesImagesLocked`): read each
 * page, skip anything already WebP or that wouldn't shrink, re-encode with
 * sharp, atomically replace the file on disk. V1 rewrote a JSON manifest;
 * V2 has no manifest for local chapters, so this updates `Page` rows instead
 * (never `Page.id`/`index` — notes anchor to them).
 */
import { createHash } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { getDataRoot, resolveInside } from "@/lib/content/store";
import { JobFailure } from "@/lib/jobs/types";
import { prisma } from "@/lib/prisma";
import { sanitizePathSegment } from "@/lib/text";

export const OPTIMIZER_FORMATS = ["WEBP"] as const;
export type OptimizerFormat = (typeof OPTIMIZER_FORMATS)[number];

export const DEFAULT_OPTIMIZER_QUALITY = 80;

export interface OptimizeChapterInput {
  chapterId: string;
  format: OptimizerFormat;
  quality: number;
  signal?: AbortSignal;
  onProgress?: (current: number, total: number) => void | Promise<void>;
}

export interface OptimizeChapterResult {
  /** Pages actually re-encoded (excludes already-webp and no-savings skips). */
  pagesConverted: number;
  /** Sum of original bytes across converted pages only (matches V1 scoping). */
  bytesBefore: number;
  /** Sum of re-encoded bytes across converted pages only. */
  bytesAfter: number;
}

/**
 * `DATA_ROOT/library/<seriesId>/<sanitized slug>` — content/store.ts does not
 * yet export `chapterDir`/`chapterDirName` (owned by the content-core agent;
 * still a throwing stub as of this writing). Computed locally per the task
 * brief; replace with the real export once it lands.
 */
function chapterDirFor(seriesId: string, slug: string): string {
  return resolveInside(getDataRoot(), "library", seriesId, sanitizePathSegment(slug));
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new JobFailure("CANCELLED", "Optimize job was cancelled", { retryable: false });
  }
}

/**
 * Re-encode every non-WebP page of `chapterId` to WebP at `quality`,
 * updating the `Page` rows and recomputing `Chapter.bytes` in place.
 */
export async function optimizeChapter(input: OptimizeChapterInput): Promise<OptimizeChapterResult> {
  const { chapterId, format, quality, signal, onProgress } = input;

  if (format !== "WEBP") {
    throw new JobFailure("UNSUPPORTED_FORMAT", `Optimizer format not supported: ${String(format)}`);
  }

  const chapter = await prisma.chapter.findUnique({ where: { id: chapterId } });
  if (!chapter) {
    throw new JobFailure("CHAPTER_NOT_FOUND", `No chapter with id ${chapterId}`);
  }

  const pages = await prisma.page.findMany({
    where: { chapterId },
    orderBy: { index: "asc" },
  });

  const chapterDir = chapterDirFor(chapter.seriesId, chapter.slug);

  let pagesConverted = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;

  for (let i = 0; i < pages.length; i += 1) {
    assertNotAborted(signal);
    const page = pages[i];
    if (!page) continue;

    const ext = path.extname(page.file).toLowerCase();
    if (ext === ".webp") {
      await onProgress?.(i + 1, pages.length);
      continue;
    }

    const originalPath = resolveInside(chapterDir, page.file);
    const originalBuffer = await readFile(originalPath);
    const { data: optimizedBuffer, info } = await sharp(originalBuffer)
      .webp({ quality, effort: 4 })
      .toBuffer({ resolveWithObject: true });

    // V1 logic: skip when re-encoding wouldn't actually shrink the file.
    if (optimizedBuffer.length >= originalBuffer.length) {
      await onProgress?.(i + 1, pages.length);
      continue;
    }

    const baseName = path.parse(page.file).name;
    const newFileName = `${baseName}.webp`;
    const newPath = resolveInside(chapterDir, newFileName);
    const tempPath = resolveInside(chapterDir, `${baseName}.tmp-opt-${page.id}.webp`);

    await writeFile(tempPath, optimizedBuffer);
    const written = await stat(tempPath);
    if (written.size <= 0) {
      await rm(tempPath, { force: true });
      throw new JobFailure(
        "OPTIMIZE_WRITE_FAILED",
        `Optimizer wrote an empty file for page ${page.id}`,
      );
    }

    await rm(newPath, { force: true });
    await rename(tempPath, newPath);
    if (path.resolve(newPath) !== path.resolve(originalPath)) {
      await rm(originalPath, { force: true });
    }

    const sha256 = createHash("sha256").update(optimizedBuffer).digest("hex");

    await prisma.$transaction(async (tx) => {
      await tx.page.update({
        where: { id: page.id },
        data: {
          file: newFileName,
          bytes: optimizedBuffer.length,
          sha256,
          width: info.width,
          height: info.height,
          mime: "image/webp",
        },
      });
    });

    pagesConverted += 1;
    bytesBefore += originalBuffer.length;
    bytesAfter += optimizedBuffer.length;

    await onProgress?.(i + 1, pages.length);
  }

  if (pagesConverted > 0) {
    const totals = await prisma.page.aggregate({ where: { chapterId }, _sum: { bytes: true } });
    await prisma.chapter.update({
      where: { id: chapterId },
      data: { bytes: BigInt(totals._sum.bytes ?? 0) },
    });
  }

  return { pagesConverted, bytesBefore, bytesAfter };
}
