/**
 * PDF_IMPORT job handler.
 *
 * Config: `{ seriesId, uploadId, uploadPath?, title, number, volume, scale,
 * maxWidth }` (see `configSchema` below; `scale`/`maxWidth` default to the
 * same values as `importChapterSchema.pdf` in `src/lib/contracts/content.ts`).
 *
 * `uploadPath` resolution: the `/chapters/import` route sets `uploadPath`
 * when it enqueues the job; the fallback derives the same location from the
 * content store's `uploadsDir()` (`DATA_ROOT/tmp/uploads/<uploadId>/file`).
 */
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createLocalChapter, type LocalPageFile } from "@/lib/content/chapters";
import { chapterDir as storeChapterDir, resolveInside, uploadsDir } from "@/lib/content/store";
import { JobFailure, registerJobHandler, type JobContext } from "@/lib/jobs/types";
import { chapterSlugForSha, renderPdfToImages, sha256File } from "@/lib/media/pdf";
import { prisma } from "@/lib/prisma";

// Mirrors src/lib/contracts/content.ts importChapterSchema's shape for `pdf`
// import jobs, minus `kind`/`uploadIds` which the API route consumes before
// enqueueing. Kept local — src/lib/contracts/** is out of scope for this port.
const configSchema = z.object({
  seriesId: z.uuid(),
  uploadId: z.uuid(),
  uploadPath: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).max(200),
  number: z.number().min(0).max(100_000).nullish(),
  volume: z.string().trim().max(40).nullish(),
  scale: z.number().min(1).max(3).default(1.5),
  maxWidth: z.number().int().min(600).max(4000).default(1600),
});

export interface PdfImportResult {
  chapterId: string;
  pageCount: number;
  slug: string;
}

function resolveUploadPath(config: z.infer<typeof configSchema>): string {
  if (config.uploadPath) return config.uploadPath;
  return resolveInside(uploadsDir(), config.uploadId, "file");
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EXDEV") {
      await copyFile(from, to);
      await rm(from, { force: true });
      return;
    }
    throw error;
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002",
  );
}

export async function handlePdfImport(ctx: JobContext): Promise<PdfImportResult> {
  const parsed = configSchema.safeParse(ctx.job.config);
  if (!parsed.success) {
    throw new JobFailure("INVALID_CONFIG", `Invalid PDF_IMPORT config: ${parsed.error.message}`);
  }
  const config = parsed.data;
  const uploadPath = resolveUploadPath(config);

  ctx.log(`Reading upload ${config.uploadId} from ${uploadPath}`);

  let sha256: string;
  try {
    sha256 = await sha256File(uploadPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new JobFailure("INVALID_PDF", `Could not read upload ${config.uploadId}: ${message}`);
  }

  const slug = chapterSlugForSha(sha256);

  // Check for a duplicate chapter before paying for the (potentially
  // multi-minute) render — createLocalChapter would also reject the slug
  // collision, but only after the PDF has already been fully rasterised.
  const existing = await prisma.chapter.findUnique({
    where: { seriesId_slug: { seriesId: config.seriesId, slug } },
    select: { id: true },
  });
  if (existing) {
    throw new JobFailure(
      "DUPLICATE_PDF",
      `Series already has a chapter for this PDF (slug ${slug})`,
    );
  }

  ctx.log(`Rendering PDF (scale ${config.scale}, maxWidth ${config.maxWidth})`);

  const rendered = await renderPdfToImages({
    pdfPath: uploadPath,
    outDir: ctx.tmpDir,
    scale: config.scale,
    maxWidth: config.maxWidth,
    signal: ctx.signal,
    sha256,
    onProgress: async (current, total) => {
      await ctx.progress({ phase: "render", current, total });
    },
  });

  ctx.log(`Rendered ${rendered.pages.length} pages; moving into the library`);

  const chapterDir = storeChapterDir(config.seriesId, slug);
  await mkdir(chapterDir, { recursive: true });

  const pages: LocalPageFile[] = [];
  for (const page of rendered.pages) {
    const targetPath = path.join(chapterDir, path.basename(page.path));
    await moveFile(page.path, targetPath);
    pages.push({
      path: targetPath,
      index: page.index,
      bytes: page.bytes,
      sha256: page.sha256,
      width: page.width,
      height: page.height,
      mime: "image/webp",
    });
  }

  let created;
  try {
    created = await createLocalChapter({
      seriesId: config.seriesId,
      slug,
      title: config.title,
      number: config.number ?? null,
      volume: config.volume ?? null,
      origin: "PDF",
      pages,
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new JobFailure(
        "DUPLICATE_PDF",
        `Series already has a chapter for this PDF (slug ${slug})`,
      );
    }
    throw error;
  }

  try {
    const uploadDir = path.dirname(uploadPath);
    await rm(uploadDir, { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.log(`Could not clean up upload directory: ${message}`);
  }

  return { chapterId: created.chapterId, pageCount: created.pageCount, slug };
}

registerJobHandler("PDF_IMPORT", handlePdfImport);
