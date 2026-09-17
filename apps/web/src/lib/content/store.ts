/**
 * Content store paths.
 *
 * Everything Kiri writes to disk lives under `DATA_ROOT`:
 *
 *   DATA_ROOT/library/<seriesId>/manifest.json      plugin-owned manifest
 *   DATA_ROOT/library/<seriesId>/<chapterDir>/<file>
 *   DATA_ROOT/covers/<seriesId>/cover.webp
 *   DATA_ROOT/plugins/<pluginId>/
 *   DATA_ROOT/tmp/<name>/                           job scratch space
 *   DATA_ROOT/tmp/uploads/                          resumable upload chunks
 *
 * Keep this module tiny — it is the single place that turns ids into
 * filesystem paths, and every one of those paths goes through
 * {@link resolveInside} so a hostile id can never escape the root.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnv } from "@/lib/env";
import { sanitizePathSegment } from "@/lib/text";

/** The manifest a content-source plugin writes at the root of a series dir. */
export const MANIFEST_FILE = "manifest.json";

/** Absolute `DATA_ROOT` (defaults to `./data`, resolved against the cwd). */
export function getDataRoot(): string {
  return path.resolve(getEnv().DATA_ROOT);
}

/**
 * Join `segments` onto `base` and assert the result stays inside `base`.
 *
 * Segments are used verbatim — run anything user-supplied through
 * `sanitizePathSegment` first. The containment check is the backstop, and it
 * throws rather than silently clamping so a bug surfaces loudly instead of
 * quietly reading someone else's file.
 */
export function resolveInside(base: string, ...segments: string[]): string {
  const root = path.resolve(base);
  for (const segment of segments) {
    if (segment.includes("\0")) {
      throw new Error("Path segment contains a null byte");
    }
  }
  const target = path.resolve(root, ...segments);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to resolve "${segments.join("/")}" outside ${root}`);
  }
  return target;
}

/** `DATA_ROOT/covers/<seriesId>` — one directory per series. */
export function coversDir(seriesId: string): string {
  return resolveInside(getDataRoot(), "covers", sanitizePathSegment(seriesId));
}

/** `DATA_ROOT/library/<seriesId>` — manifest plus one directory per chapter. */
export function libraryDir(seriesId: string): string {
  return resolveInside(getDataRoot(), "library", sanitizePathSegment(seriesId));
}

/**
 * Directory name for a chapter slug. Empty slugs are refused outright: they
 * would collapse to the series directory itself and a delete would then take
 * the whole library with it.
 */
export function chapterDirName(slug: string): string {
  if (typeof slug !== "string" || slug.trim() === "") {
    throw new Error("Chapter slug must not be empty");
  }
  return sanitizePathSegment(slug);
}

/** `DATA_ROOT/library/<seriesId>/<chapterDir>`. */
export function chapterDir(seriesId: string, slug: string): string {
  return resolveInside(libraryDir(seriesId), chapterDirName(slug));
}

/**
 * Absolute path of one page file. `file` comes from the manifest (or a
 * `Page.file` column), so every path element is sanitised — a plugin that
 * writes `../../etc/passwd` gets `.._.._etc_passwd` inside its own chapter
 * directory instead of an escape.
 */
export function chapterFilePath(seriesId: string, slug: string, file: string): string {
  const parts = file
    .split(/[\/]+/)
    .filter((part) => part !== "" && part !== ".")
    .map(sanitizePathSegment);
  if (parts.length === 0) {
    throw new Error("Page file name must not be empty");
  }
  return resolveInside(chapterDir(seriesId, slug), ...parts);
}

/** `DATA_ROOT/library/<seriesId>/manifest.json`. */
export function manifestPath(seriesId: string): string {
  return resolveInside(libraryDir(seriesId), MANIFEST_FILE);
}

/** `DATA_ROOT/tmp/<name>` — per-job scratch space. */
export function tmpDir(name: string): string {
  return resolveInside(getDataRoot(), "tmp", sanitizePathSegment(name));
}

/** `DATA_ROOT/plugins` — one directory per installed plugin. */
export function pluginsDir(): string {
  return resolveInside(getDataRoot(), "plugins");
}

/** `DATA_ROOT/tmp/uploads` — chunks of in-flight resumable uploads. */
export function uploadsDir(): string {
  return resolveInside(getDataRoot(), "tmp", "uploads");
}

/** `mkdir -p`. Safe to call repeatedly. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Write via a temp file in the same directory plus a rename, so a reader
 * never sees a half-written manifest and a crash leaves the previous version
 * intact. The parent directory is created if missing.
 */
export async function writeFileAtomic(target: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(target);
  await ensureDir(dir);
  const temp = path.join(dir, `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, data);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * Read and parse a JSON file. A missing file is `null` (the common "nothing
 * synced yet" case); malformed JSON throws, because silently treating a
 * corrupt manifest as empty would flag every chapter as vanished.
 */
export async function readJsonFile<T = unknown>(file: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    throw new Error(`${file} is not valid JSON`, { cause });
  }
}

/**
 * Recursive delete restricted to paths *strictly* inside `DATA_ROOT` — the
 * root itself is refused, so a bug can never wipe the whole store. A missing
 * directory is not an error.
 */
export async function removeDirSafe(dir: string): Promise<void> {
  const root = getDataRoot();
  const target = path.resolve(dir);
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove ${target}: outside the content store`);
  }
  await rm(target, { recursive: true, force: true });
}

/** Remove one chapter's images. Used when a chapter row is deleted. */
export async function removeChapterDir(seriesId: string, slug: string): Promise<void> {
  await removeDirSafe(chapterDir(seriesId, slug));
}

/** Remove a series' whole library directory (manifest and every chapter). */
export async function removeLibraryDir(seriesId: string): Promise<void> {
  await removeDirSafe(libraryDir(seriesId));
}
