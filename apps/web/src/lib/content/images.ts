/**
 * Image file facts: dimensions, MIME type, size and content hash.
 *
 * Ingest and the local-chapter path use this to fill in what a manifest (or an
 * upload) did not provide. Real dimensions in the database are what lets the
 * reader lay a page out before the bytes arrive, so a decode failure is not
 * fatal — the page is still readable, it just has no intrinsic size.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";

export interface ImageMetadata {
  width: number | null;
  height: number | null;
  mime: string | null;
  bytes: number;
}

/** sharp's format ids to MIME types. */
const MIME_BY_FORMAT: Record<string, string> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  heif: "image/heif",
  tiff: "image/tiff",
  svg: "image/svg+xml",
};

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jfif": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".svg": "image/svg+xml",
};

/** MIME type guessed from a file name; null when the extension is unknown. */
export function mimeFromExtension(file: string): string | null {
  return MIME_BY_EXTENSION[path.extname(file).toLowerCase()] ?? null;
}

/**
 * The MIME types a page may be served with inline. Deliberately short: these
 * are the formats a browser renders as an image and nothing else. `image/svg+xml`
 * is *not* here — an SVG is a script-bearing document, and page files come from
 * plugins and uploads.
 */
export const SERVABLE_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

/**
 * The Content-Type to serve a stored page with, or null when nothing safe is
 * known — the caller then sends `application/octet-stream` as an attachment.
 *
 * `declared` is whatever a manifest said, i.e. a plugin-controlled string, so
 * it is honoured only when it names one of {@link SERVABLE_IMAGE_MIMES};
 * otherwise the file extension decides.
 */
export function servableImageMime(
  declared: string | null | undefined,
  file: string,
): string | null {
  const normalized =
    typeof declared === "string" ? (declared.split(";")[0] ?? "").trim().toLowerCase() : "";
  if (SERVABLE_IMAGE_MIMES.has(normalized)) return normalized;
  const fromExtension = mimeFromExtension(file);
  return fromExtension !== null && SERVABLE_IMAGE_MIMES.has(fromExtension) ? fromExtension : null;
}

/**
 * Size on disk plus intrinsic dimensions and format. A file that sharp cannot
 * decode still returns its byte size, with nulls for the rest.
 */
export async function readImageMetadata(file: string): Promise<ImageMetadata> {
  const info = await stat(file);
  const bytes = info.size;
  try {
    const metadata = await sharp(file, { failOn: "none" }).metadata();
    // `autoOrient` swaps the axes for EXIF orientations 5-8, which is what the
    // browser will render, so store the oriented size.
    const rotated = (metadata.orientation ?? 0) >= 5;
    const width = rotated ? metadata.height : metadata.width;
    const height = rotated ? metadata.width : metadata.height;
    return {
      width: typeof width === "number" && width > 0 ? width : null,
      height: typeof height === "number" && height > 0 ? height : null,
      mime:
        (metadata.format ? MIME_BY_FORMAT[metadata.format] : undefined) ?? mimeFromExtension(file),
      bytes,
    };
  } catch {
    return { width: null, height: null, mime: mimeFromExtension(file), bytes };
  }
}

/** Streaming SHA-256 of a file, hex encoded. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** Byte size of a file, or null when it is missing. */
export async function fileSize(file: string): Promise<number | null> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

/**
 * Run `worker` over `items` with at most `limit` in flight. Ingest reads
 * metadata for hundreds of files at a time; unbounded `Promise.all` over a
 * whole series exhausts file handles on Windows.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index] as T;
      results[index] = await worker(item, index);
    }
  });
  await Promise.all(runners);
  return results;
}
