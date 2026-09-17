/**
 * Manifest v2 — the on-disk contract between a plugin and Kiri's ingest step.
 *
 * `<seriesDir>/manifest.json` is the plugin's only output besides image files.
 * v2 is a superset of the V1 ripper manifest, so a V1 directory ingests
 * unchanged. The host reads it tolerantly (`apps/web/src/lib/content/manifest.ts`)
 * — this module is the *writer* side and keeps the shape strict.
 *
 * Writes are atomic (temp file + rename), and `definePlugin` rewrites the
 * manifest after every chapter so a killed sync always leaves a consistent,
 * resumable file behind.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { PluginError } from "./errors.js";
import type { ChapterStatus } from "./protocol.js";

/** Manifest schema version written by this SDK. */
export const MANIFEST_VERSION = 2 as const;
/** File name inside the series directory. */
export const MANIFEST_FILE = "manifest.json";

export interface ManifestImage {
  /** 1-based page index. */
  index: number;
  /** Source URL the bytes came from (after redirects). */
  url: string;
  /** File name relative to the chapter directory. */
  file: string;
  bytes: number;
  sha256: string;
  width?: number;
  height?: number;
  mime?: string;
}

export interface ManifestChapter {
  slug: string;
  /** Stable id at the source; ingest merges on this before `slug`. */
  externalId?: string;
  url: string;
  title: string;
  /** Sort key from the source when it differs from `number`. */
  chapterOrder?: number;
  number?: number;
  volume?: string;
  /** ISO 8601. */
  releaseDate?: string;
  /** Whatever the site printed ("3 days ago"), kept verbatim. */
  releaseDateText?: string;
  status: ChapterStatus;
  imageCount: number;
  /** ISO 8601, set when the chapter completed. */
  downloadedAt?: string;
  images: ManifestImage[];
  lastError?: string;
  /** The chapter was in a previous run but the source no longer lists it. */
  missingFromSource?: boolean;
  source: "plugin";
}

export interface ManifestSeries {
  url: string;
  slug: string;
  title: string;
  /** Source-side id (MangaDex uuid, …). */
  id?: string;
  /** `MANGA | MANHWA | MANHUA | COMIC | LIGHT_NOVEL | NOVEL | BOOK | OTHER`. */
  mediaType?: string;
  /** Cover file name inside the series directory, e.g. `cover.jpg`. */
  coverFile?: string;
}

export interface Manifest {
  version: number;
  /** Plugin id that owns this directory. */
  site: string;
  createdAt: string;
  updatedAt: string;
  series: ManifestSeries;
  chapters: ManifestChapter[];
}

/** What `listChapters` returns; the merge turns these into manifest chapters. */
export interface DiscoveredChapter {
  slug: string;
  externalId?: string;
  url: string;
  title?: string;
  chapterOrder?: number;
  number?: number;
  volume?: string;
  releaseDate?: string;
  releaseDateText?: string;
}

/* -------------------------------------------------------------------------- */
/* Paths                                                                      */
/* -------------------------------------------------------------------------- */

