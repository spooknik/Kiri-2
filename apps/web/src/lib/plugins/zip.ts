/**
 * General-purpose, hostile-input-safe zip extraction.
 *
 * `src/lib/uploads/archive.ts` extracts *images only* out of a CBZ; a plugin
 * zip is a whole source tree, so it needs its own extractor with the same
 * paranoia and none of the image filtering:
 *
 *   - no absolute paths, no drive letters, no `..`, no null bytes;
 *   - no symlink entries (a symlink to `/etc` would make the next step read it);
 *   - hard caps on entry count, per-entry bytes and total bytes (zip bomb);
 *   - every write goes through `resolveInside`, which is the backstop that
 *     turns a crafted name into a thrown error rather than a file outside the
 *     destination.
 *
 * GitHub's "Download ZIP" wraps everything in a `<repo>-<ref>/` folder, so a
 * single shared top-level directory is stripped: the descriptor has to be at
 * the root of what we extract.
 */
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import path from "node:path";
import yauzl from "yauzl";
import { ensureDir, resolveInside } from "@/lib/content/store";

/** Entry-count ceiling for one plugin zip. */
export const MAX_ENTRIES = 5000;
/** Total extracted bytes: the zip-bomb backstop. */
export const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
/** Per-file ceiling. */
export const MAX_ENTRY_BYTES = 100 * 1024 * 1024;

/** Unix file type bits live in the high half of the external attributes. */
const UNIX_MODE_SHIFT = 16;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

export type ZipErrorCode =
  | "UNREADABLE"
  | "TOO_MANY_ENTRIES"
  | "TOO_LARGE"
  | "UNSAFE_PATH"
  | "SYMLINK"
  | "EMPTY"
  | "CANCELLED";

export class ZipError extends Error {
  readonly code: ZipErrorCode;
  constructor(code: ZipErrorCode, message: string) {
    super(message);
    this.name = "ZipError";
    this.code = code;
  }
}

export interface ExtractZipOptions {
  maxEntries?: number;
  maxTotalBytes?: number;
  maxEntryBytes?: number;
  signal?: AbortSignal;
}

export interface ExtractZipResult {
  files: number;
  bytes: number;
  /** The single top-level folder that was stripped, when there was one. */
  strippedRoot: string | null;
}

/* -------------------------------------------------------------------------- */
/* Entry names                                                                */
/* -------------------------------------------------------------------------- */

export type EntryVerdict =
  { ok: true; segments: string[] } | { ok: false; reason: "directory" | "unsafe" };

/**
 * Turn a zip entry name into the path segments it may be written to, or
 * refuse it. Directory entries are reported separately because they are normal
 * and simply carry no bytes.
 */
export function classifyEntry(fileName: string): EntryVerdict {
  if (fileName.includes("\0")) return { ok: false, reason: "unsafe" };
  const normalized = fileName.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    return { ok: false, reason: "unsafe" };
  }
  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) return { ok: false, reason: "unsafe" };
  // Windows reserves these; a name ending in a dot or space is also trouble.
  if (segments.some((segment) => segment.endsWith(" "))) return { ok: false, reason: "unsafe" };
  if (segments.length === 0 || normalized.endsWith("/")) return { ok: false, reason: "directory" };
  return { ok: true, segments };
}

/**
 * The single top-level directory every file entry shares, or null. Used to
 * flatten a GitHub archive; a zip whose root already holds files is untouched.
 */
export function commonRoot(entryPaths: readonly string[][]): string | null {
  let root: string | null = null;
  for (const segments of entryPaths) {
    if (segments.length < 2) return null;
    const first = segments[0];
    if (first === undefined) return null;
    if (root === null) root = first;
    else if (root !== first) return null;
  }
  return root;
}

function isSymlinkEntry(entry: yauzl.Entry): boolean {
  const mode = (entry.externalFileAttributes >>> UNIX_MODE_SHIFT) & 0xffff;
  return (mode & S_IFMT) === S_IFLNK;
}

/**
 * yauzl validates entry names itself and rejects the archive before our own
 * classifier ever sees the entry. Its complaints are plain `Error`s, so they
 * are re-labelled here — a traversal attempt must look the same whichever
 * layer caught it.
 */
const YAUZL_NAME_ERROR = /^(absolute path|invalid relative path|invalid characters in fileName)/;

function asZipError(error: unknown): ZipError {
  if (error instanceof ZipError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (YAUZL_NAME_ERROR.test(message)) {
    return new ZipError("UNSAFE_PATH", `Refusing unsafe entry — ${message}`);
  }
  return new ZipError("UNREADABLE", `Could not read the archive: ${message}`);
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(
          new ZipError("UNREADABLE", `Not a readable zip archive: ${error?.message ?? zipPath}`),
        );
        return;
      }
      resolve(zipFile);
    });
  });
}

