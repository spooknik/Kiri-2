/**
 * Manifest v2 — the on-disk contract between a content-source plugin and the
 * ingest step.
 *
 * v2 is a *tolerant superset* of the V1 manifest (`tools/<site>-ripper` wrote
 * `{ version, site, series, chapters[{ slug, images[] }] }`), so an untouched
 * V1 directory ingests unchanged. Tolerance is the point: a manifest is written
 * by third-party plugin code, so odd values must degrade to `undefined` and be
 * reported as warnings instead of failing a whole sync. The only hard failures
 * are "file missing" and "not JSON / not an object".
 *
 * Parsing happens in two steps:
 *   1. a zod schema that never rejects a *field* (unknown shapes become
 *      `undefined`, unparseable array elements become `{}`);
 *   2. {@link normalizeManifest}, which drops what cannot be used at all
 *      (chapters without a slug, images without a file) and collects warnings.
 */
import { z } from "zod";
import { manifestPath, readJsonFile } from "@/lib/content/store";

/** Thrown when a manifest cannot be read at all. */
export class ManifestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ManifestError";
  }
}

export const MANIFEST_CHAPTER_STATUSES = ["pending", "downloading", "completed", "failed"] as const;
export type ManifestChapterStatus = (typeof MANIFEST_CHAPTER_STATUSES)[number];

export const MANIFEST_CHAPTER_SOURCES = ["plugin", "manual", "pdf"] as const;
export type ManifestChapterSource = (typeof MANIFEST_CHAPTER_SOURCES)[number];

/** Warnings past this point are collapsed into a single "N more" line. */
const MAX_WARNINGS = 50;
/** V1 thumbnail heuristic: a WordPress variant this small is never a page. */
const THUMBNAIL_MAX_DIMENSION = 400;

/* -------------------------------------------------------------------------- */
/* Tolerant field parsers                                                     */
/* -------------------------------------------------------------------------- */