/** Characters no filesystem Kiri targets (Windows included) accepts. */
const UNSAFE_SEGMENT = /[<>:"/\\|?*\x00-\x1f]/g;

/**
 * Turn any string into one safe path segment: unsafe characters become `_`,
 * trailing dots/spaces are dropped (Windows silently strips them) and the
 * result is capped so `<seriesDir>/<segment>/<file>` stays well under PATH_MAX.
 */
export function sanitizePathSegment(value: string, fallback = "untitled"): string {
  const cleaned = value
    .normalize("NFC")
    .replace(UNSAFE_SEGMENT, "_")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .slice(0, 120)
    .trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return fallback;
  // CON, PRN, AUX, NUL, COM1…, LPT1… are unusable as file names on Windows.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(cleaned)) return `_${cleaned}`;
  return cleaned;
}

/** Directory a chapter's images live in, relative to the series directory. */
export function chapterDirName(slug: string): string {
  return sanitizePathSegment(slug, "chapter");
}

/** Zero-padded page file name: `001.jpg`, `0001.jpg` for 1000+ page chapters. */
export function pageFileName(index: number, total: number, ext: string): string {
  const width = Math.max(3, String(Math.max(total, 1)).length);
  const normalizedExt = ext.startsWith(".") ? ext : `.${ext}`;
  return `${String(Math.max(1, Math.trunc(index))).padStart(width, "0")}${normalizedExt}`;
}

export function manifestPath(dir: string): string {
  return path.join(dir, MANIFEST_FILE);
}

/* -------------------------------------------------------------------------- */
/* Read / write                                                               */
/* -------------------------------------------------------------------------- */

export interface ManifestDefaults {
  site?: string;
  series?: Partial<ManifestSeries>;
}

/** A fresh, empty manifest. */
export function createManifest(defaults: ManifestDefaults = {}): Manifest {
  const now = new Date().toISOString();
  return {
    version: MANIFEST_VERSION,
    site: defaults.site ?? "",
    createdAt: now,
    updatedAt: now,
    series: {
      url: defaults.series?.url ?? "",
      slug: defaults.series?.slug ?? "",
      title: defaults.series?.title ?? "",
      ...(defaults.series?.id === undefined ? {} : { id: defaults.series.id }),
      ...(defaults.series?.mediaType === undefined ? {} : { mediaType: defaults.series.mediaType }),
      ...(defaults.series?.coverFile === undefined ? {} : { coverFile: defaults.series.coverFile }),
    },
    chapters: [],
  };
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function coerceText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function coerceImage(value: unknown, position: number): ManifestImage | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const file = coerceText(raw["file"]);
  if (file === undefined) return null;
  const image: ManifestImage = {
    index: coerceNumber(raw["index"]) ?? position + 1,
    url: coerceText(raw["url"]) ?? "",
    file,
    bytes: coerceNumber(raw["bytes"]) ?? 0,
    sha256: coerceText(raw["sha256"]) ?? "",
  };
  const width = coerceNumber(raw["width"]);
  if (width !== undefined && width > 0) image.width = width;
  const height = coerceNumber(raw["height"]);
  if (height !== undefined && height > 0) image.height = height;
  const mime = coerceText(raw["mime"]);
  if (mime !== undefined) image.mime = mime;
  return image;
}

function coerceChapter(value: unknown): ManifestChapter | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const slug = coerceText(raw["slug"]);
  if (slug === undefined) return null;
  const status = coerceText(raw["status"]);
  const images = Array.isArray(raw["images"])
    ? raw["images"]
        .map((image, position) => coerceImage(image, position))
        .filter((image): image is ManifestImage => image !== null)
    : [];
  const chapter: ManifestChapter = {
    slug,
    url: coerceText(raw["url"]) ?? "",
    title: coerceText(raw["title"]) ?? slug,
    status:
      status === "completed" || status === "downloading" || status === "failed"
        ? status
        : "pending",
    imageCount: coerceNumber(raw["imageCount"]) ?? images.length,
    images,
    source: "plugin",
  };
  const externalId = coerceText(raw["externalId"]);
  if (externalId !== undefined) chapter.externalId = externalId;
  const chapterOrder = coerceNumber(raw["chapterOrder"]);
  if (chapterOrder !== undefined) chapter.chapterOrder = chapterOrder;
  const number = coerceNumber(raw["number"]);
  if (number !== undefined) chapter.number = number;
  const volume = coerceText(raw["volume"]);
  if (volume !== undefined) chapter.volume = volume;
  const releaseDate = coerceText(raw["releaseDate"]);
  if (releaseDate !== undefined) chapter.releaseDate = releaseDate;
  const releaseDateText = coerceText(raw["releaseDateText"]);
  if (releaseDateText !== undefined) chapter.releaseDateText = releaseDateText;
  const downloadedAt = coerceText(raw["downloadedAt"]);
  if (downloadedAt !== undefined) chapter.downloadedAt = downloadedAt;
  const lastError = coerceText(raw["lastError"]);
  if (lastError !== undefined) chapter.lastError = lastError;
  if (raw["missingFromSource"] === true) chapter.missingFromSource = true;
  return chapter;
}

