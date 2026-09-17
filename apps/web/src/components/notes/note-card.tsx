"use client";

/**
 * One note: who wrote it, when, its body (or a spoiler shield), and the
 * actions its author has on it.
 *
 * The card owns the reveal: clicking the shield starts a second, separate
 * query for the same note with `reveal=1` (see `useNoteThread`), so the
 * shielded copy in the list cache is never rewritten behind other views' backs
 * and a page reload shields the note again.
 *
 * Three body states are possible, and they are distinguished exactly as the
 * wire contract describes them: `hidden` with an empty body is gated, an empty
 * body without `hidden` is a soft-deleted note, anything else is the text.
 */
import { useState } from "react";
import { CornerDownRight, Pencil, Pin, Reply, Trash2 } from "lucide-react";
import { SpoilerShield } from "@/components/notes/spoiler-shield";
import { Badge, Button, Checkbox, Textarea } from "@/components/ui";
import { useDeleteNote, useEditNote, useNoteThread, type LocalNoteView } from "@/hooks/use-notes";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/lib/format";

export interface NoteCardProps {
  seriesId: string;
  note: LocalNoteView;
  /** e.g. "Ch. 3 · page 12" — shown on the series page, not in the reader. */
  contextLabel?: string;
  /** Omitted for replies, which cannot be replied to in turn. */
  onReply?: (note: LocalNoteView) => void;
  /** Renders as a reply: indented, with a marker. */
  asReply?: boolean;
  className?: string;
}

export function NoteCard({
  seriesId,
  note,
  contextLabel,
  onReply,
  asReply = false,
  className,
}: NoteCardProps) {
  const [revealed, setRevealed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const [draftSpoiler, setDraftSpoiler] = useState(note.isSpoiler);

  const revealQuery = useNoteThread(note.id, true, revealed);
  const editNote = useEditNote(seriesId);
  const deleteNote = useDeleteNote(seriesId);

  const revealedBody = revealed ? (revealQuery.data?.note.body ?? null) : null;
  const deleted = !note.hidden && note.body === "";
  const gated = note.hidden && note.body === "" && revealedBody === null;
  const body = note.body !== "" ? note.body : (revealedBody ?? "");

  function startEditing() {
    setDraft(body);
    setDraftSpoiler(note.isSpoiler);
    setEditing(true);
  }

  function save() {
    const trimmed = draft.trim();
    if (trimmed === "") return;
    editNote.mutate(
      { noteId: note.id, body: trimmed, isSpoiler: draftSpoiler },
      { onSuccess: () => setEditing(false) },
    );
  }

  return (
    <article
      data-testid="note-card"
      data-note-id={note.id}
      className={cn(
        "rounded-md border border-card-border bg-card p-3",
        asReply && "border-l-2 border-l-primary/40",
        className,
      )}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        {asReply ? <CornerDownRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
        <span className="font-medium text-foreground">{note.author.displayName}</span>
        <time dateTime={note.createdAt}>{formatRelativeTime(note.createdAt)}</time>
        {note.editedAt ? <span>· edited</span> : null}
        {note.pinX !== null ? (
          <Pin className="h-3.5 w-3.5" aria-label="Pinned to the page" />
        ) : null}
        {contextLabel ? <span className="truncate">· {contextLabel}</span> : null}
        {note.pending ? (
          <Badge tone="warning" className="ml-auto">
            Pending
          </Badge>
        ) : null}
      </header>

      <div className="mt-2 text-sm">
        {editing ? (
          <div className="flex flex-col gap-2">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-label="Edit note"
              rows={3}
            />
            <Checkbox
              checked={draftSpoiler}
              onChange={(event) => setDraftSpoiler(event.target.checked)}
              label="Mark as a spoiler"
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={save} loading={editNote.isPending}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : deleted ? (
          <p className="italic text-muted">This note was deleted.</p>
        ) : gated ? (
          <SpoilerShield
            reason={note.isSpoiler ? "spoiler" : "progress"}
            revealing={revealQuery.isFetching}
            onReveal={() => setRevealed(true)}
          />
        ) : (
          <p className="whitespace-pre-wrap break-words text-foreground">{body}</p>
        )}
      </div>

      {editing || deleted ? null : (
        <footer className="mt-2 flex flex-wrap items-center gap-1">
          {onReply ? (
            <Button size="sm" variant="ghost" onClick={() => onReply(note)}>
              <Reply className="h-4 w-4" aria-hidden="true" />
              Reply
            </Button>
          ) : null}
          {note.canEdit && !note.pending ? (
            <>
              <Button size="sm" variant="ghost" onClick={startEditing}>
                <Pencil className="h-4 w-4" aria-hidden="true" />
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                loading={deleteNote.isPending}
                onClick={() => deleteNote.mutate({ note })}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Delete
              </Button>
            </>
          ) : null}
        </footer>
      )}
    </article>
  );
}
