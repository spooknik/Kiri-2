"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check } from "lucide-react";
import { Card, Field, Label, Select, Switch, Textarea } from "@/components/ui";
import { useUntrackSeries, useUpdateEntry } from "@/hooks/use-entry";
import {
  READING_STATUSES,
  READING_STATUS_LABELS,
  type LibraryEntryView,
  type ReadingStatus,
} from "@/lib/contracts/series";
import { ConfirmDialog } from "./confirm-dialog";
import { NumberStepper } from "./number-stepper";
import { RatingStars } from "./rating-stars";

export interface ProgressCardProps {
  seriesId: string;
  entry: LibraryEntryView;
  totalChapters: number | null;
}

const NOTES_SAVE_DELAY_MS = 800;

/** "My progress" card: status, chapter, rating, notes (debounced autosave), favorite, stop tracking. */
export function ProgressCard({ seriesId, entry, totalChapters }: ProgressCardProps) {
  const uid = useId();
  const updateEntry = useUpdateEntry(seriesId);
  const untrackSeries = useUntrackSeries(seriesId);

  const [notes, setNotes] = useState(entry.notes ?? "");
  const [notesSaved, setNotesSaved] = useState(true);
  const [confirmUntrack, setConfirmUntrack] = useState(false);
  const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSyncedNotes = useRef(entry.notes ?? "");

  // Pick up server-side changes (another tab/device) without clobbering an
  // edit the user hasn't finished typing yet.
  useEffect(() => {
    const serverNotes = entry.notes ?? "";
    if (serverNotes !== lastSyncedNotes.current && notes === lastSyncedNotes.current) {
      setNotes(serverNotes);
      lastSyncedNotes.current = serverNotes;
    }
  }, [entry.notes, notes]);

  useEffect(
    () => () => {
      if (notesTimer.current) clearTimeout(notesTimer.current);
    },
    [],
  );

  function handleNotesChange(value: string) {
    setNotes(value);
    setNotesSaved(false);
    if (notesTimer.current) clearTimeout(notesTimer.current);
    notesTimer.current = setTimeout(() => {
      lastSyncedNotes.current = value;
      updateEntry.mutate({ notes: value.trim() || null }, { onSettled: () => setNotesSaved(true) });
    }, NOTES_SAVE_DELAY_MS);
  }

  function handleUntrack() {
    untrackSeries.mutate(undefined, { onSuccess: () => setConfirmUntrack(false) });
  }

  const chapterSuffix = totalChapters ? ` of ${totalChapters}` : "";

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">My progress</h2>
        <label className="flex items-center gap-2 text-sm text-muted">
          Favorite
          <Switch
            checked={entry.favorite}
            onCheckedChange={(favorite) => updateEntry.mutate({ favorite })}
            aria-label="Favorite"
          />
        </label>
      </div>

      <Field label="Status" htmlFor={`${uid}-status`}>
        <Select
          value={entry.status}
          onChange={(e) => updateEntry.mutate({ status: e.target.value as ReadingStatus })}
        >
          {READING_STATUSES.map((status) => (
            <option key={status} value={status}>
              {READING_STATUS_LABELS[status]}
            </option>
          ))}
        </Select>
      </Field>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${uid}-chapter`}>
          Chapter
          {chapterSuffix ? <span className="font-normal text-muted">{chapterSuffix}</span> : null}
        </Label>
        <NumberStepper
          id={`${uid}-chapter`}
          value={entry.currentChapter}
          min={0}
          max={totalChapters ?? 100_000}
          onChange={(value) => updateEntry.mutate({ currentChapter: value })}
          aria-label="Current chapter"
        />
        <button
          type="button"
          onClick={() => updateEntry.mutate({ currentChapter: entry.currentChapter + 1 })}
          className="focus-ring self-start rounded-md bg-primary px-3 py-2 text-xs font-medium text-white hover:bg-primary-hover"
        >
          +1 chapter
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-foreground">Rating</span>
        <RatingStars value={entry.rating} onChange={(rating) => updateEntry.mutate({ rating })} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${uid}-notes`}>Notes</Label>
        <Textarea
          id={`${uid}-notes`}
          rows={3}
          value={notes}
          onChange={(e) => handleNotesChange(e.target.value)}
          placeholder="Your notes about this series…"
        />
        <span className="flex items-center gap-1 text-xs text-muted" aria-live="polite">
          {notesSaved ? (
            <>
              <Check className="h-3 w-3" aria-hidden="true" /> Saved
            </>
          ) : (
            "Saving…"
          )}
        </span>
      </div>

      {!confirmUntrack ? (
        <button
          type="button"
          onClick={() => setConfirmUntrack(true)}
          className="focus-ring self-start text-xs font-medium text-danger hover:underline"
        >
          Stop tracking
        </button>
      ) : null}

      <ConfirmDialog
        open={confirmUntrack}
        onClose={() => setConfirmUntrack(false)}
        onConfirm={handleUntrack}
        title="Stop tracking this series?"
        description="Your status, chapter progress, rating and notes for this series will be removed. The series itself stays in the library for everyone else."
        confirmLabel="Stop tracking"
        loading={untrackSeries.isPending}
      />
    </Card>
  );
}