/**
 * Read `<dir>/manifest.json`. A missing or unreadable file yields a default
 * manifest — a plugin must be able to run against an empty directory. Only an
 * I/O error other than "not found" is surfaced (as `IO`).
 */
export async function readManifest(
  dir: string,
  defaults: ManifestDefaults = {},
): Promise<Manifest> {
  const file = manifestPath(dir);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return createManifest(defaults);
    throw new PluginError("IO", `Cannot read ${file}: ${(cause as Error).message}`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A truncated manifest from a hard kill must not brick the series; start
    // over rather than fail (the images on disk are re-adopted by `verify`).
    return createManifest(defaults);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return createManifest(defaults);
  }

  const raw = parsed as Record<string, unknown>;
  const base = createManifest(defaults);
  const rawSeries =
    typeof raw["series"] === "object" && raw["series"] !== null
      ? (raw["series"] as Record<string, unknown>)
      : {};
  const series: ManifestSeries = {
    url: coerceText(rawSeries["url"]) ?? base.series.url,
    slug: coerceText(rawSeries["slug"]) ?? base.series.slug,
    title: coerceText(rawSeries["title"]) ?? base.series.title,
  };
  const id = coerceText(rawSeries["id"]) ?? base.series.id;
  if (id !== undefined) series.id = id;
  const mediaType = coerceText(rawSeries["mediaType"]) ?? base.series.mediaType;
  if (mediaType !== undefined) series.mediaType = mediaType;
  const coverFile = coerceText(rawSeries["coverFile"]) ?? base.series.coverFile;
  if (coverFile !== undefined) series.coverFile = coverFile;

  const chapters = Array.isArray(raw["chapters"])
    ? raw["chapters"]
        .map((chapter) => coerceChapter(chapter))
        .filter((chapter): chapter is ManifestChapter => chapter !== null)
    : [];

  return {
    version: coerceNumber(raw["version"]) ?? MANIFEST_VERSION,
    site: coerceText(raw["site"]) ?? base.site,
    createdAt: coerceText(raw["createdAt"]) ?? base.createdAt,
    updatedAt: coerceText(raw["updatedAt"]) ?? base.updatedAt,
    series,
    chapters,
  };
}

/**
 * Write the manifest atomically (temp file + rename in the same directory), so
 * a crash mid-write can never leave a truncated JSON file. `updatedAt` is
 * stamped on the passed object as a side effect, matching V1 behaviour.
 */
export async function writeManifest(dir: string, manifest: Manifest): Promise<void> {
  manifest.version = manifest.version || MANIFEST_VERSION;
  manifest.updatedAt = new Date().toISOString();
  const file = manifestPath(dir);
  const temp = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await rename(temp, file);
  } catch (cause) {
    throw new PluginError("IO", `Cannot write ${file}: ${(cause as Error).message}`, { cause });
  }
}

/* -------------------------------------------------------------------------- */
/* Merge                                                                      */
/* -------------------------------------------------------------------------- */

function sortKey(chapter: { chapterOrder?: number; number?: number }, fallback: number): number {
  if (typeof chapter.chapterOrder === "number" && Number.isFinite(chapter.chapterOrder)) {
    return chapter.chapterOrder;
  }
  if (typeof chapter.number === "number" && Number.isFinite(chapter.number)) return chapter.number;
  return fallback;
}

