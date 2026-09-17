/**
 * Chapter service: listing, detail, editing, deletion and creation of
 * LOCAL chapters (manual uploads, PDF imports, V1 import of manual/pdf rips).
 *
 * Routes stay thin: they validate with the contract schemas and call these
 * functions, which own authorization (`src/lib/authz.ts`) and keep the
 * materialised order and the series counters in step through the shared
 * helpers in `./ingest.ts` — the plugin path and the local path must never
 * disagree about what `sortIndex` or `chapterCount` mean.
 */
import path from "node:path";
import type { ChapterOrigin, Prisma } from "@/generated/prisma/client";
import { badRequest, conflict, notFound } from "@/lib/api";
import type { SessionUser } from "@/lib/auth/types";
import { assertCanEditSeries, assertCanViewSeries, canEditSeries } from "@/lib/authz";
import { mapWithConcurrency, readImageMetadata, sha256File } from "@/lib/content/images";
import { refreshSeriesContent } from "@/lib/content/ingest";
import {
  isReadableChapter,
  toChapterDetail,
  toChapterListItem,
  toChapterRef,
  type ChapterDetailRow,
  type ChapterRow,
} from "@/lib/content/serialize";
import { chapterDir, removeChapterDir } from "@/lib/content/store";
import type {
  ChapterDetail,
  ChapterListItem,
  ChapterListResponse,
  UpdateChapterInput,
} from "@/lib/contracts";
import { prisma } from "@/lib/prisma";

/** Open file handles while hashing and probing uploaded pages. */
const PAGE_CONCURRENCY = 8;

/** Everything the authorization rules plus the list header need. */
const SERIES_ACCESS_SELECT = {
  id: true,
  title: true,
  mediaType: true,
  visibility: true,
  isAdult: true,
  createdById: true,
} satisfies Prisma.SeriesSelect;

const CHAPTER_REF_SELECT = {
  id: true,
  slug: true,
  title: true,
  number: true,
  pageCount: true,
} satisfies Prisma.ChapterSelect;

/* -------------------------------------------------------------------------- */
/* Local chapter creation (uploads, PDF import, V1 import)                    */
/* -------------------------------------------------------------------------- */

export interface LocalPageFile {
  /** Absolute path of a finished image file on disk (already in the chapter dir). */
  path: string;
  /** 1-based reading order. */
  index: number;
  /** Optional precomputed values; the service fills in what is missing. */
  bytes?: number;
  sha256?: string;
  width?: number;
  height?: number;
  mime?: string;
}

export interface CreateLocalChapterInput {
  seriesId: string;
  /** Unique within the series; pick e.g. `manual-<timestamp>` or `pdf-<sha12>`. */
  slug: string;
  title: string;
  number: number | null;
  volume: string | null;
  origin: Exclude<ChapterOrigin, "PLUGIN">;
  /** Files already placed under the chapter directory (see content/store.ts). */
  pages: LocalPageFile[];
  sourceUrl?: string | null;
}

export interface CreatedLocalChapter {
  chapterId: string;
  pageCount: number;
  bytes: number;
}

/** Store the path relative to the chapter directory, with POSIX separators. */
function relativePageFile(dir: string, filePath: string): string {
  const relative = path.relative(dir, path.resolve(filePath));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw badRequest(`Page file ${filePath} is not inside the chapter directory`);
  }
  return relative.split(path.sep).join("/");
}

/**
 * Register a local chapter whose files are already in
 * `libraryDir(seriesId)/chapterDirName(slug)/`. Creates the Chapter and Page
 * rows, computes missing dimensions/hashes, recomputes sort order and the
 * series' chapter counters. Throws on a slug collision.
 */
