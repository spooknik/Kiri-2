/**
 * Every rule of the spoiler gate, without a database.
 *
 * The fixture series is four chapters (`sortIndex` 0..3) of ten pages. Pages
 * here are 1-based, as `Note.pageIndex` is.
 */
import { describe, expect, it } from "vitest";
import {
  compareProgressPoints,
  furthestProgress,
  isBeyondProgress,
  isNoteHidden,
  noteHiddenReason,
  WHOLE_CHAPTER,
  type GatedNote,
  type NoteAnchor,
  type NoteViewer,
  type ViewerProgress,
} from "./spoilers";

const AUTHOR = "author-id";
const VIEWER = "viewer-id";

const viewer: NoteViewer = { id: VIEWER, showSpoilers: false };
const spoilerBlind: NoteViewer = { id: VIEWER, showSpoilers: true };

function progress(read: number[], position?: { chapter: number; page: number }): ViewerProgress {
  return {
    readChapterSortIndexes: new Set(read),
    position: position ? { chapterSortIndex: position.chapter, page: position.page } : null,
  };
}

function anchor(chapterSortIndex: number | null, pageIndex: number | null = null): NoteAnchor {
  return { chapterSortIndex, pageIndex };
}

function note(overrides: Partial<GatedNote> = {}): GatedNote {
  return { authorId: AUTHOR, isSpoiler: false, anchor: anchor(2, 5), ...overrides };
}

describe("compareProgressPoints", () => {
  it("orders by chapter first, then page", () => {
    expect(
      compareProgressPoints({ chapterSortIndex: 1, page: 99 }, { chapterSortIndex: 2, page: 1 }),
    ).toBeLessThan(0);
    expect(
      compareProgressPoints({ chapterSortIndex: 2, page: 3 }, { chapterSortIndex: 2, page: 4 }),
    ).toBeLessThan(0);
    expect(
      compareProgressPoints({ chapterSortIndex: 2, page: 4 }, { chapterSortIndex: 2, page: 4 }),
    ).toBe(0);
  });

  it("treats a whole read chapter as past every page of it", () => {
    expect(
      compareProgressPoints(
        { chapterSortIndex: 2, page: WHOLE_CHAPTER },
        { chapterSortIndex: 2, page: 10_000 },
      ),
    ).toBeGreaterThan(0);
  });
});

describe("furthestProgress", () => {
  it("is null for a viewer who never opened the series", () => {
    expect(furthestProgress(progress([]))).toBeNull();
  });

  it("takes the furthest read chapter", () => {
    expect(furthestProgress(progress([0, 3, 1]))).toEqual({
      chapterSortIndex: 3,
      page: WHOLE_CHAPTER,
    });
  });

  it("prefers a reading position further along than any read chapter", () => {
    expect(furthestProgress(progress([0], { chapter: 2, page: 4 }))).toEqual({
      chapterSortIndex: 2,
      page: 4,
    });
  });

  it("keeps the read chapter when the position sits behind it", () => {
    expect(furthestProgress(progress([3], { chapter: 1, page: 2 }))).toEqual({
      chapterSortIndex: 3,
      page: WHOLE_CHAPTER,
    });
  });
});

describe("isBeyondProgress", () => {
  it("never hides a series-level note", () => {
    expect(isBeyondProgress(anchor(null, null), progress([]))).toBe(false);
  });

  it("hides everything from a viewer with no progress at all", () => {
    expect(isBeyondProgress(anchor(0, 1), progress([]))).toBe(true);
  });

  it("shows notes on a chapter the viewer has finished", () => {
    expect(isBeyondProgress(anchor(2, 10), progress([2]))).toBe(false);
  });

  it("shows notes on a chapter read even when the position moved back", () => {
    expect(isBeyondProgress(anchor(3, 4), progress([3], { chapter: 1, page: 1 }))).toBe(false);
  });

  it("shows the current page and everything before it", () => {
    const at = progress([], { chapter: 2, page: 5 });
    expect(isBeyondProgress(anchor(2, 4), at)).toBe(false);
    expect(isBeyondProgress(anchor(2, 5), at)).toBe(false);
    expect(isBeyondProgress(anchor(2, 6), at)).toBe(true);
  });

  it("shows chapter-level notes as soon as the chapter is open", () => {
    expect(isBeyondProgress(anchor(2, null), progress([], { chapter: 2, page: 1 }))).toBe(false);
    expect(isBeyondProgress(anchor(3, null), progress([], { chapter: 2, page: 1 }))).toBe(true);
  });

  it("hides later chapters and shows earlier ones", () => {
    const at = progress([0, 1], { chapter: 2, page: 3 });
    expect(isBeyondProgress(anchor(0, 9), at)).toBe(false);
    expect(isBeyondProgress(anchor(3, 1), at)).toBe(true);
  });
});

describe("noteHiddenReason", () => {
  it("never hides your own note", () => {
    const own = note({ authorId: VIEWER, isSpoiler: true, anchor: anchor(3, 9) });
    expect(noteHiddenReason(own, viewer, progress([]))).toBeNull();
  });

  it("never hides anything from a showSpoilers viewer", () => {
    const flagged = note({ isSpoiler: true, anchor: anchor(3, 9) });
    expect(noteHiddenReason(flagged, spoilerBlind, progress([]))).toBeNull();
  });

  it("reports a flagged note as a spoiler even on a page you have read", () => {
    const flagged = note({ isSpoiler: true, anchor: anchor(0, 1) });
    expect(noteHiddenReason(flagged, viewer, progress([0]))).toBe("spoiler");
  });

  it("reports an unreached note as progress", () => {
    expect(noteHiddenReason(note({ anchor: anchor(3, 1) }), viewer, progress([0]))).toBe(
      "progress",
    );
  });

  it("prefers the spoiler flag when both reasons apply", () => {
    const both = note({ isSpoiler: true, anchor: anchor(3, 1) });
    expect(noteHiddenReason(both, viewer, progress([0]))).toBe("spoiler");
  });

  it("returns null for a readable, unflagged note", () => {
    expect(noteHiddenReason(note({ anchor: anchor(0, 2) }), viewer, progress([0]))).toBeNull();
  });
});

describe("isNoteHidden", () => {
  it("agrees with noteHiddenReason", () => {
    const hiddenNote = note({ anchor: anchor(3, 1) });
    const visibleNote = note({ anchor: anchor(0, 1) });
    expect(isNoteHidden(hiddenNote, viewer, progress([0]))).toBe(true);
    expect(isNoteHidden(visibleNote, viewer, progress([0]))).toBe(false);
  });
});