/**
 * Fold a fresh `listChapters` result into an existing manifest.
 *
 *  - a chapter already `completed` keeps its status, `images`, `imageCount` and
 *    `downloadedAt` (metadata such as title/date is refreshed from the source);
 *  - a new chapter is added as `pending` with no images;
 *  - a chapter that vanished from the source is **kept** and flagged
 *    `missingFromSource: true` (Kiri never deletes what the user downloaded);
 *  - the result is ordered by `chapterOrder ?? number`; when the source exposes
 *    neither, discovery order is preserved and vanished chapters are appended.
 *
 * Returns a new manifest object; the input is not mutated.
 */
export function mergeDiscoveredChapters(
  manifest: Manifest,
  discovered: readonly DiscoveredChapter[],
): Manifest {
  const existingBySlug = new Map(manifest.chapters.map((chapter) => [chapter.slug, chapter]));
  const existingByExternalId = new Map(
    manifest.chapters
      .filter((chapter) => chapter.externalId !== undefined)
      .map((chapter) => [chapter.externalId as string, chapter]),
  );

  const merged: ManifestChapter[] = [];
  const claimed = new Set<string>();
  const keys: number[] = [];
  let hasOrdering = false;

  discovered.forEach((entry, position) => {
    const existing =
      (entry.externalId !== undefined ? existingByExternalId.get(entry.externalId) : undefined) ??
      existingBySlug.get(entry.slug);
    if (existing) claimed.add(existing.slug);

    const chapter: ManifestChapter = {
      slug: entry.slug,
      url: entry.url,
      title: entry.title ?? existing?.title ?? entry.slug,
      status: existing?.status ?? "pending",
      imageCount: existing?.imageCount ?? 0,
      images: existing?.images ?? [],
      source: "plugin",
    };
    // `downloading` is never a resting state: a previous run was killed.
    if (chapter.status === "downloading") chapter.status = "pending";

    const externalId = entry.externalId ?? existing?.externalId;
    if (externalId !== undefined) chapter.externalId = externalId;
    const chapterOrder = entry.chapterOrder ?? existing?.chapterOrder;
    if (chapterOrder !== undefined) chapter.chapterOrder = chapterOrder;
    const number = entry.number ?? existing?.number;
    if (number !== undefined) chapter.number = number;
    const volume = entry.volume ?? existing?.volume;
    if (volume !== undefined) chapter.volume = volume;
    const releaseDate = entry.releaseDate ?? existing?.releaseDate;
    if (releaseDate !== undefined) chapter.releaseDate = releaseDate;
    const releaseDateText = entry.releaseDateText ?? existing?.releaseDateText;
    if (releaseDateText !== undefined) chapter.releaseDateText = releaseDateText;
    if (existing?.downloadedAt !== undefined) chapter.downloadedAt = existing.downloadedAt;
    if (existing?.lastError !== undefined && existing.status === "failed") {
      chapter.lastError = existing.lastError;
    }

    if (entry.chapterOrder !== undefined || entry.number !== undefined) hasOrdering = true;
    merged.push(chapter);
    keys.push(sortKey(chapter, position));
  });

  manifest.chapters.forEach((chapter, position) => {
    if (claimed.has(chapter.slug)) return;
    merged.push({ ...chapter, missingFromSource: true });
    keys.push(sortKey(chapter, discovered.length + position));
    if (chapter.chapterOrder !== undefined || chapter.number !== undefined) hasOrdering = true;
  });

  const chapters = hasOrdering
    ? merged
        .map((chapter, position) => ({ chapter, key: keys[position] ?? position, position }))
        .sort((a, b) => (a.key === b.key ? a.position - b.position : a.key - b.key))
        .map((entry) => entry.chapter)
    : merged;

  return { ...manifest, chapters };
}

/** Find a chapter by slug (helper for hosts and tests). */
export function findChapter(manifest: Manifest, slug: string): ManifestChapter | undefined {
  return manifest.chapters.find((chapter) => chapter.slug === slug);
}