/** Walk every central-directory entry, calling `visit` for each. */
async function forEachEntry(
  zipFile: yauzl.ZipFile,
  visit: (entry: yauzl.Entry) => Promise<void> | void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    zipFile.on("error", fail);
    zipFile.on("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zipFile.on("entry", (entry: yauzl.Entry) => {
      void (async () => {
        try {
          await visit(entry);
          if (!settled) zipFile.readEntry();
        } catch (error) {
          fail(error);
        }
      })();
    });
    zipFile.readEntry();
  });
}

function openEntryStream(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(
          new ZipError(
            "UNREADABLE",
            `Cannot read ${entry.fileName}: ${error?.message ?? "no stream"}`,
          ),
        );
        return;
      }
      resolve(stream);
    });
  });
}

/**
 * Counts bytes as they pass and trips the per-entry ceiling mid-stream (the
 * central directory can lie about `uncompressedSize`). `onBytes` returns an
 * error to stop the pipeline — never throws, because a synchronous throw out
 * of `_transform` is not caught by Node and would take the process down.
 */
function limiter(limit: number, name: string, onBytes: (delta: number) => Error | null): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > limit) {
        callback(new ZipError("TOO_LARGE", `${name} is larger than ${limit} bytes`));
        return;
      }
      const error = onBytes(chunk.length);
      if (error) {
        callback(error);
        return;
      }
      callback(null, chunk);
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Extraction                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Extract `zipPath` into `destDir`, which is created if missing. Returns how
 * much was written; throws {@link ZipError} on anything suspicious.
 *
 * The archive is opened twice: once to read the central directory (so the
 * shared top-level folder is known before a single byte is written) and once
 * to stream the entries out.
 */
export async function extractZipSafely(
  zipPath: string,
  destDir: string,
  options: ExtractZipOptions = {},
): Promise<ExtractZipResult> {
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const maxEntryBytes = options.maxEntryBytes ?? MAX_ENTRY_BYTES;

  const plan: { entryName: string; segments: string[] }[] = [];
  const listing = await openZip(zipPath);
  try {
    await forEachEntry(listing, (entry: yauzl.Entry) => {
      if (plan.length >= maxEntries) {
        throw new ZipError("TOO_MANY_ENTRIES", `The archive has more than ${maxEntries} entries`);
      }
      if (isSymlinkEntry(entry)) {
        throw new ZipError("SYMLINK", `Refusing symlink entry "${entry.fileName}"`);
      }
      const verdict = classifyEntry(entry.fileName);
      if (!verdict.ok) {
        if (verdict.reason === "directory") return;
        throw new ZipError("UNSAFE_PATH", `Refusing unsafe entry "${entry.fileName}"`);
      }
      if (entry.uncompressedSize > maxEntryBytes) {
        throw new ZipError(
          "TOO_LARGE",
          `"${entry.fileName}" is larger than ${maxEntryBytes} bytes`,
        );
      }
      plan.push({ entryName: entry.fileName, segments: verdict.segments });
    });
  } catch (error) {
    throw asZipError(error);
  } finally {
    listing.close();
  }

  if (plan.length === 0) throw new ZipError("EMPTY", "The archive contains no files");

  const root = commonRoot(plan.map((item) => item.segments));
  const targets = new Map<string, string[]>();
  for (const item of plan) {
    targets.set(item.entryName, root === null ? item.segments : item.segments.slice(1));
  }

  await ensureDir(destDir);
  let bytes = 0;
  let files = 0;

  const zipFile = await openZip(zipPath);
  try {
    await forEachEntry(zipFile, async (entry) => {
      if (options.signal?.aborted) throw new ZipError("CANCELLED", "Extraction was cancelled");
      const segments = targets.get(entry.fileName);
      if (!segments || segments.length === 0) return;

      const target = resolveInside(destDir, ...segments);
      await ensureDir(path.dirname(target));

      const source = await openEntryStream(zipFile, entry);
      const counted = limiter(maxEntryBytes, entry.fileName, (delta) => {
        bytes += delta;
        return bytes > maxTotalBytes
          ? new ZipError("TOO_LARGE", `The archive expands past ${maxTotalBytes} bytes`)
          : null;
      });
      await pipeline(source, counted, createWriteStream(target));
      files += 1;
    });
  } catch (error) {
    throw asZipError(error);
  } finally {
    zipFile.close();
  }

  return { files, bytes, strippedRoot: root };
}
