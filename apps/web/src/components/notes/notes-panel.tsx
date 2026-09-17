"use client";

/**
 * The reader's notes surface: a modal sheet on a phone, a docked side panel on
 * a wide screen.
 *
 * It shows the threads anchored to the page you are on (or, with the scope
 * switch, the whole chapter) and a composer underneath. Pin placement is
 * driven from here but happens on the page image — the panel only holds the
 * mode and the resulting coordinates, which the reader's overlay writes back.
 */
import { useEffect, useRef } from "react";
import { MapPin, MessageSquare, X } from "lucide-react";
import { NoteThread } from "@/components/notes/note-thread";
import { NoteComposer, type NotePin } from "@/components/notes/note-composer";
import { Dialog, EmptyState, Spinner } from "@/components/ui";
import { useNotes, type LocalNoteView } from "@/hooks/use-notes";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { NoteView } from "@/lib/contracts/notes";

/** Wide enough for a docked panel next to the page. */
const DOCKED_QUERY = "(min-width: 768px)";

export type NotesScope = "page" | "chapter";

export interface NotesPanelProps {
  open: boolean;
  onClose: () => void;
  seriesId: string;
  chapterId: string | null;
  /** 1-based page the reader is on, or null outside a chapter. */
  pageIndex: number | null;
  chapterLabel?: string;
  chapter?: NoteView["chapter"];
  scope: NotesScope;
  onScopeChange: (scope: NotesScope) => void;
  pin: NotePin | null;
  pinMode: boolean;
  onPinModeChange: (active: boolean) => void;
  onClearPin: () => void;
  /** Expand this note's thread when the panel opens (notification deep link). */
  focusNoteId?: string | null;
}

export function NotesPanel(props: NotesPanelProps) {
  const docked = useMediaQuery(DOCKED_QUERY);
  const { open, onClose, chapterLabel, pageIndex, pinMode, onPinModeChange } = props;

  // A native modal dialog makes the rest of the page inert, so on a phone the
  // sheet has to step aside while a pin is being placed. It is *closed*, not
  // unmounted, which is what keeps the half-written note in the composer.
  const pinModeRef = useRef(pinMode);
  useEffect(() => {
    // The dialog fires its close event on a queued task, so this has landed by
    // the time the handler below reads it.
    pinModeRef.current = pinMode;
  }, [pinMode]);

  const title = "Notes";
  const subtitle =
    props.scope === "page" && pageIndex !== null
      ? `${chapterLabel ? `${chapterLabel} · ` : ""}page ${pageIndex}`
      : (chapterLabel ?? "This series");

  if (!open) return null;

  if (!docked) {
    return (
      <>
        <Dialog
          open={!pinMode}
          onClose={() => {
            // Closing it ourselves for pin placement must not close the panel.
            if (!pinModeRef.current) onClose();
          }}
          title={title}
          description={subtitle}
          className="max-w-lg"
        >
          <NotesPanelBody {...props} />
        </Dialog>

        {pinMode ? (
          <div
            data-testid="notes-pin-hint"
            className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 border-t border-card-border bg-card px-4 py-3 text-sm text-foreground shadow-xl"
          >
            <MapPin className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <span className="min-w-0 flex-1">Tap the page to place your pin.</span>
            <button
              type="button"
              onClick={() => onPinModeChange(false)}
              className="focus-ring h-9 shrink-0 rounded-md px-3 font-medium text-muted hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <aside
      data-testid="notes-panel"
      aria-label="Notes"
      className="fixed inset-y-0 right-0 z-30 flex w-96 max-w-full flex-col border-l border-card-border bg-card text-foreground shadow-xl"
    >
      <header className="flex items-start justify-between gap-2 border-b border-card-border p-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-0.5 truncate text-sm text-muted">{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close notes"
          className="focus-ring -m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted hover:text-foreground"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <NotesPanelBody {...props} />
      </div>
    </aside>
  );
}

function NotesPanelBody({
  seriesId,
  chapterId,
  pageIndex,
  chapter,
  scope,
  onScopeChange,
  pin,
  pinMode,
  onPinModeChange,
  onClearPin,
  focusNoteId,
}: NotesPanelProps) {
  const pageFilter = scope === "page" ? pageIndex : null;
  const notesQuery = useNotes(seriesId, { chapterId, pageIndex: pageFilter });
  const items = (notesQuery.data?.items ?? []) as LocalNoteView[];

  return (
    <div className="flex flex-col gap-4">
      {pageIndex !== null ? (
        <div
          role="group"
          aria-label="Notes scope"
          className="flex gap-1 rounded-md bg-surface-2 p-1 text-sm"
        >
          {(["page", "chapter"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onScopeChange(value)}
              aria-pressed={scope === value}
              className={`focus-ring h-9 flex-1 rounded ${
                scope === value ? "bg-card font-medium text-foreground shadow-sm" : "text-muted"
              }`}
            >
              {value === "page" ? "This page" : "Whole chapter"}
            </button>
          ))}
        </div>
      ) : null}

      {notesQuery.isPending ? (
        <div className="flex justify-center py-6">
          <Spinner label="Loading notes" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="No notes here yet"
          description="Leave the first one — everyone who can see this series will read it."
          className="py-6"
        />
      ) : (
        <div className="flex flex-col gap-4">
          {items.map((note) => (
            <NoteThread
              key={note.id}
              seriesId={seriesId}
              note={note}
              defaultOpen={focusNoteId === note.id}
            />
          ))}
        </div>
      )}

      <div className="border-t border-card-border pt-4">
        <NoteComposer
          seriesId={seriesId}
          chapterId={chapterId}
          pageIndex={scope === "page" ? pageIndex : null}
          chapter={chapter ?? null}
          pin={pin}
          pinMode={pinMode}
          onPinModeChange={onPinModeChange}
          onClearPin={onClearPin}
        />
      </div>
    </div>
  );
}
