/**
 * Spoiler gating for notes.
 *
 * A note is hidden from a viewer when reading it would spoil something they
 * have not reached yet. Two independent reasons, in this order:
 *
 *   - `isSpoiler`: the author flagged it by hand;
 *   - progress: the note is anchored past the viewer's furthest reading point.
 *
 * Both are switched off for the note's own author (you always see what you
 * wrote) and for viewers who turned `showSpoilers` on in their profile.
 *
 * "Furthest reading point" is a `(chapter sortIndex, page)` pair compared
 * lexicographically. It is the maximum of two sources: every chapter with a
 * `ChapterRead` marker counts as read to its end (`WHOLE_CHAPTER`), and the
 * single `ReadingPosition` row counts up to the page the viewer is on. Pages
 * here are **1-based**, like `Note.pageIndex` — `ReadingPosition.pageIndex` is
 * 0-based and must be converted by the caller (see `src/lib/notes/service.ts`).
 *
 * Pure functions only: no Prisma, no session lookups, so every rule unit tests
 * without a database.
 */

/** Page value meaning "to the end of the chapter". */
export const WHOLE_CHAPTER = Number.POSITIVE_INFINITY;

/** Where a note sits in the series. */
export interface NoteAnchor {
  /** `sortIndex` of the note's chapter; null for a series-level note. */
  chapterSortIndex: number | null;
  /** 1-based page inside the chapter; null for a chapter-level note. */
  pageIndex: number | null;
}

/** A point in the series, ordered by chapter and then page. */
export interface ProgressPoint {
  chapterSortIndex: number;
  /** 1-based page, or `WHOLE_CHAPTER`. */
  page: number;
}

export interface ViewerProgress {
  /** `sortIndex` of every chapter the viewer has finished. */
  readChapterSortIndexes: ReadonlySet<number>;
  /** The viewer's current reading position (1-based page), null when none. */
  position: ProgressPoint | null;
}

export interface NoteViewer {
  id: string;
  showSpoilers: boolean;
}

export interface GatedNote {
  authorId: string;
  isSpoiler: boolean;
  anchor: NoteAnchor;
}

export type HiddenReason = "spoiler" | "progress";

/** Lexicographic `(chapter, page)` order: negative when `a` comes first. */
export function compareProgressPoints(a: ProgressPoint, b: ProgressPoint): number {
  if (a.chapterSortIndex !== b.chapterSortIndex) {
    return a.chapterSortIndex - b.chapterSortIndex;
  }
  if (a.page === b.page) return 0;
  return a.page < b.page ? -1 : 1;
}

/** The furthest point the viewer has reached, or null when they never started. */
export function furthestProgress(progress: ViewerProgress): ProgressPoint | null {
  let best: ProgressPoint | null = null;
  for (const chapterSortIndex of progress.readChapterSortIndexes) {
    const candidate: ProgressPoint = { chapterSortIndex, page: WHOLE_CHAPTER };
    if (best === null || compareProgressPoints(candidate, best) > 0) best = candidate;
  }
  const { position } = progress;
  if (position !== null && (best === null || compareProgressPoints(position, best) > 0)) {
    best = position;
  }
  return best;
}

/**
 * True when the anchor sits past the viewer's furthest reading point.
 *
 * Series-level notes are never beyond anything, and a chapter with a read
 * marker is always safe even if the viewer's position sits earlier (you can
 * read chapter 5 and then go back to 3).
 */
export function isBeyondProgress(anchor: NoteAnchor, progress: ViewerProgress): boolean {
  if (anchor.chapterSortIndex === null) return false;
  if (progress.readChapterSortIndexes.has(anchor.chapterSortIndex)) return false;

  const furthest = furthestProgress(progress);
  if (furthest === null) return true;

  // A chapter-level note (no page) sits at the very start of its chapter.
  const point: ProgressPoint = {
    chapterSortIndex: anchor.chapterSortIndex,
    page: anchor.pageIndex ?? 0,
  };
  return compareProgressPoints(point, furthest) > 0;
}

/** Why the note is hidden from this viewer, or null when it is visible. */
export function noteHiddenReason(
  note: GatedNote,
  viewer: NoteViewer,
  progress: ViewerProgress,
): HiddenReason | null {
  if (note.authorId === viewer.id) return null;
  if (viewer.showSpoilers) return null;
  if (note.isSpoiler) return "spoiler";
  if (isBeyondProgress(note.anchor, progress)) return "progress";
  return null;
}

/** Whether the note's body must be withheld from this viewer. */
export function isNoteHidden(
  note: GatedNote,
  viewer: NoteViewer,
  progress: ViewerProgress,
): boolean {
  return noteHiddenReason(note, viewer, progress) !== null;
}
