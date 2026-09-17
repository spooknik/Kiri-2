"use client";

/**
 * The note markers drawn over one page image: a pin per pinned note, one badge
 * for the notes on the page that were never pinned, and — while a pin is being
 * placed — a full-page tap target.
 *
 * Coordinates are normalised against the *rendered* image rectangle
 * (`getBoundingClientRect`), which already includes the reader's zoom
 * transform, so a pin dropped at 2x lands in the same spot as one dropped at
 * 1x and every marker moves with the artwork.
 *
 * The layer itself is `pointer-events: none`; only the markers (and the
 * placement target) take input. That is what keeps the reader's tap zones,
 * scrolling and pinch-zoom working with notes on screen. Every handler stops
 * propagation so a tap on a marker never also turns the page or toggles the
 * chrome.
 */
import type { PointerEvent as ReactPointerEvent } from "react";
import { MapPin, MessageSquare } from "lucide-react";
import type { NotePin } from "@/components/notes/note-composer";
import type { NoteView } from "@/lib/contracts/notes";

export interface NoteMarkersProps {
  /** Top-level notes anchored to this page. */
  notes: NoteView[];
  onOpenNote: (note: NoteView) => void;
  /** Tapping the page badge opens the panel for this page. */
  onOpenPage: () => void;
  /** True while the composer is waiting for a pin. */
  pinMode?: boolean;
  onPlacePin?: (pin: NotePin) => void;
  /** The pin the composer is holding but has not saved yet. */
  draftPin?: NotePin | null;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function stop(event: ReactPointerEvent): void {
  // The reader's tap handling (chrome toggle, page turn, zoom capture) lives on
  // ancestors; markers must not trigger it.
  event.stopPropagation();
}

export function NoteMarkers({
  notes,
  onOpenNote,
  onOpenPage,
  pinMode = false,
  onPlacePin,
  draftPin = null,
}: NoteMarkersProps) {
  const pinned = notes.filter((note) => note.pinX !== null && note.pinY !== null);
  const unpinned = notes.length - pinned.length;

  return (
    <div className="pointer-events-none absolute inset-0" data-testid="note-markers">
      {pinned.map((note, index) => (
        <button
          key={note.id}
          type="button"
          data-testid="note-pin"
          aria-label={`Note by ${note.author.displayName}`}
          style={{ left: `${(note.pinX ?? 0) * 100}%`, top: `${(note.pinY ?? 0) * 100}%` }}
          onPointerDown={stop}
          onPointerUp={stop}
          onClick={(event) => {
            event.stopPropagation();
            onOpenNote(note);
          }}
          className="focus-ring pointer-events-auto absolute flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/70 bg-primary text-[11px] font-semibold text-white shadow-md"
        >
          {index + 1}
        </button>
      ))}

      {draftPin ? (
        <span
          data-testid="note-pin-draft"
          aria-hidden="true"
          style={{ left: `${draftPin.x * 100}%`, top: `${draftPin.y * 100}%` }}
          className="pointer-events-none absolute flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-dashed border-white bg-primary/60 text-white"
        >
          <MapPin className="h-4 w-4" />
        </span>
      ) : null}

      {unpinned > 0 ? (
        <button
          type="button"
          data-testid="note-page-badge"
          aria-label={`${unpinned} ${unpinned === 1 ? "note" : "notes"} on this page`}
          onPointerDown={stop}
          onPointerUp={stop}
          onClick={(event) => {
            event.stopPropagation();
            onOpenPage();
          }}
          className="focus-ring pointer-events-auto absolute bottom-2 left-2 flex h-8 items-center gap-1.5 rounded-full bg-black/70 px-2.5 text-xs font-medium text-white shadow-md"
        >
          <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
          {unpinned}
        </button>
      ) : null}

      {pinMode && onPlacePin ? (
        <div
          data-testid="note-pin-target"
          role="button"
          tabIndex={-1}
          aria-label="Tap to place the pin"
          className="pointer-events-auto absolute inset-0 cursor-crosshair bg-primary/5"
          style={{ touchAction: "none" }}
          onPointerDown={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            onPlacePin({
              x: clamp01((event.clientX - rect.left) / rect.width),
              y: clamp01((event.clientY - rect.top) / rect.height),
            });
          }}
          onPointerUp={stop}
        />
      ) : null}
    </div>
  );
}
