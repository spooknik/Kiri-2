/**
 * MANUAL_UPLOAD job handler — a chapter built from files the user uploaded.
 *
 * Config (written by `POST /api/series/:id/chapters/import`):
 *   { seriesId, uploadIds: string[], kind: "archive" | "images",
 *     title, number: number | null, volume: string | null }
 *
 * `archive` takes exactly one zip/cbz and streams its images into the job's
 * scratch directory; `images` takes the uploads themselves, in the order the
 * client listed them (that is the reading order the user picked). Either way
 * the files land in `chapterDir(seriesId, slug)` as `001.jpg`, `002.jpg`, …
 * *before* `createLocalChapter` is told about them — the content service
 * expects finished files at their final paths.
 *
 * Not retried (`maxAttempts: 1`): the uploads are deleted once consumed, so a
 * second attempt would have nothing to work from.
 */
import { copyFile, rename, stat, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ensureDir, removeDirSafe, resolveInside } from "@/lib/content/store";
import { createLocalChapter, type LocalPageFile } from "@/lib/content/chapters";
import { chapterDir } from "@/lib/content/store";
import { JobFailure, registerJobHandler, type JobContext } from "@/lib/jobs/types";
import { prisma } from "@/lib/prisma";
import {
  ArchiveError,
  extensionOf,
  extractArchiveImages,
  isImageName,
  sortImagesNaturally,
  type ExtractedImage,
} from "@/lib/uploads/archive";
import { deleteUploadSession, takeCompletedUpload } from "@/lib/uploads/sessions";

/** Two hours: a 2 GB archive on slow storage still has to fit. */
const TIMEOUT_MS = 2 * 60 * 60 * 1000;

const configSchema = z.object({
  seriesId: z.uuid(),
  uploadIds: z.array(z.uuid()).min(1).max(500),
  kind: z.enum(["archive", "images"]),
  title: z.string().trim().min(1).max(200),
  number: z.number().nullish(),
  volume: z.string().nullish(),
});

/** Mime types we accept for an `images` upload whose filename has no extension. */
const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
};

/** `manual-20260910-143210-a1b2` — sortable, unique, and obviously local. */
export function manualChapterSlug(
  at: Date = new Date(),
  random = randomBytes(2).toString("hex"),
): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `manual-${stamp}-${random}`;
}

/** `001.jpg` … `0001.jpg` once a chapter has more than 999 pages. */
export function pageFileName(index: number, total: number, ext: string): string {
  const width = Math.max(3, String(total).length);
  return `${String(index).padStart(width, "0")}${ext}`;
}

/** Rename across the store, copying when tmp and library sit on different volumes. */
async function moveInto(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(source, target);
    await unlink(source).catch(() => undefined);
  }
}

async function collectImages(
  ctx: JobContext,
  config: z.infer<typeof configSchema>,
  userId: string,
): Promise<{ images: ExtractedImage[]; consumed: string[] }> {
  const consumed: string[] = [];
  const uploads = [];
  for (const uploadId of config.uploadIds) {
    try {
      uploads.push(await takeCompletedUpload(userId, uploadId));
      consumed.push(uploadId);
    } catch (error) {
      throw new JobFailure(
        "UPLOAD_MISSING",
        `Upload ${uploadId} is missing or was never completed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (config.kind === "archive") {
    const archive = uploads[0];
    if (!archive) throw new JobFailure("UPLOAD_MISSING", "No archive was uploaded");
    ctx.log(`Extracting ${archive.filename} (${archive.size} bytes)`);
    let extracted: ExtractedImage[];
    try {
      extracted = await extractArchiveImages(archive.path, ctx.tmpDir, {
        signal: ctx.signal,
        onFile: (image, count) => {
          if (count % 10 === 0) {
            void ctx.progress({ phase: "extract", current: count, message: image.name });
          }
        },
      });
    } catch (error) {
      if (error instanceof ArchiveError) {
        throw new JobFailure("INVALID_ARCHIVE", error.message);
      }
      throw error;
    }
    ctx.log(`Extracted ${extracted.length} image(s)`);
    return { images: sortImagesNaturally(extracted), consumed };
  }

  // "images": the client's order is the reading order, so do not re-sort.
  const images: ExtractedImage[] = [];
  for (const upload of uploads) {
    const ext = isImageName(upload.filename)
      ? extensionOf(upload.filename)
      : (MIME_EXTENSIONS[(upload.mime ?? "").toLowerCase()] ?? "");
    if (ext === "") {
      throw new JobFailure("NO_IMAGES", `"${upload.filename}" is not an image Kiri can read`);
    }
    images.push({ path: upload.path, name: upload.filename, bytes: upload.size, ext });
  }
  return { images, consumed };
}

async function handleManualUpload(ctx: JobContext): Promise<unknown> {
  const parsed = configSchema.safeParse(ctx.job.config);
  if (!parsed.success) {
    throw new JobFailure("INVALID_CONFIG", `Malformed job configuration: ${parsed.error.message}`);
  }
  const config = parsed.data;

  const userId = ctx.job.requestedById;
  if (!userId) {
    throw new JobFailure(
      "INVALID_CONFIG",
      "This job has no requester, so its uploads cannot be read",
    );
  }

  const series = await prisma.series.findUnique({
    where: { id: config.seriesId },
    select: { id: true },
  });
  if (!series) throw new JobFailure("NOT_FOUND", "The series no longer exists");

  await ctx.progress({ phase: "prepare", current: 0, total: config.uploadIds.length });
  const { images, consumed } = await collectImages(ctx, config, userId);
  if (images.length === 0) {
    throw new JobFailure("NO_IMAGES", "No readable images were found in the upload");
  }
  ctx.signal.throwIfAborted();

  const slug = manualChapterSlug();
  const dir = chapterDir(config.seriesId, slug);
  const pages: LocalPageFile[] = [];
  try {
    await ensureDir(dir);
    for (const [offset, image] of images.entries()) {
      ctx.signal.throwIfAborted();
      const index = offset + 1;
      const target = resolveInside(dir, pageFileName(index, images.length, image.ext));
      await moveInto(image.path, target);
      const info = await stat(target);
      pages.push({ path: target, index, bytes: info.size });
      await ctx.progress({
        phase: "store",
        current: index,
        total: images.length,
        message: image.name,
      });
    }

    ctx.log(`Registering chapter "${config.title}" with ${pages.length} page(s)`);
    const chapter = await createLocalChapter({
      seriesId: config.seriesId,
      slug,
      title: config.title,
      number: config.number ?? null,
      volume: config.volume ?? null,
      origin: "MANUAL",
      pages,
    });

    // Only once the chapter exists: a failure before this point leaves the
    // uploads in place so the user can retry without re-uploading.
    for (const uploadId of consumed) {
      await deleteUploadSession(userId, uploadId).catch(() => undefined);
    }

    return { chapterId: chapter.chapterId, pageCount: chapter.pageCount };
  } catch (error) {
    // Do not leave a half-populated chapter directory behind.
    await removeDirSafe(dir).catch(() => undefined);
    throw error;
  }
}

registerJobHandler("MANUAL_UPLOAD", handleManualUpload, {
  timeoutMs: TIMEOUT_MS,
  maxAttempts: 1,
});
