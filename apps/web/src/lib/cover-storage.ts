/**
 * Series cover storage.
 *
 * Ported from V1 `src/lib/cover-storage.ts` with three changes:
 *   - covers are normalised to one format (WebP, max 800px wide) instead of
 *     keeping whatever the remote server sent, so the reader only ever deals
 *     with `cover.webp`;
 *   - the download is bounded (10 s timeout, 10 MB, `image/*` only) and goes
 *     through {@link safeFetch}, so a cover URL cannot be pointed at the host's
 *     own network (SSRF) — redirects included;
 *   - the write is atomic (temp file + rename), so a half-written cover can
 *     never be served.
 *
 * Covers are decoration: a failure here must never fail a series create or
 * update. Callers use {@link tryStoreCoverFromUrl}, which logs and returns
 * null; only routes that exist purely to set a cover surface the error.
 */
import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { coversDir, ensureDir, removeDirSafe, resolveInside } from "@/lib/content/store";
import { safeFetch, SafeFetchError } from "@/lib/net/safe-fetch";
import { isHttpUrl, sanitizePathSegment } from "@/lib/text";

/** The only cover file name a series ever has. */
export const COVER_FILE = "cover.webp";

const MAX_COVER_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_COVER_WIDTH = 800;
const WEBP_QUALITY = 82;

/** Thrown for every rejected cover; carries a user-presentable message. */
export class CoverError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CoverError";
  }
}

export interface StoredCover {
  /** File name inside `covers/<seriesId>/`, to store in `Series.coverFile`. */
  file: string;
}

function normalizeContentType(raw: string | null): string {
  return (raw ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** A refused or failed download, as a message a user can act on. */
function toCoverError(cause: unknown): CoverError {
  if (cause instanceof SafeFetchError) {
    return cause.code === "TOO_LARGE"
      ? new CoverError("Cover image must be smaller than 10 MB", { cause })
      : new CoverError(cause.message, { cause });
  }
  return new CoverError("Could not download the cover image", { cause });
}

/** Download a remote image and store it as this series' cover. */
export async function storeCoverFromUrl(seriesId: string, url: string): Promise<StoredCover> {
  if (!isHttpUrl(url)) {
    throw new CoverError("Cover image URL must start with http:// or https://");
  }

  let response: Response;
  try {
    // safeFetch owns the scheme, address, redirect and size rules; the 10 MB
    // cap is enforced both by the header and while the body streams.
    response = await safeFetch(url, {
      cache: "no-store",
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_COVER_BYTES,
    });
  } catch (cause) {
    throw toCoverError(cause);
  }

  if (!response.ok) {
    throw new CoverError(`Cover image URL returned ${response.status}`);
  }

  const contentType = normalizeContentType(response.headers.get("content-type"));
  if (!contentType.startsWith("image/")) {
    throw new CoverError(`Cover image URL is not an image (${contentType || "no content type"})`);
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (cause) {
    throw toCoverError(cause);
  }
  return storeCoverFromBuffer(seriesId, buffer);
}

/** Convert `buffer` to WebP and write it as this series' cover, atomically. */
export async function storeCoverFromBuffer(seriesId: string, buffer: Buffer): Promise<StoredCover> {
  if (buffer.byteLength === 0) {
    throw new CoverError("Cover image is empty");
  }
  if (buffer.byteLength > MAX_COVER_BYTES) {
    throw new CoverError("Cover image must be smaller than 10 MB");
  }

  let webp: Buffer;
  try {
    webp = await sharp(buffer, { failOn: "none" })
      // Honour EXIF orientation, then drop the metadata with it.
      .rotate()
      .resize({ width: MAX_COVER_WIDTH, withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
  } catch (cause) {
    throw new CoverError("Cover image could not be decoded", { cause });
  }

  const dir = coversDir(seriesId);
  await ensureDir(dir);
  const target = resolveInside(dir, COVER_FILE);
  // Same directory as the target so the rename is atomic on one filesystem.
  const temp = resolveInside(dir, `.${COVER_FILE}.${randomUUID()}.tmp`);
  await writeFile(temp, webp);
  await rename(temp, target);

  return { file: COVER_FILE };
}

/** Absolute path of a stored cover file. Throws if `file` escapes the store. */
export function getCoverPath(seriesId: string, file: string): string {
  return resolveInside(coversDir(seriesId), sanitizePathSegment(file));
}

/** Remove the whole `covers/<seriesId>` directory. Missing is fine. */
export async function deleteCover(seriesId: string): Promise<void> {
  await removeDirSafe(coversDir(seriesId));
}

export interface CoverSource {
  id: string;
  coverFile: string | null;
  updatedAt: Date | string | number;
}

function toMillis(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Public URL for a series cover, cache-busted by the series' `updatedAt` so a
 * replaced cover is picked up even though the URL is otherwise stable.
 */
export function coverUrlFor(series: CoverSource): string | null {
  if (!series.coverFile) return null;
  return `/api/series/${series.id}/cover?v=${toMillis(series.updatedAt)}`;
}

/**
 * Best-effort variant used by series create/update: returns the stored file
 * name, or null after logging when anything went wrong.
 */
export async function tryStoreCoverFromUrl(seriesId: string, url: string): Promise<string | null> {
  try {
    const { file } = await storeCoverFromUrl(seriesId, url);
    return file;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[cover] could not store cover for series ${seriesId}: ${reason}`);
    return null;
  }
}

/** Best-effort cover removal; never throws (used on delete paths). */
export async function tryDeleteCover(seriesId: string): Promise<void> {
  try {
    await deleteCover(seriesId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[cover] could not delete cover for series ${seriesId}: ${reason}`);
  }
}
