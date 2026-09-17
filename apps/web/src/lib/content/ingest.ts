/**
 * Manifest ingest: `DATA_ROOT/library/<seriesId>/manifest.json` -> Chapter/Page
 * rows.
 *
 * This is the only writer of plugin-owned chapter data. Everything the reader
 * and the dashboard show comes from the database afterwards; nothing re-reads a
 * manifest at request time (V1 did, once per series per dashboard render).
 *
 * Design rules that matter more than they look:
 *   - **Chapters are matched, never replaced.** `externalId` first, then `slug`.
 *     Page rows keep their ids across syncs and re-optimisations, because notes
 *     are anchored to (chapter, page index) and page ids travel in reader URLs.
 *   - **Nothing is deleted because it vanished upstream.** A plugin chapter that
 *     is no longer in the manifest becomes `MISSING_FROM_SOURCE` with its files
 *     and pages intact; a site that drops a chapter must not empty a shelf.
 *   - **Files on disk are authoritative.** An image listed in the manifest but
 *     absent on disk is skipped with a warning rather than stored as a page that
 *     would 404 in the reader.
 *   - **Manual and PDF chapters are safe.** Only `origin = PLUGIN` rows can be
 *     flagged missing, so an uploaded chapter never reacts to a sync.
 *
 * Notifications are deliberately *not* sent here: `newlyCompleted` is returned
 * and the SOURCE_SYNC job decides whether the run deserves NEW_CHAPTER mails.
 */
import type { ChapterOrigin, ChapterStatus, Prisma } from "@/generated/prisma/client";
import { chapterFilePath, manifestPath } from "@/lib/content/store";
import {
  deriveChapterNumber,
  parseManifestFile,
  type ManifestChapter,
  type ManifestImage,
} from "@/lib/content/manifest";
import {
  fileSize,
  mapWithConcurrency,
  mimeFromExtension,
  readImageMetadata,
} from "@/lib/content/images";
import { prisma } from "@/lib/prisma";

/** Hard cap on warnings added during ingest itself (the parser has its own). */
const MAX_INGEST_WARNINGS = 100;
/** Open file handles while probing image metadata. */
const METADATA_CONCURRENCY = 8;
/** A big series is thousands of statements; the 5 s default is not enough. */
const TRANSACTION_TIMEOUT_MS = 120_000;
const TRANSACTION_MAX_WAIT_MS = 30_000;

export type IngestReason = "sync" | "import" | "manual";

export interface IngestOptions {
  /** Where the run came from; used for warning context only. */
  reason?: IngestReason;
}

export interface IngestedChapterRef {
  chapterId: string;
  slug: string;
  title: string;
  number: number | null;
}

