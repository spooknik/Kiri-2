/**
 * Chapter helpers shared by the reader hook, the chapter picker and the
 * end-of-chapter card. Pure functions only, so they unit test without a DOM.
 */
import type { ChapterListItem, ReadingPositionView } from "@/lib/contracts/content";

/** A chapter the reader can actually open: finished, with at least one page. */
export function isReadableChapter(chapter: ChapterListItem): boolean {
  return chapter.status === "COMPLETED" && chapter.pageCount > 0;
}

export function readableChapters(chapters: readonly ChapterListItem[]): ChapterListItem[] {
  return chapters.filter(isReadableChapter);
}

/**
 * Which chapter to open when the URL doesn't name one: the saved position if
 * it still points at a readable chapter, otherwise the first readable chapter.
 */
export function resolveInitialChapterId(
  chapters: readonly ChapterListItem[],
  position: ReadingPositionView | null | undefined,
): string | null {
  const readable = readableChapters(chapters);
  if (position?.chapterId && readable.some((chapter) => chapter.id === position.chapterId)) {
    return position.chapterId;
  }
  return readable[0]?.id ?? null;
}

/** "Ch. 12 - Title", or just the title when the chapter has no number. */
export function formatChapterLabel(chapter: { title: string; number: number | null }): string {
  if (chapter.number === null) return chapter.title;
  const number = `Ch. ${chapter.number}`;
  const title = chapter.title.trim();
  if (!title || title.toLowerCase() === number.toLowerCase()) return number;
  return `${number} - ${title}`;
}

/**
 * Case-insensitive substring filter over chapter title, number and volume.
 * An empty query returns the list unchanged (same array reference).
 */
export function filterChapters<
  T extends { title: string; number: number | null; volume?: string | null },
>(chapters: readonly T[], query: string): readonly T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return chapters;
  return chapters.filter((chapter) => {
    const haystack = [
      chapter.title,
      chapter.number === null ? "" : String(chapter.number),
      chapter.volume ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}
