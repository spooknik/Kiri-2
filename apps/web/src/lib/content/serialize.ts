/**
 * Prisma chapter/page rows -> content contract types.
 *
 * The same rule as `src/lib/series/serialize.ts`: dates become ISO strings
 * here and nowhere else, so `src/lib/contracts/content.ts` is the only
 * description of the wire format the reader and the series page need.
 *
 * `Chapter.bytes` is a BigInt column (a series can hold gigabytes); it is
 * narrowed to a number on the way out — 2^53 bytes is 9 PB, so nothing is lost.
 */
import type { Chapter, Page } from "@/generated/prisma/client";
import type { ChapterDetail, ChapterListItem, ChapterRef, PageView } from "@/lib/contracts";

/** A chapter row loaded with the current user's read marker (at most one). */
export interface ChapterRow extends Chapter {
  reads?: { readAt: Date }[];
}

/** A chapter row with everything the reader needs in one response. */
export interface ChapterDetailRow extends ChapterRow {
  pages: Page[];
  series: { id: string; title: string };
}

/** The columns {@link toChapterRef} needs; used for prev/next lookups. */
export interface ChapterRefRow {
  id: string;
  slug: string;
  title: string;
  number: number | null;
  pageCount: number;
}

/** COMPLETED with at least one page — everything else cannot be opened. */
export function isReadableChapter(row: { status: string; pageCount: number }): boolean {
  return row.status === "COMPLETED" && row.pageCount > 0;
}

export function toChapterRef(row: ChapterRefRow): ChapterRef {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    number: row.number,
    pageCount: row.pageCount,
  };
}

export function toChapterListItem(row: ChapterRow): ChapterListItem {
  const read = row.reads?.[0];
  return {
    ...toChapterRef(row),
    volume: row.volume,
    status: row.status,
    origin: row.origin,
    bytes: Number(row.bytes),
    sourceUrl: row.sourceUrl,
    releaseDate: row.releaseDate?.toISOString() ?? null,
    downloadedAt: row.downloadedAt?.toISOString() ?? null,
    sortIndex: row.sortIndex,
    read: read !== undefined,
    readAt: read?.readAt.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Page URLs are `/api/pages/:id/image`: stable for the life of the page row,
 * which is what lets the service worker cache them `CacheFirst` and what keeps
 * a note pinned to the same artwork after an optimisation pass rewrites the
 * file on disk.
 */
export function toPageView(page: Page): PageView {
  return {
    id: page.id,
    index: page.index,
    url: `/api/pages/${page.id}/image`,
    width: page.width,
    height: page.height,
    bytes: page.bytes,
    mime: page.mime,
  };
}

export function toChapterDetail(
  row: ChapterDetailRow,
  neighbours: { prev: ChapterRef | null; next: ChapterRef | null },
): ChapterDetail {
  return {
    ...toChapterListItem(row),
    seriesId: row.seriesId,
    seriesTitle: row.series.title,
    pages: row.pages.map(toPageView),
    prev: neighbours.prev,
    next: neighbours.next,
  };
}