export async function createLocalChapter(
  input: CreateLocalChapterInput,
): Promise<CreatedLocalChapter> {
  const slug = input.slug.trim();
  // Throws for an empty slug before anything touches the database.
  const dir = chapterDir(input.seriesId, slug);
  if (input.pages.length === 0) {
    throw badRequest("A chapter needs at least one page");
  }

  const series = await prisma.series.findUnique({
    where: { id: input.seriesId },
    select: { id: true },
  });
  if (!series) throw notFound("Series");

  const existing = await prisma.chapter.findUnique({
    where: { seriesId_slug: { seriesId: input.seriesId, slug } },
    select: { id: true },
  });
  if (existing) {
    throw conflict(`This series already has a chapter with the id "${slug}"`);
  }

  const ordered = [...input.pages].sort((a, b) => a.index - b.index);
  const seenIndexes = new Set<number>();
  for (const page of ordered) {
    if (!Number.isInteger(page.index) || page.index < 1) {
      throw badRequest(`Page index ${page.index} must be a positive integer`);
    }
    if (seenIndexes.has(page.index)) {
      throw badRequest(`Duplicate page index ${page.index}`);
    }
    seenIndexes.add(page.index);
  }

  const rows = await mapWithConcurrency(ordered, PAGE_CONCURRENCY, async (page) => {
    const file = relativePageFile(dir, page.path);
    const needsMetadata =
      page.bytes === undefined ||
      page.width === undefined ||
      page.height === undefined ||
      page.mime === undefined;
    // Throws when the file is missing, which is the right answer: the caller
    // promised the bytes were already on disk.
    const metadata = needsMetadata ? await readImageMetadata(page.path) : null;
    return {
      index: page.index,
      file,
      bytes: page.bytes ?? metadata?.bytes ?? 0,
      sha256: page.sha256 ?? (await sha256File(page.path)),
      width: page.width ?? metadata?.width ?? null,
      height: page.height ?? metadata?.height ?? null,
      mime: page.mime ?? metadata?.mime ?? null,
    };
  });

  const bytes = rows.reduce((total, row) => total + row.bytes, 0);
  const title = input.title.trim() === "" ? slug : input.title.trim();

  const chapterId = await prisma.$transaction(async (tx) => {
    const created = await tx.chapter.create({
      data: {
        seriesId: input.seriesId,
        slug,
        title,
        number: input.number,
        volume: input.volume,
        origin: input.origin,
        status: "COMPLETED",
        pageCount: rows.length,
        bytes: BigInt(bytes),
        sourceUrl: input.sourceUrl ?? null,
        downloadedAt: new Date(),
        sortIndex: 0,
        pages: { create: rows },
      },
      select: { id: true },
    });
    await refreshSeriesContent(tx, input.seriesId, { touch: true });
    return created.id;
  });

  return { chapterId, pageCount: rows.length, bytes };
}

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

export async function listChapters(
  user: SessionUser,
  seriesId: string,
): Promise<ChapterListResponse> {
  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    select: SERIES_ACCESS_SELECT,
  });
  if (!series) throw notFound("Series");
  assertCanViewSeries(user, series);

  const [rows, position] = await Promise.all([
    prisma.chapter.findMany({
      where: { seriesId },
      orderBy: { sortIndex: "asc" },
      include: { reads: { where: { userId: user.id }, select: { readAt: true }, take: 1 } },
    }),
    prisma.readingPosition.findUnique({
      where: { userId_seriesId: { userId: user.id, seriesId } },
      select: { chapterId: true, pageIndex: true, updatedAt: true },
    }),
  ]);

  const chapters = rows.map((row) => toChapterListItem(row));
  return {
    series: {
      id: series.id,
      title: series.title,
      mediaType: series.mediaType,
      canEdit: canEditSeries(user, series),
    },
    chapters,
    position: position
      ? {
          chapterId: position.chapterId,
          pageIndex: position.pageIndex,
          updatedAt: position.updatedAt.toISOString(),
        }
      : null,
    readCount: chapters.filter((chapter) => chapter.read).length,
    readableCount: rows.filter((row) => isReadableChapter(row)).length,
  };
}

