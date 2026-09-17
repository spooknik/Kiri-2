/**
 * Zip / CBZ extraction for manual chapter uploads.
 *
 * A CBZ is an untrusted archive from the internet, so every entry is checked
 * before a single byte is written: no traversal, no absolute paths, no
 * `__MACOSX` metadata, no dotfiles, images only, and hard caps on entry size,
 * entry count and total extracted bytes (a zip bomb otherwise fills the
 * volume). Entries stream straight to disk through yauzl, so a 2 GB archive
 * never has to fit in memory.
 *
 * Page order comes from a natural sort of the entry path — `9.jpg` before
 * `10.jpg`, which a plain string sort gets wrong and every scanlation archive
 * relies on.
 */
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import yauzl from "yauzl";
import { ensureDir, resolveInside } from "@/lib/content/store";

/** Extensions the reader can display. */
export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);

/** Per-file ceiling; a single 200 MB page is already absurd. */
export const MAX_ENTRY_BYTES = 200 * 1024 * 1024;
/** Entry-count ceiling for one archive. */
export const MAX_ENTRIES = 2000;
/** Total extracted bytes: the zip-bomb backstop. */
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

/** An image extracted from an archive, or an uploaded image file. */
export interface ExtractedImage {
  /** Absolute path on disk (inside the destination directory). */
  path: string;
  /** Entry path as it appeared in the archive; the sort key. */
  name: string;
  bytes: number;
  /** Lowercase extension including the dot. */
  ext: string;
}

export type EntryRejection =
  | "directory"
  | "traversal"
  | "absolute"
  | "macos-metadata"
  | "dotfile"
  | "not-an-image"
  | "too-large";

export type EntryDecision =
  { ok: true; name: string; ext: string } | { ok: false; reason: EntryRejection };

/* -------------------------------------------------------------------------- */
/* Natural sort                                                               */
/* -------------------------------------------------------------------------- */

const CHUNKS = /(\d+)|(\D+)/g;

/**
 * Compare two names the way a human orders pages: digit runs compare as
 * numbers, everything else compares case-insensitively, and identical text in
 * different cases still gets a stable tie-break.
 */
export function naturalCompare(a: string, b: string): number {
  const left = a.match(CHUNKS) ?? [];
  const right = b.match(CHUNKS) ?? [];
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    const x = left[i] ?? "";
    const y = right[i] ?? "";
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      // Compare as numbers, but fall back to length+string for runs too long
      // for a safe integer (a hash used as a filename).
      if (x.length <= 15 && y.length <= 15) {
        const diff = Number(x) - Number(y);
        if (diff !== 0) return diff < 0 ? -1 : 1;
      } else {
        const trimmedX = x.replace(/^0+(?=\d)/, "");
        const trimmedY = y.replace(/^0+(?=\d)/, "");
        if (trimmedX.length !== trimmedY.length) {
          return trimmedX.length < trimmedY.length ? -1 : 1;
        }
        if (trimmedX !== trimmedY) return trimmedX < trimmedY ? -1 : 1;
      }
      continue;
    }
    if (xNum !== yNum) return xNum ? -1 : 1;
    const lx = x.toLowerCase();
    const ly = y.toLowerCase();
    if (lx !== ly) return lx < ly ? -1 : 1;
  }
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Natural sort by archive entry path (directory first, then basename). */
export function sortImagesNaturally(images: ExtractedImage[]): ExtractedImage[] {
  return [...images].sort((a, b) => naturalCompare(a.name, b.name));
}

/* -------------------------------------------------------------------------- */
/* Entry validation                                                           */
/* -------------------------------------------------------------------------- */

/** Lowercase extension of a name, including the dot ("" when there is none). */
export function extensionOf(name: string): string {
  return path.posix.extname(name.replaceAll("\\", "/")).toLowerCase();
}

export function isImageName(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(name));
}

