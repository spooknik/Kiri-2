/**
 * Pure `/read?series=&chapter=&page=` URL builders shared by the series
 * page's "Continue reading" button (`ChaptersSection`) and the dashboard's
 * `ContinueReading` strip. Dependency-free and easily unit-tested — see
 * `reader-url.test.ts`.
 */
import type { ChapterListItem, ReadingPositionView } from "./contracts/content";

/** `page` is 1-based (matches the reader's own `page` query param), unlike `pageIndex`. */
export function buildReadHref(seriesId: string, chapterId: string, page?: number): string {
  const params = new URLSearchParams({ series: seriesId, chapter: chapterId });
  if (page !== undefined) {
    params.set("page", String(page));
  }
  return `/read?${params.toString()}`;
}

/**
 * Where the series page's "Continue reading" / "Start reading" button
 * should go:
 * - a saved reading position → that chapter, at `pageIndex + 1`.
 * - otherwise the first unread readable (COMPLETED, has pages) chapter by
 *   `sortIndex`, at page 1 — or, if every readable chapter is already read,
 *   the first readable chapter, at page 1 (re-read from the top).
 * - `null` when there is nothing readable at all.
 */
export function buildContinueReadingHref(
  seriesId: string,
  position: ReadingPositionView | null,
  chapters: readonly ChapterListItem[],
): string | null {
  if (position?.chapterId) {
    return buildReadHref(seriesId, position.chapterId, position.pageIndex + 1);
  }

  const readable = chapters
    .filter((chapter) => chapter.status === "COMPLETED" && chapter.pageCount > 0)
    .sort((a, b) => a.sortIndex - b.sortIndex);

  const target = readable.find((chapter) => !chapter.read) ?? readable[0];
  if (!target) {
    return null;
  }
  return buildReadHref(seriesId, target.id, 1);
}
