"use client";

/**
 * The reader's side of the notes feature, packaged as one hook so
 * `reader-shell.tsx` only gains a handful of lines and the reader's
 * virtualisation, zoom and progress logic stay untouched.
 *
 * It owns:
 *   - the chapter's notes query (one request per chapter, not per page);
 *   - which page the panel is showing (it follows the reader unless you tapped
 *     a marker on a different page);
 *   - the pin being placed, and the mode that makes a page accept a tap;
 *   - the deep link `?notes=1&note=<id>` that note notifications point at.
 *
 * The reader mounts `renderPageOverlay(page)` inside each page container and
 * `panel` next to its dialogs.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import type { NotePin } from "@/components/notes/note-composer";
import { NotesPanel, type NotesScope } from "@/components/notes/notes-panel";
import { NotesLayer } from "@/components/reader/notes-layer";
import { useNotes } from "@/hooks/use-notes";
import type { PageView } from "@/lib/contracts/content";
import type { NoteView } from "@/lib/contracts/notes";

export interface ReaderNotesParams {
  seriesId: string | null;
  chapterId: string | null;
  /** Chapter reference for optimistic rows; null before the chapter loads. */
  chapter: NoteView["chapter"];
  chapterLabel: string;
  /** 1-based page the reader is currently on. */
  pageNumber: number;
}

export interface ReaderNotes {
  /** True while the panel is on screen (the reader keeps its chrome up). */
  open: boolean;
  toggle: () => void;
  /** Notes anchored to the page the reader is on, for the top-bar badge. */
  currentPageCount: number;
  /** Mounted inside every page container by the strip and paged views. */
  renderPageOverlay: (page: PageView) => ReactNode;
  panel: ReactNode;
}

export function useReaderNotes({
  seriesId,
  chapterId,
  chapter,
  chapterLabel,
  pageNumber,
}: ReaderNotesParams): ReaderNotes {
  const searchParams = useSearchParams();
  const wantsNotes = searchParams.get("notes") === "1";
  const linkedNoteId = searchParams.get("note");

  const [open, setOpen] = useState(wantsNotes);
  const [scope, setScope] = useState<NotesScope>("page");
  const [panelPage, setPanelPage] = useState<number | null>(null);
  const [focusNoteId, setFocusNoteId] = useState<string | null>(linkedNoteId);
  const [pinMode, setPinMode] = useState(false);
  const [draftPin, setDraftPin] = useState<NotePin | null>(null);

  const notesQuery = useNotes(seriesId, { chapterId, enabled: Boolean(chapterId) });
  const notes = useMemo(() => notesQuery.data?.items ?? [], [notesQuery.data]);
  const pageCounts = notesQuery.data?.pageCounts ?? {};

  // The panel follows the reader: turning the page moves it back onto the page
  // you are looking at, unless you opened it from a marker on another one.
  // Derived during render rather than in an effect, so the panel never paints
  // one frame pointing at the page you just left.
  const [readerAt, setReaderAt] = useState({ pageNumber, chapterId });
  if (readerAt.pageNumber !== pageNumber || readerAt.chapterId !== chapterId) {
    setReaderAt({ pageNumber, chapterId });
    if (panelPage !== null) setPanelPage(null);
  }

  const effectivePage = panelPage ?? pageNumber;
  const currentPageCount = pageCounts[String(pageNumber)] ?? 0;

  const close = useCallback(() => {
    setOpen(false);
    setPinMode(false);
    setDraftPin(null);
    setFocusNoteId(null);
  }, []);

  const toggle = useCallback(() => {
    setOpen((value) => {
      if (value) {
        setPinMode(false);
        setDraftPin(null);
      }
      return !value;
    });
  }, []);

  const openNote = useCallback((note: NoteView) => {
    setPanelPage(note.pageIndex);
    setScope(note.pageIndex === null ? "chapter" : "page");
    setFocusNoteId(note.id);
    setOpen(true);
  }, []);

  const openPage = useCallback((page: number) => {
    setPanelPage(page);
    setScope("page");
    setFocusNoteId(null);
    setOpen(true);
  }, []);

  const placePin = useCallback((pin: NotePin) => {
    setDraftPin(pin);
    setPinMode(false);
  }, []);

  const renderPageOverlay = useCallback(
    (page: PageView): ReactNode => (
      <NotesLayer
        pageIndex={page.index}
        notes={notes}
        pinMode={pinMode && page.index === effectivePage}
        draftPin={page.index === effectivePage ? draftPin : null}
        onPlacePin={placePin}
        onOpenNote={openNote}
        onOpenPage={openPage}
      />
    ),
    [notes, pinMode, effectivePage, draftPin, placePin, openNote, openPage],
  );

  const panel =
    open && seriesId ? (
      <NotesPanel
        open={open}
        onClose={close}
        seriesId={seriesId}
        chapterId={chapterId}
        pageIndex={effectivePage}
        chapterLabel={chapterLabel}
        chapter={chapter}
        scope={scope}
        onScopeChange={setScope}
        pin={draftPin}
        pinMode={pinMode}
        onPinModeChange={setPinMode}
        onClearPin={() => setDraftPin(null)}
        focusNoteId={focusNoteId}
      />
    ) : null;

  return { open, toggle, currentPageCount, renderPageOverlay, panel };
}
