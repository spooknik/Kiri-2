/**
 * Page downloads — the part of a V1 ripper that was copy-pasted 30 times.
 *
 * Guarantees:
 *  - bytes land through a temp file + `rename`, so a half-written page is never
 *    visible to the reader;
 *  - sha256 is computed while streaming (no second read of the file);
 *  - the file extension comes from the *bytes* (magic numbers), falling back to
 *    the `Content-Type` — never blindly from the URL, which lies constantly;
 *  - width/height are parsed from the image header (PNG/JPEG/WebP/GIF) so the
 *    reader can reserve space without a `sharp` dependency;
 *  - a page whose file already exists and is non-empty is skipped unless
 *    `force`, which makes a re-run of `sync` cheap.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { PluginError } from "./errors.js";
import type { HttpClient } from "./http.js";
import { pageFileName, type ManifestImage } from "./manifest.js";

/** How many leading bytes are kept for sniffing and dimension parsing. */
const HEADER_BYTES = 65_536;

export interface ImageType {
  ext: string;
  mime: string;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

/** A page as returned by `listPages`. */
export interface PageRef {
  /** 1-based. */
  index: number;
  url: string;
  referer?: string;
  headers?: Record<string, string>;
}

/** One entry of `ManifestChapter.images`, plus whether we re-used it. */
export interface DownloadedImage extends ManifestImage {
  /** True when the file already existed and was not re-fetched. */
  skipped: boolean;
}

export interface DownloadImageOptions {
  http: HttpClient;
  url: string;
  /** Chapter directory; it must already exist. */
  dir: string;
  index: number;
  /** Page count, used for zero-padding the file name. */
  total: number;
  referer?: string;
  headers?: Record<string, string>;
  /** Previous manifest entry for this page, enabling the skip fast-path. */
  existing?: Partial<ManifestImage> | undefined;
  force?: boolean;
  signal?: AbortSignal;
  /** Pre-fetched bytes (used by `spec.downloadPage`); skips the HTTP call. */
  body?: Buffer;
}

/* -------------------------------------------------------------------------- */
/* Sniffing                                                                   */
/* -------------------------------------------------------------------------- */

function at(buffer: Buffer, index: number): number {
  return index >= 0 && index < buffer.length ? (buffer[index] as number) : -1;
}

function ascii(buffer: Buffer, start: number, length: number): string {
  return buffer.length >= start + length
    ? buffer.subarray(start, start + length).toString("latin1")
    : "";
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Identify an image from its leading bytes. `null` when it is not an image. */
export function sniffImageType(head: Buffer): ImageType | null {
  if (PNG_MAGIC.every((byte, index) => at(head, index) === byte)) {
    return { ext: ".png", mime: "image/png" };
  }
  if (at(head, 0) === 0xff && at(head, 1) === 0xd8 && at(head, 2) === 0xff) {
    return { ext: ".jpg", mime: "image/jpeg" };
  }
  if (ascii(head, 0, 4) === "GIF8") return { ext: ".gif", mime: "image/gif" };
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") {
    return { ext: ".webp", mime: "image/webp" };
  }
  if (ascii(head, 4, 4) === "ftyp") {
    const brand = ascii(head, 8, 4);
    if (brand === "avif" || brand === "avis") return { ext: ".avif", mime: "image/avif" };
  }
  return null;
}

const TYPE_BY_MIME: Record<string, ImageType> = {
  "image/jpeg": { ext: ".jpg", mime: "image/jpeg" },
  "image/jpg": { ext: ".jpg", mime: "image/jpeg" },
  "image/pjpeg": { ext: ".jpg", mime: "image/jpeg" },
  "image/png": { ext: ".png", mime: "image/png" },
  "image/apng": { ext: ".png", mime: "image/png" },
  "image/webp": { ext: ".webp", mime: "image/webp" },
  "image/gif": { ext: ".gif", mime: "image/gif" },
  "image/avif": { ext: ".avif", mime: "image/avif" },
};

/** Map a `Content-Type` header to an image type. */
export function imageTypeFromContentType(contentType: string | undefined): ImageType | null {
  if (!contentType) return null;
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return TYPE_BY_MIME[mime] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Dimensions                                                                 */
/* -------------------------------------------------------------------------- */

function pngSize(head: Buffer): ImageDimensions | null {
  if (head.length < 24) return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

function gifSize(head: Buffer): ImageDimensions | null {
  if (head.length < 10) return null;
  return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
}

function webpSize(head: Buffer): ImageDimensions | null {
  const chunk = ascii(head, 12, 4);
  if (chunk === "VP8 " && head.length >= 30) {
    return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L" && head.length >= 25) {
    const b0 = at(head, 21);
    const b1 = at(head, 22);
    const b2 = at(head, 23);
    const b3 = at(head, 24);
    if (b0 < 0 || b1 < 0 || b2 < 0 || b3 < 0) return null;
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  if (chunk === "VP8X" && head.length >= 30) {
    return { width: head.readUIntLE(24, 3) + 1, height: head.readUIntLE(27, 3) + 1 };
  }
  return null;
}

function jpegSize(head: Buffer): ImageDimensions | null {
  let offset = 2;
  while (offset + 9 < head.length) {
    if (at(head, offset) !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = at(head, offset + 1);
    // Runs of 0xFF are fill bytes before the real marker.
    while (marker === 0xff) {
      offset += 1;
      marker = at(head, offset + 1);
    }
    if (marker < 0) return null;
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = head.length >= offset + 4 ? head.readUInt16BE(offset + 2) : 0;
    if (length < 2) return null;
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      if (head.length < offset + 9) return null;
      return { height: head.readUInt16BE(offset + 5), width: head.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

/**
 * Width/height straight out of the image header. Supports PNG, JPEG, WebP and
 * GIF; AVIF and anything unknown return `null` (the host can still fill the
 * dimensions in during ingest).
 */
export function imageDimensions(head: Buffer): ImageDimensions | null {
  const type = sniffImageType(head);
  if (!type) return null;
  const size =
    type.ext === ".png"
      ? pngSize(head)
      : type.ext === ".jpg"
        ? jpegSize(head)
        : type.ext === ".webp"
          ? webpSize(head)
          : type.ext === ".gif"
            ? gifSize(head)
            : null;
  if (!size) return null;
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return null;
  if (size.width <= 0 || size.height <= 0) return null;
  return size;
}

/* -------------------------------------------------------------------------- */
/* Download                                                                   */
/* -------------------------------------------------------------------------- */

async function readHead(file: string): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(file, "r");
  try {
    const stream = handle.createReadStream();
    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return hash.digest("hex");
}

function withMetadata(image: DownloadedImage, head: Buffer, type: ImageType): DownloadedImage {
  const dimensions = imageDimensions(head);
  if (dimensions) {
    image.width = dimensions.width;
    image.height = dimensions.height;
  }
  image.mime = type.mime;
  return image;
}

/**
 * Download one page into `dir`, returning its manifest entry.
 *
 * Skips the network entirely when `existing.file` is on disk, non-empty and
 * `force` is not set — filling in any metadata (sha256, dimensions, mime) the
 * old entry was missing.
 */
export async function downloadImage(options: DownloadImageOptions): Promise<DownloadedImage> {
  const { http, url, dir, index, total, existing, force, signal } = options;

  if (signal?.aborted) throw new PluginError("CANCELLED", "Cancelled");

  if (!force && existing?.file) {
    const existingPath = path.join(dir, existing.file);
    const info = await stat(existingPath).catch(() => null);
    if (info?.isFile() && info.size > 0) {
      const image: DownloadedImage = {
        index,
        url: existing.url ?? url,
        file: existing.file,
        bytes: info.size,
        sha256: existing.sha256 || (await hashFile(existingPath)),
        skipped: true,
      };
      if (existing.width && existing.height) {
        image.width = existing.width;
        image.height = existing.height;
        if (existing.mime) image.mime = existing.mime;
      } else {
        const head = await readHead(existingPath);
        const type = sniffImageType(head);
        if (type) withMetadata(image, head, type);
      }
      return image;
    }
  }

  const tempPath = path.join(
    dir,
    `.${String(index).padStart(4, "0")}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.part`,
  );

  const hash = createHash("sha256");
  const headChunks: Buffer[] = [];
  let headBytes = 0;
  let bytes = 0;
  let contentType = "";
  let finalUrl = url;

  const consume = (chunk: Buffer): void => {
    bytes += chunk.length;
    hash.update(chunk);
    if (headBytes < HEADER_BYTES) {
      const slice = chunk.subarray(0, HEADER_BYTES - headBytes);
      headChunks.push(Buffer.from(slice));
      headBytes += slice.length;
    }
  };

  try {
    if (options.body) {
      consume(options.body);
      await pipeline(Readable.from([options.body]), createWriteStream(tempPath));
    } else {
      const response = await http.fetchWithRetry(url, {
        ...(options.referer === undefined ? {} : { referer: options.referer }),
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        ...(signal === undefined ? {} : { signal }),
      });
      contentType = response.headers.get("content-type") ?? "";
      finalUrl = response.url || url;
      if (!response.body) {
        throw new PluginError("NETWORK", `Empty image response: ${url}`, { retryable: true });
      }
      const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
      async function* tap(): AsyncGenerator<Buffer> {
        for await (const chunk of source) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          consume(buffer);
          yield buffer;
        }
      }
      await pipeline(tap(), createWriteStream(tempPath));
    }

    if (bytes === 0) {
      throw new PluginError("NETWORK", `Empty image response: ${url}`, { retryable: true });
    }

    const head = Buffer.concat(headChunks);
    const type = sniffImageType(head) ?? imageTypeFromContentType(contentType);
    if (!type) {
      throw new PluginError(
        "PARSE",
        `Not an image (${contentType || "unknown content type"}): ${url}`,
      );
    }

    const fileName = pageFileName(index, total, type.ext);
    const filePath = path.join(dir, fileName);
    // A previous run may have stored the same page under another extension.
    if (existing?.file && existing.file !== fileName) {
      await rm(path.join(dir, existing.file), { force: true });
    }
    await rename(tempPath, filePath);

    const image: DownloadedImage = {
      index,
      url: finalUrl,
      file: fileName,
      bytes,
      sha256: hash.digest("hex"),
      skipped: false,
    };
    return withMetadata(image, head, type);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw PluginError.from(error, "NETWORK");
  }
}

export interface DownloadAllOptions {
  http: HttpClient;
  /** Chapter directory; created if missing. */
  dir: string;
  concurrency?: number;
  force?: boolean;
  /** Previous manifest images, matched by index for the skip fast-path. */
  existing?: readonly Partial<ManifestImage>[];
  signal?: AbortSignal;
  onProgress?: (progress: {
    completed: number;
    total: number;
    bytes: number;
    index: number;
  }) => void;
  /** Custom fetcher (`spec.downloadPage`); returning bytes bypasses HTTP. */
  download?: (page: PageRef) => Promise<Buffer | null | undefined> | Buffer | null | undefined;
}

export interface DownloadAllResult {
  images: DownloadedImage[];
  /** Pages actually fetched over the network. */
  downloaded: number;
  /** Pages re-used from disk. */
  skipped: number;
  bytes: number;
}

/**
 * Download every page with bounded concurrency (V1's `processWithConcurrency`,
 * generalised). Fails fast: the first error aborts the remaining workers and is
 * rethrown, because a chapter with a hole in it is not a usable chapter.
 */
export async function downloadAll(
  pages: readonly PageRef[],
  options: DownloadAllOptions,
): Promise<DownloadAllResult> {
  await mkdir(options.dir, { recursive: true });

  const total = pages.length;
  const results = new Array<DownloadedImage | undefined>(total);
  const existingByIndex = new Map<number, Partial<ManifestImage>>();
  for (const image of options.existing ?? []) {
    if (typeof image.index === "number") existingByIndex.set(image.index, image);
  }

  const controller = new AbortController();
  const abortOnParent = (): void => controller.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener("abort", abortOnParent, { once: true });
  }

  const workerCount = Math.max(1, Math.min(options.concurrency ?? 4, Math.max(total, 1)));
  let next = 0;
  let completed = 0;
  let bytes = 0;
  let firstError: unknown;

  const runWorker = async (): Promise<void> => {
    for (;;) {
      const position = next;
      next += 1;
      if (position >= total || firstError !== undefined) return;
      const page = pages[position];
      if (!page) return;
      try {
        const body = options.download ? await options.download(page) : undefined;
        const image = await downloadImage({
          http: options.http,
          url: page.url,
          dir: options.dir,
          index: page.index,
          total,
          ...(page.referer === undefined ? {} : { referer: page.referer }),
          ...(page.headers === undefined ? {} : { headers: page.headers }),
          existing: existingByIndex.get(page.index),
          ...(options.force === undefined ? {} : { force: options.force }),
          signal: controller.signal,
          ...(body ? { body } : {}),
        });
        results[position] = image;
        completed += 1;
        bytes += image.bytes;
        options.onProgress?.({ completed, total, bytes, index: page.index });
      } catch (error) {
        if (firstError === undefined) {
          firstError = error;
          controller.abort();
        }
        return;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  } finally {
    options.signal?.removeEventListener("abort", abortOnParent);
  }

  if (firstError !== undefined) throw PluginError.from(firstError, "NETWORK");

  const images = results
    .filter((image): image is DownloadedImage => image !== undefined)
    .sort((a, b) => a.index - b.index);

  return {
    images,
    downloaded: images.filter((image) => !image.skipped).length,
    skipped: images.filter((image) => image.skipped).length,
    bytes,
  };
}

/** Strip SDK-only fields before the image goes into `manifest.json`. */
export function toManifestImage(image: DownloadedImage): ManifestImage {
  const manifestImage: ManifestImage = {
    index: image.index,
    url: image.url,
    file: image.file,
    bytes: image.bytes,
    sha256: image.sha256,
  };
  if (image.width !== undefined) manifestImage.width = image.width;
  if (image.height !== undefined) manifestImage.height = image.height;
  if (image.mime !== undefined) manifestImage.mime = image.mime;
  return manifestImage;
}