export interface IngestResult {
  chaptersCreated: number;
  /** Chapters whose row or pages actually changed (0 on a no-op re-ingest). */
  chaptersUpdated: number;
  /** Plugin chapters newly flagged MISSING_FROM_SOURCE by this run. */
  chaptersMissing: number;
  pagesUpserted: number;
  /** Not COMPLETED-with-pages before, COMPLETED-with-pages now. */
  newlyCompleted: IngestedChapterRef[];
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/* Ordering                                                                   */
/* -------------------------------------------------------------------------- */

export interface OrderableChapter {
  number: number | null;
  createdAt: Date;
  slug: string;
}

/**
 * Reading order: chapter number ascending with unnumbered chapters last, then
 * discovery order, then slug so the result is stable for identical rows.
 */
export function compareChapterOrder(a: OrderableChapter, b: OrderableChapter): number {
  if (a.number !== b.number) {
    if (a.number === null) return 1;
    if (b.number === null) return -1;
    return a.number - b.number;
  }
  const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
  if (byCreated !== 0) return byCreated;
  if (a.slug === b.slug) return 0;
  return a.slug < b.slug ? -1 : 1;
}

export function sortChapterRows<T extends OrderableChapter>(rows: readonly T[]): T[] {
  return [...rows].sort(compareChapterOrder);
}

/**
 * Materialise `Chapter.sortIndex` (dense, 0-based) for a whole series and
 * return how many rows moved. Called after every create, edit, delete and
 * ingest, so the reader can page through chapters with one indexed query.
 */
export async function recomputeChapterOrder(
  tx: Prisma.TransactionClient,
  seriesId: string,
): Promise<number> {
  const rows = await tx.chapter.findMany({
    where: { seriesId },
    select: { id: true, number: true, createdAt: true, slug: true, sortIndex: true },
  });
  const ordered = sortChapterRows(rows);
  let changed = 0;
  for (const [position, row] of ordered.entries()) {
    if (row.sortIndex === position) continue;
    await tx.chapter.update({ where: { id: row.id }, data: { sortIndex: position } });
    changed += 1;
  }
  return changed;
}

/* -------------------------------------------------------------------------- */
/* Series counters                                                            */
/* -------------------------------------------------------------------------- */

export interface SeriesContentTotals {
  chapterCount: number;
  lastChapterAt: Date | null;
}

function latestOf(values: readonly (Date | null)[]): Date | null {
  let latest: Date | null = null;
  for (const value of values) {
    if (value && (!latest || value.getTime() > latest.getTime())) latest = value;
  }
  return latest;
}

/**
 * Recompute `Series.chapterCount` / `lastChapterAt` from the chapter rows and
 * write them when they moved. `touch` additionally bumps `updatedAt`, which is
 * what invalidates the library cache after a content change that left the
 * counters alone (a retitled chapter, a new page in an existing chapter).
 */
export async function refreshSeriesContent(
  tx: Prisma.TransactionClient,
  seriesId: string,
  options: { touch?: boolean } = {},
): Promise<{ orderChanged: number; totals: SeriesContentTotals; changed: boolean }> {
  const orderChanged = await recomputeChapterOrder(tx, seriesId);

  const chapters = await tx.chapter.findMany({
    where: { seriesId, status: "COMPLETED", pageCount: { gt: 0 } },
    select: { downloadedAt: true, releaseDate: true, createdAt: true },
  });
  const totals: SeriesContentTotals = {
    chapterCount: chapters.length,
    lastChapterAt: latestOf(
      chapters.flatMap((chapter) => [chapter.downloadedAt, chapter.releaseDate, chapter.createdAt]),
    ),
  };

  const series = await tx.series.findUnique({
    where: { id: seriesId },
    select: { chapterCount: true, lastChapterAt: true },
  });
  const countersChanged =
    series !== null &&
    (series.chapterCount !== totals.chapterCount ||
      (series.lastChapterAt?.getTime() ?? null) !== (totals.lastChapterAt?.getTime() ?? null));

  if (series !== null && (countersChanged || options.touch === true || orderChanged > 0)) {
    await tx.series.update({
      where: { id: seriesId },
      data: {
        chapterCount: totals.chapterCount,
        lastChapterAt: totals.lastChapterAt,
        updatedAt: new Date(),
      },
    });
  }
  return { orderChanged, totals, changed: countersChanged || orderChanged > 0 };
}

/* -------------------------------------------------------------------------- */
/* Planning (all filesystem work happens here, outside the transaction)        */
/* -------------------------------------------------------------------------- */

const EXISTING_CHAPTER_SELECT = {
  id: true,
  slug: true,
  externalId: true,
  title: true,
  number: true,
  volume: true,
  status: true,
  origin: true,
  pageCount: true,
  bytes: true,
  sourceUrl: true,
  releaseDate: true,
  releaseDateText: true,
  downloadedAt: true,
  lastError: true,
  sortIndex: true,
  pages: {
    select: {
      id: true,
      index: true,
      file: true,
      bytes: true,
      sha256: true,
      width: true,
      height: true,
      mime: true,
      sourceUrl: true,
    },
    orderBy: { index: "asc" },
  },
} satisfies Prisma.ChapterSelect;

type ExistingChapter = Prisma.ChapterGetPayload<{ select: typeof EXISTING_CHAPTER_SELECT }>;
type ExistingPage = ExistingChapter["pages"][number];

interface PlannedPage {
  index: number;
  file: string;
  bytes: number;
  sha256: string | null;
  width: number | null;
  height: number | null;
  mime: string | null;
  sourceUrl: string | null;
  existingId: string | null;
  changed: boolean;
}

interface ChapterData {
  slug: string;
  externalId: string | null;
  title: string;
  number: number | null;
  volume: string | null;
  status: ChapterStatus;
  origin: ChapterOrigin;
  pageCount: number;
  bytes: bigint;
  sourceUrl: string | null;
  releaseDate: Date | null;
  releaseDateText: string | null;
  downloadedAt: Date | null;
  lastError: string | null;
}

interface ChapterPlan {
  existing: ExistingChapter | null;
  data: ChapterData;
  /** null when the manifest listed no images: existing pages are left alone. */
  pages: PlannedPage[] | null;
  wasComplete: boolean;
  isComplete: boolean;
  rowChanged: boolean;
}

function addWarning(warnings: string[], line: string): void {
  if (warnings.length < MAX_INGEST_WARNINGS) warnings.push(line);
}

function toDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function originOf(chapter: ManifestChapter, existing: ExistingChapter | null): ChapterOrigin {
  switch (chapter.source) {
    case "manual":
      return "MANUAL";
    case "pdf":
      return "PDF";
    case "plugin":
      return "PLUGIN";
    default:
      // No `source` key: keep whatever the row already is (V1 manifests only
      // tag manual chapters), and default a brand new chapter to PLUGIN.
      return existing?.origin ?? "PLUGIN";
  }
}

function statusOf(chapter: ManifestChapter, pageCount: number): ChapterStatus {
  if (chapter.missingFromSource === true) return "MISSING_FROM_SOURCE";
  switch (chapter.status) {
    case "pending":
      return "PENDING";
    case "downloading":
      return "DOWNLOADING";
    case "completed":
      return "COMPLETED";
    case "failed":
      return "FAILED";
    default:
      // Older manifests omit the status on chapters that were written straight
      // to disk; images on disk are the better signal.
      return pageCount > 0 ? "COMPLETED" : "PENDING";
  }
}

async function planPage(
  seriesId: string,
  slug: string,
  image: ManifestImage,
  existing: ExistingPage | undefined,
): Promise<PlannedPage | null> {
  const filePath = chapterFilePath(seriesId, slug, image.file);
  const bytes = await fileSize(filePath);
  if (bytes === null) return null;

  const declaredSha = image.sha256 ?? null;
  const unchanged =
    existing !== undefined &&
    existing.file === image.file &&
    existing.bytes === bytes &&
    (declaredSha === null || existing.sha256 === null || existing.sha256 === declaredSha);

  let width = image.width ?? (unchanged ? existing.width : null);
  let height = image.height ?? (unchanged ? existing.height : null);
  let mime = image.mime ?? (unchanged ? existing.mime : null);

  // The one expensive call: only for new or changed files, or rows that never
  // got their dimensions.
  if (width === null || height === null) {
    const metadata = await readImageMetadata(filePath);
    width = width ?? metadata.width;
    height = height ?? metadata.height;
    mime = mime ?? metadata.mime;
  }
  mime = mime ?? mimeFromExtension(image.file);

  const sha256 = declaredSha ?? (unchanged ? existing.sha256 : null);
  const sourceUrl = image.url ?? (unchanged ? existing.sourceUrl : null);

  const changed =
    existing === undefined ||
    existing.file !== image.file ||
    existing.bytes !== bytes ||
    existing.sha256 !== sha256 ||
    existing.width !== width ||
    existing.height !== height ||
    existing.mime !== mime ||
    existing.sourceUrl !== sourceUrl;

  return {
    index: image.index,
    file: image.file,
    bytes,
    sha256,
    width,
    height,
    mime,
    sourceUrl,
    existingId: existing?.id ?? null,
    changed,
  };
}

function rowNeedsUpdate(existing: ExistingChapter, data: ChapterData): boolean {
  return (
    existing.slug !== data.slug ||
    existing.externalId !== data.externalId ||
    existing.title !== data.title ||
    existing.number !== data.number ||
    existing.volume !== data.volume ||
    existing.status !== data.status ||
    existing.origin !== data.origin ||
    existing.pageCount !== data.pageCount ||
    existing.bytes !== data.bytes ||
    existing.sourceUrl !== data.sourceUrl ||
    (existing.releaseDate?.getTime() ?? null) !== (data.releaseDate?.getTime() ?? null) ||
    existing.releaseDateText !== data.releaseDateText ||
    (existing.downloadedAt?.getTime() ?? null) !== (data.downloadedAt?.getTime() ?? null) ||
    existing.lastError !== data.lastError
  );
}

/* -------------------------------------------------------------------------- */
/* Ingest                                                                     */
/* -------------------------------------------------------------------------- */

export async function ingestManifest(
  seriesId: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const { manifest, warnings } = await parseManifestFile(manifestPath(seriesId));

  const existingChapters = await prisma.chapter.findMany({
    where: { seriesId },
    select: EXISTING_CHAPTER_SELECT,
  });
  const bySlug = new Map(existingChapters.map((chapter) => [chapter.slug, chapter]));
  const byExternalId = new Map(
    existingChapters
      .filter((chapter) => chapter.externalId !== null)
      .map((chapter) => [chapter.externalId as string, chapter]),
  );

  const plans: ChapterPlan[] = [];
  const matchedIds = new Set<string>();

  for (const chapter of manifest.chapters) {
    const existing =
      (chapter.externalId ? byExternalId.get(chapter.externalId) : undefined) ??
      bySlug.get(chapter.slug) ??
      null;
    if (existing) matchedIds.add(existing.id);

    // Renaming a slug is allowed (matched by externalId) unless another
    // chapter already owns the new one; the unique index would reject it.
    let slug = chapter.slug;
    const slugOwner = bySlug.get(slug);
    if (existing && existing.slug !== slug && slugOwner && slugOwner.id !== existing.id) {
      addWarning(
        warnings,
        `chapter "${existing.slug}": cannot take slug "${slug}", another chapter already uses it`,
      );
      slug = existing.slug;
    }

    const existingPages = new Map((existing?.pages ?? []).map((page) => [page.index, page]));
    let pages: PlannedPage[] | null = null;
    if (chapter.images.length > 0) {
      const planned = await mapWithConcurrency(chapter.images, METADATA_CONCURRENCY, (image) =>
        planPage(seriesId, slug, image, existingPages.get(image.index)),
      );
      const kept = planned.filter((page): page is PlannedPage => page !== null);
      const missingFiles = planned.length - kept.length;
      if (missingFiles > 0) {
        addWarning(
          warnings,
          `chapter "${slug}": ${missingFiles} image file(s) missing on disk — skipped`,
        );
      }
      pages = kept;
    }

    const pageCount = pages === null ? (existing?.pageCount ?? 0) : pages.length;
    const bytes =
      pages === null
        ? (existing?.bytes ?? 0n)
        : BigInt(pages.reduce((total, page) => total + page.bytes, 0));

    let status = statusOf(chapter, pageCount);
    let lastError = chapter.lastError ?? null;
    if (status === "COMPLETED" && pageCount === 0) {
      status = "FAILED";
      lastError = "no pages";
    }

    const data: ChapterData = {
      slug,
      externalId: chapter.externalId ?? existing?.externalId ?? null,
      title: chapter.title ?? existing?.title ?? slug,
      number: deriveChapterNumber(chapter) ?? existing?.number ?? null,
      volume: chapter.volume ?? existing?.volume ?? null,
      status,
      origin: originOf(chapter, existing),
      pageCount,
      bytes,
      sourceUrl: chapter.url ?? existing?.sourceUrl ?? null,
      releaseDate: toDate(chapter.releaseDate) ?? existing?.releaseDate ?? null,
      releaseDateText: chapter.releaseDateText ?? existing?.releaseDateText ?? null,
      downloadedAt: toDate(chapter.downloadedAt) ?? existing?.downloadedAt ?? null,
      lastError,
    };

    plans.push({
      existing,
      data,
      pages,
      wasComplete: existing !== null && existing.status === "COMPLETED" && existing.pageCount > 0,
      isComplete: status === "COMPLETED" && pageCount > 0,
      rowChanged: existing === null || rowNeedsUpdate(existing, data),
    });
  }

  // Plugin chapters the source no longer lists. Never deleted: the files and
  // the pages stay, so an offline download keeps working.
  const vanished = existingChapters.filter(
    (chapter) =>
      !matchedIds.has(chapter.id) &&
      chapter.origin === "PLUGIN" &&
      chapter.status !== "MISSING_FROM_SOURCE",
  );

  const result: IngestResult = {
    chaptersCreated: 0,
    chaptersUpdated: 0,
    chaptersMissing: 0,
    pagesUpserted: 0,
    newlyCompleted: [],
    warnings,
  };

  await prisma.$transaction(
    async (tx) => {
      for (const plan of plans) {
        let chapterId: string;
        let pagesTouched = 0;

        if (plan.existing === null) {
          const created = await tx.chapter.create({
            data: { seriesId, ...plan.data, sortIndex: 0 },
            select: { id: true },
          });
          chapterId = created.id;
          result.chaptersCreated += 1;
        } else {
          chapterId = plan.existing.id;
          if (plan.rowChanged) {
            await tx.chapter.update({ where: { id: chapterId }, data: plan.data });
          }
        }

        if (plan.pages !== null) {
          const creates = plan.pages.filter((page) => page.existingId === null);
          if (creates.length > 0) {
            await tx.page.createMany({
              data: creates.map((page) => ({
                chapterId,
                index: page.index,
                file: page.file,
                bytes: page.bytes,
                sha256: page.sha256,
                width: page.width,
                height: page.height,
                mime: page.mime,
                sourceUrl: page.sourceUrl,
              })),
            });
            pagesTouched += creates.length;
          }
          for (const page of plan.pages) {
            if (page.existingId === null || !page.changed) continue;
            await tx.page.update({
              where: { id: page.existingId },
              data: {
                file: page.file,
                bytes: page.bytes,
                sha256: page.sha256,
                width: page.width,
                height: page.height,
                mime: page.mime,
                sourceUrl: page.sourceUrl,
              },
            });
            pagesTouched += 1;
          }

          const keep = plan.pages.map((page) => page.index);
          const contiguous = keep.every((index, position) => index === position + 1);
          const removed = await tx.page.deleteMany({
            where: {
              chapterId,
              ...(contiguous ? { index: { gt: keep.length } } : { index: { notIn: keep } }),
            },
          });
          pagesTouched += removed.count;
        }

        result.pagesUpserted += pagesTouched;
        if (plan.existing !== null && (plan.rowChanged || pagesTouched > 0)) {
          result.chaptersUpdated += 1;
        }
        if (!plan.wasComplete && plan.isComplete) {
          result.newlyCompleted.push({
            chapterId,
            slug: plan.data.slug,
            title: plan.data.title,
            number: plan.data.number,
          });
        }
      }

      if (vanished.length > 0) {
        const flagged = await tx.chapter.updateMany({
          where: { id: { in: vanished.map((chapter) => chapter.id) } },
          data: { status: "MISSING_FROM_SOURCE" },
        });
        result.chaptersMissing = flagged.count;
      }

      const touched =
        result.chaptersCreated > 0 ||
        result.chaptersUpdated > 0 ||
        result.chaptersMissing > 0 ||
        result.pagesUpserted > 0;
      await refreshSeriesContent(tx, seriesId, { touch: touched });
    },
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
  );

  if (result.warnings.length > 0) {
    const reason = options.reason ?? "sync";
    console.warn(
      `[ingest:${reason}] series ${seriesId}: ${result.warnings.length} manifest warning(s)`,
    );
  }
  return result;
}
