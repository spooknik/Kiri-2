"use client";

/**
 * The notes overlay for a single page, mounted by the reader inside the box
 * that the page image actually occupies (`PageImage`'s `overlay` slot).
 *
 * It is deliberately dumb: it picks the notes anchored to its own page out of
 * the chapter's list and hands them to `NoteMarkers`. Everything stateful —
 * which page the panel shows, the pin being placed — lives in
 * `notes-overlay.tsx`, so the strip's virtualisation can mount and unmount
 * these freely without losing anything.
 */
import { NoteMarkers } from "@/components/notes/note-markers";
import type { NotePin } from "@/components/notes/note-composer";
import type { NoteView } from "@/lib/contracts/notes";

export interface NotesLayerProps {
  /** 1-based page this layer covers. */
  pageIndex: number;
  /** Every top-level note in the chapter; filtered to this page here. */
  notes: NoteView[];
  /** True when the composer is waiting for a pin *on this page*. */
  pinMode: boolean;
  draftPin: NotePin | null;
  onPlacePin: (pin: NotePin) => void;
  onOpenNote: (note: NoteView) => void;
  onOpenPage: (pageIndex: number) => void;
}

export function NotesLayer({
  pageIndex,
  notes,
  pinMode,
  draftPin,
  onPlacePin,
  onOpenNote,
  onOpenPage,
}: NotesLayerProps) {
  const pageNotes = notes.filter((note) => note.pageIndex === pageIndex);
  if (pageNotes.length === 0 && !pinMode && draftPin === null) return null;

  return (
    <NoteMarkers
      notes={pageNotes}
      pinMode={pinMode}
      draftPin={draftPin}
      onPlacePin={onPlacePin}
      onOpenNote={onOpenNote}
      onOpenPage={() => onOpenPage(pageIndex)}
    />
  );
}