/**
 * Decide whether one archive entry may be written to disk. Rejections are
 * reasons, not errors: a CBZ that also contains `ComicInfo.xml` and a
 * `__MACOSX` shadow tree is perfectly normal and those entries are skipped.
 */
export function classifyArchiveEntry(fileName: string, uncompressedSize = 0): EntryDecision {
  const normalized = fileName.replaceAll("\\", "/");
  if (normalized.endsWith("/")) return { ok: false, reason: "directory" };
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    return { ok: false, reason: "absolute" };
  }
  const segments = normalized.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) return { ok: false, reason: "directory" };
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { ok: false, reason: "traversal" };
  }
  if (segments.some((segment) => segment === "__MACOSX")) {
    return { ok: false, reason: "macos-metadata" };
  }
  const base = segments[segments.length - 1] ?? "";
  if (base.startsWith(".")) return { ok: false, reason: "dotfile" };
  const ext = extensionOf(base);
  if (!IMAGE_EXTENSIONS.has(ext)) return { ok: false, reason: "not-an-image" };
  if (uncompressedSize > MAX_ENTRY_BYTES) return { ok: false, reason: "too-large" };
  return { ok: true, name: segments.join("/"), ext };
}

/* -------------------------------------------------------------------------- */
/* Extraction                                                                 */
/* -------------------------------------------------------------------------- */

export interface ExtractOptions {
  /** Called once per accepted entry, after it is on disk. */
  onFile?: (image: ExtractedImage, index: number) => void;
  /** Aborts the extraction between entries. */
  signal?: AbortSignal;
}

export class ArchiveError extends Error {
  readonly code: "INVALID_ARCHIVE" | "TOO_LARGE";
  constructor(code: "INVALID_ARCHIVE" | "TOO_LARGE", message: string) {
    super(message);
    this.name = "ArchiveError";
    this.code = code;
  }
}

/**
 * Extract every image in `archivePath` into `destDir`, flat, named
 * `entry-<ordinal><ext>` so two `001.jpg` in different folders cannot collide.
 * The returned list is in archive order; sort it with
 * {@link sortImagesNaturally} for reading order.
 */
export async function extractArchiveImages(
  archivePath: string,
  destDir: string,
  options: ExtractOptions = {},
): Promise<ExtractedImage[]> {
  await ensureDir(destDir);

  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(archivePath, { lazyEntries: true, validateEntrySizes: true });
  } catch (error) {
    throw new ArchiveError(
      "INVALID_ARCHIVE",
      `The archive could not be opened: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const images: ExtractedImage[] = [];
  let seen = 0;
  let totalBytes = 0;

  try {
    for await (const entry of zip.eachEntry()) {
      options.signal?.throwIfAborted();
      seen += 1;
      if (seen > MAX_ENTRIES) {
        throw new ArchiveError("TOO_LARGE", `The archive holds more than ${MAX_ENTRIES} entries`);
      }
      const decision = classifyArchiveEntry(entry.fileName, entry.uncompressedSize);
      if (!decision.ok) {
        if (decision.reason === "too-large") {
          throw new ArchiveError(
            "TOO_LARGE",
            `"${entry.fileName}" is larger than the ${MAX_ENTRY_BYTES} byte per-file limit`,
          );
        }
        continue;
      }
      totalBytes += entry.uncompressedSize;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new ArchiveError("TOO_LARGE", "The archive expands to more than the 4 GB limit");
      }

      const target = resolveInside(
        destDir,
        `entry-${String(images.length).padStart(5, "0")}${decision.ext}`,
      );
      const source = await zip.openReadStreamPromise(entry);
      await pipeline(source, createWriteStream(target));

      const image: ExtractedImage = {
        path: target,
        name: decision.name,
        bytes: entry.uncompressedSize,
        ext: decision.ext,
      };
      images.push(image);
      options.onFile?.(image, images.length);
    }
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ArchiveError(
      "INVALID_ARCHIVE",
      `The archive could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    zip.close();
  }

  return images;
}