/** The chapter plus its pages and the neighbouring *readable* chapters. */
export async function getChapterDetail(
  user: SessionUser,
  chapterId: string,
): Promise<ChapterDetail> {
  const row = await prisma.chapter.findUnique({
    where: { id: chapterId },
    include: {
      pages: { orderBy: { index: "asc" } },
      reads: { where: { userId: user.id }, select: { readAt: true }, take: 1 },
      series: { select: SERIES_ACCESS_SELECT },
    },
  });
  if (!row) throw notFound("Chapter");
  assertCanViewSeries(user, row.series);

  const readable = {
    seriesId: row.seriesId,
    status: "COMPLETED",
    pageCount: { gt: 0 },
    id: { not: row.id },
  } satisfies Prisma.ChapterWhereInput;

  const [prev, next] = await Promise.all([
    prisma.chapter.findFirst({
      where: { ...readable, sortIndex: { lt: row.sortIndex } },
      orderBy: { sortIndex: "desc" },
      select: CHAPTER_REF_SELECT,
    }),
    prisma.chapter.findFirst({
      where: { ...readable, sortIndex: { gt: row.sortIndex } },
      orderBy: { sortIndex: "asc" },
      select: CHAPTER_REF_SELECT,
    }),
  ]);

  const detailRow: ChapterDetailRow = row;
  return toChapterDetail(detailRow, {
    prev: prev ? toChapterRef(prev) : null,
    next: next ? toChapterRef(next) : null,
  });
}

/** Single chapter as a list item — the shape `PUT /api/chapters/:id/read` answers with. */
export async function getChapterListItem(
  userId: string,
  chapterId: string,
): Promise<ChapterListItem> {
  const row: ChapterRow | null = await prisma.chapter.findUnique({
    where: { id: chapterId },
    include: { reads: { where: { userId }, select: { readAt: true }, take: 1 } },
  });
  if (!row) throw notFound("Chapter");
  return toChapterListItem(row);
}

/* -------------------------------------------------------------------------- */
/* Write                                                                      */
/* -------------------------------------------------------------------------- */

async function loadChapterForEdit(user: SessionUser, chapterId: string) {
  const row = await prisma.chapter.findUnique({
    where: { id: chapterId },
    select: {
      id: true,
      seriesId: true,
      slug: true,
      number: true,
      series: { select: SERIES_ACCESS_SELECT },
    },
  });
  if (!row) throw notFound("Chapter");
  assertCanEditSeries(user, row.series);
  return row;
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Rename or renumber a chapter. A number change reshuffles the whole series'
 * `sortIndex`, which is why this goes through the same helper as ingest.
 *
 * A later sync overwrites a number the manifest can derive itself; manual
 * numbers stick for chapters whose number cannot be parsed from the source.
 */
export async function updateChapter(
  user: SessionUser,
  chapterId: string,
  patch: UpdateChapterInput,
): Promise<ChapterDetail> {
  const current = await loadChapterForEdit(user, chapterId);

  const data: Prisma.ChapterUpdateInput = {};
  if (patch.title !== undefined) data.title = patch.title.trim();
  if (patch.number !== undefined) data.number = patch.number ?? null;
  if (patch.volume !== undefined) data.volume = emptyToNull(patch.volume);

  await prisma.$transaction(async (tx) => {
    if (Object.keys(data).length > 0) {
      await tx.chapter.update({ where: { id: chapterId }, data });
    }
    // Cheap when the number did not move: the helper only writes rows that did.
    await refreshSeriesContent(tx, current.seriesId, { touch: true });
  });

  return getChapterDetail(user, chapterId);
}

/**
 * Delete a chapter and its images.
 *
 * Plugin chapters may be deleted too — a deliberate escape hatch for a botched
 * download. The manifest still lists the chapter, so the next sync re-downloads
 * and re-creates it (with fresh page ids: notes anchored to the deleted chapter
 * go with it).
 */
export async function deleteChapter(user: SessionUser, chapterId: string): Promise<void> {
  const current = await loadChapterForEdit(user, chapterId);

  try {
    await removeChapterDir(current.seriesId, current.slug);
  } catch (error) {
    // A locked file must not block the delete; the row is the source of truth.
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[chapters] could not remove files for chapter ${chapterId}: ${reason}`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.chapter.delete({ where: { id: chapterId } });
    await refreshSeriesContent(tx, current.seriesId, { touch: true });
  });
}