function asText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  // Plugins that keep ids as numbers (MangaDex chapter ids, episode ids).
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asInteger(value: unknown): number | undefined {
  const parsed = asNumber(value);
  return parsed === undefined ? undefined : Math.trunc(parsed);
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

// `.optional()` is load-bearing: without it zod 4 reports a *missing* key as
// "expected nonoptional", which would fail the whole manifest.
const text = z.unknown().transform(asText).optional();
const integer = z.unknown().transform(asInteger).optional();
const decimal = z.unknown().transform(asNumber).optional();
const flag = z.unknown().transform(asBoolean).optional();

/** Lower-case, then match the closed set; anything else degrades to undefined. */
function looseEnum<T extends readonly [string, ...string[]]>(values: T) {
  return z
    .unknown()
    .transform((value) => asText(value)?.toLowerCase())
    .pipe(z.enum(values).optional().catch(undefined))
    .optional();
}

/* -------------------------------------------------------------------------- */
/* Schema                                                                     */
/* -------------------------------------------------------------------------- */

const manifestImageSchema = z.object({
  index: integer,
  url: text,
  file: text,
  bytes: integer,
  sha256: text,
  width: integer,
  height: integer,
  mime: text,
});
type RawManifestImage = z.infer<typeof manifestImageSchema>;

const manifestChapterSchema = z.object({
  slug: text,
  externalId: text,
  url: text,
  title: text,
  chapterOrder: decimal,
  number: decimal,
  volume: text,
  releaseDate: text,
  releaseDateText: text,
  status: looseEnum(MANIFEST_CHAPTER_STATUSES),
  imageCount: integer,
  downloadedAt: text,
  // An element that is not an object at all becomes an empty image and is
  // dropped by the normaliser (no `file`).
  images: z.array(manifestImageSchema.catch(() => ({}) as RawManifestImage)).catch(() => []),
  lastError: text,
  missingFromSource: flag,
  source: looseEnum(MANIFEST_CHAPTER_SOURCES),
});
type RawManifestChapter = z.infer<typeof manifestChapterSchema>;

const manifestSeriesSchema = z.object({
  url: text,
  slug: text,
  title: text,
  id: text,
  mediaType: text,
  coverFile: text,
});

/** The raw, never-rejecting shape. {@link normalizeManifest} refines it. */
export const manifestSchema = z.object({
  version: integer,
  site: text,
  createdAt: text,
  updatedAt: text,
  series: manifestSeriesSchema.optional().catch(undefined),
  chapters: z.array(manifestChapterSchema.catch(() => ({}) as RawManifestChapter)).catch(() => []),
});

/* -------------------------------------------------------------------------- */
/* Normalised types                                                           */
/* -------------------------------------------------------------------------- */

export interface ManifestImage {
  /** 1-based; falls back to the array position when the manifest omits it. */
  index: number;
  file: string;
  url?: string;
  bytes?: number;
  sha256?: string;
  width?: number;
  height?: number;
  mime?: string;
}

export interface ManifestChapter {
  slug: string;
  externalId?: string;
  url?: string;
  title?: string;
  chapterOrder?: number;
  number?: number;
  volume?: string;
  releaseDate?: string;
  releaseDateText?: string;
  status?: ManifestChapterStatus;
  imageCount?: number;
  downloadedAt?: string;
  images: ManifestImage[];
  lastError?: string;
  missingFromSource?: boolean;
  /** Absent means "plugin"; V1 wrote "manual" for uploaded chapters. */
  source?: ManifestChapterSource;
}

export interface ManifestSeries {
  url?: string;
  slug?: string;
  title?: string;
  id?: string;
  mediaType?: string;
  coverFile?: string;
}

export interface Manifest {
  version?: number;
  site?: string;
  createdAt?: string;
  updatedAt?: string;
  series?: ManifestSeries;
  chapters: ManifestChapter[];
}

export interface ParsedManifest {
  manifest: Manifest;
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/* Placeholder / thumbnail URLs (ported from V1 reader-manifest.ts)           */
/* -------------------------------------------------------------------------- */

function parseImageDimension(value: string): number | null {
  const match = value.trim().match(/^(\d{1,5})(?:px)?$/i);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isLikelyPlaceholderImageUrl(parsed: URL): boolean {
  const pathname = parsed.pathname.toLowerCase();
  return (
    pathname.includes("/wp-content/themes/") &&
    /(?:^|\/)(?:dflazy|placeholder|spacer)\.(?:jpg|jpeg|png|webp|gif|avif)$/.test(pathname)
  );
}

function isLikelyThumbnailVariantUrl(parsed: URL): boolean {
  const pathname = parsed.pathname.toLowerCase();
  if (!pathname.includes("/wp-content/uploads/")) return false;

  const fileName = pathname.split("/").pop() ?? "";
  const sizeMatch = fileName.match(/-(\d{2,4})x(\d{2,4})(?=\.[a-z0-9]+$)/i);
  if (sizeMatch?.[1] && sizeMatch[2]) {
    const width = Number.parseInt(sizeMatch[1], 10);
    const height = Number.parseInt(sizeMatch[2], 10);
    if (width <= THUMBNAIL_MAX_DIMENSION && height <= THUMBNAIL_MAX_DIMENSION) return true;
  }

  const queryWidth = parsed.searchParams.get("w");
  const queryHeight = parsed.searchParams.get("h");
  if (!queryWidth || !queryHeight) return false;
  const width = parseImageDimension(queryWidth);
  const height = parseImageDimension(queryHeight);
  return (
    width !== null &&
    height !== null &&
    width <= THUMBNAIL_MAX_DIMENSION &&
    height <= THUMBNAIL_MAX_DIMENSION
  );
}

/**
 * V1 heuristic for "this URL is site furniture, not a page".
 *
 * In V2 it is *advisory only*: files on disk are authoritative, so a page whose
 * file exists is always ingested and a suspicious source URL only produces a
 * warning. Plugins (and `verify`) use the predicate before downloading.
 */
export function isLikelyNonChapterImageUrl(imageUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return false;
  }
  return isLikelyPlaceholderImageUrl(parsed) || isLikelyThumbnailVariantUrl(parsed);
}

/* -------------------------------------------------------------------------- */
/* Chapter number derivation (ported from V1 reader-manifest.ts)              */
/* -------------------------------------------------------------------------- */

/**
 * `chapter-12-5`, `ch. 12.5`, `episode 3`, `vol 2 ch 7`, `Chapter 7: Title`.
 * Longer keywords come first so `chapter` is never matched as bare `ch`.
 */
const KEYWORD_NUMBER =
  /(?:^|[^a-z0-9])(?:chapters?|chap|ch|episodes?|ep|parts?|pt)[\s._-]*(\d{1,5})(?:[.\-_](\d{1,3}))?(?!\d)/i;
/** A slug or title that is nothing but a number ("12", "12.5", "0007"). */
const BARE_NUMBER = /^(\d{1,5})(?:[.\-_](\d{1,3}))?$/;

function combine(majorText: string, minorText: string | undefined): number | null {
  const major = Number.parseInt(majorText, 10);
  if (!Number.isFinite(major)) return null;
  if (minorText === undefined || minorText === "") return major;
  const minor = Number.parseInt(minorText, 10);
  if (!Number.isFinite(minor)) return major;
  // "chapter-12-5" is 12.5, "chapter-12-25" is 12.25 (V1 semantics).
  return major + minor / 10 ** minorText.length;
}

function fromText(value: string | undefined): number | null {
  if (!value) return null;
  const keyword = value.match(KEYWORD_NUMBER);
  if (keyword?.[1]) {
    const parsed = combine(keyword[1], keyword[2]);
    if (parsed !== null) return parsed;
  }
  const bare = value.trim().match(BARE_NUMBER);
  if (bare?.[1]) return combine(bare[1], bare[2]);
  return null;
}

export interface ChapterNumberSource {
  number?: number | null;
  chapterOrder?: number | null;
  slug?: string;
  title?: string;
}

/**
 * Chapter number, in order of trust: an explicit `number`, the plugin's
 * `chapterOrder`, then a keyword match on the slug and finally on the title.
 * Unknown stays `null` — the sort falls back to discovery order, which is
 * better than inventing a number that would reorder a shelf.
 */
export function deriveChapterNumber(chapter: ChapterNumberSource): number | null {
  for (const candidate of [chapter.number, chapter.chapterOrder]) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  return fromText(chapter.slug) ?? fromText(chapter.title);
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* -------------------------------------------------------------------------- */

class WarningLog {
  private readonly lines: string[] = [];
  private overflow = 0;

  push(line: string): void {
    if (this.lines.length >= MAX_WARNINGS) {
      this.overflow += 1;
      return;
    }
    this.lines.push(line);
  }

  toArray(): string[] {
    return this.overflow > 0
      ? [...this.lines, `… ${this.overflow} more warnings`]
      : [...this.lines];
  }
}

function normalizeImages(
  raw: RawManifestImage[],
  chapterSlug: string,
  warnings: WarningLog,
): ManifestImage[] {
  const images: ManifestImage[] = [];
  const seenIndexes = new Set<number>();
  let withoutFile = 0;

  raw.forEach((image, position) => {
    if (!image.file) {
      withoutFile += 1;
      return;
    }
    const index = image.index !== undefined && image.index >= 1 ? image.index : position + 1;
    if (seenIndexes.has(index)) {
      warnings.push(`chapter "${chapterSlug}": duplicate image index ${index} — kept the first`);
      return;
    }
    seenIndexes.add(index);
    if (image.url && isLikelyNonChapterImageUrl(image.url)) {
      warnings.push(
        `chapter "${chapterSlug}": image ${index} looks like a placeholder or thumbnail (${image.url})`,
      );
    }
    images.push({
      index,
      file: image.file,
      ...(image.url === undefined ? {} : { url: image.url }),
      ...(image.bytes === undefined ? {} : { bytes: Math.max(0, image.bytes) }),
      ...(image.sha256 === undefined ? {} : { sha256: image.sha256 }),
      ...(image.width === undefined || image.width <= 0 ? {} : { width: image.width }),
      ...(image.height === undefined || image.height <= 0 ? {} : { height: image.height }),
      ...(image.mime === undefined ? {} : { mime: image.mime }),
    });
  });

  if (withoutFile > 0) {
    warnings.push(
      `chapter "${chapterSlug}": ${withoutFile} image(s) without a file name — skipped`,
    );
  }
  return images.sort((a, b) => a.index - b.index);
}

function normalizeChapter(
  raw: RawManifestChapter,
  position: number,
  seenSlugs: Set<string>,
  warnings: WarningLog,
): ManifestChapter | null {
  if (!raw.slug) {
    warnings.push(`chapters[${position}] has no slug — skipped`);
    return null;
  }
  if (seenSlugs.has(raw.slug)) {
    warnings.push(`chapters[${position}] repeats slug "${raw.slug}" — kept the first`);
    return null;
  }
  seenSlugs.add(raw.slug);

  const images = normalizeImages(raw.images, raw.slug, warnings);
  return {
    slug: raw.slug,
    images,
    ...(raw.externalId === undefined ? {} : { externalId: raw.externalId }),
    ...(raw.url === undefined ? {} : { url: raw.url }),
    ...(raw.title === undefined ? {} : { title: raw.title }),
    ...(raw.chapterOrder === undefined ? {} : { chapterOrder: raw.chapterOrder }),
    ...(raw.number === undefined ? {} : { number: raw.number }),
    ...(raw.volume === undefined ? {} : { volume: raw.volume }),
    ...(raw.releaseDate === undefined ? {} : { releaseDate: raw.releaseDate }),
    ...(raw.releaseDateText === undefined ? {} : { releaseDateText: raw.releaseDateText }),
    ...(raw.status === undefined ? {} : { status: raw.status }),
    ...(raw.imageCount === undefined ? {} : { imageCount: raw.imageCount }),
    ...(raw.downloadedAt === undefined ? {} : { downloadedAt: raw.downloadedAt }),
    ...(raw.lastError === undefined ? {} : { lastError: raw.lastError }),
    ...(raw.missingFromSource === undefined ? {} : { missingFromSource: raw.missingFromSource }),
    ...(raw.source === undefined ? {} : { source: raw.source }),
  };
}

/** Validate and normalise an already-parsed manifest value. */
export function normalizeManifest(value: unknown): ParsedManifest {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new ManifestError("manifest.json must be a JSON object");
  }

  const warnings = new WarningLog();
  const seenSlugs = new Set<string>();
  const chapters: ManifestChapter[] = [];
  parsed.data.chapters.forEach((raw, position) => {
    const chapter = normalizeChapter(raw, position, seenSlugs, warnings);
    if (chapter) chapters.push(chapter);
  });

  const manifest: Manifest = {
    chapters,
    ...(parsed.data.version === undefined ? {} : { version: parsed.data.version }),
    ...(parsed.data.site === undefined ? {} : { site: parsed.data.site }),
    ...(parsed.data.createdAt === undefined ? {} : { createdAt: parsed.data.createdAt }),
    ...(parsed.data.updatedAt === undefined ? {} : { updatedAt: parsed.data.updatedAt }),
    ...(parsed.data.series === undefined ? {} : { series: parsed.data.series }),
  };
  return { manifest, warnings: warnings.toArray() };
}

/** Read `manifest.json` from disk and normalise it. A missing file throws. */
export async function parseManifestFile(file: string): Promise<ParsedManifest> {
  let raw: unknown;
  try {
    raw = await readJsonFile(file);
  } catch (cause) {
    throw new ManifestError(cause instanceof Error ? cause.message : `Cannot read ${file}`, {
      cause,
    });
  }
  if (raw === null) {
    throw new ManifestError(`No manifest at ${file}`);
  }
  return normalizeManifest(raw);
}

/** Convenience wrapper: the manifest of one series in the content store. */
export function parseSeriesManifest(seriesId: string): Promise<ParsedManifest> {
  return parseManifestFile(manifestPath(seriesId));
}
