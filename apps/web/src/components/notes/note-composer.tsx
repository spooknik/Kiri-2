"use client";

/**
 * Writes a note: body, spoiler flag, and — in the reader — an optional pin on
 * the page image.
 *
 * The composer never talks to the API. It mints the note id, builds the
 * optimistic row and hands both to `useUpsertNote`, which goes through the
 * note transport so the same code path works offline (the write is queued and
 * the note shows a "Pending" badge until it syncs).
 *
 * Pin placement is a *mode*, not a control the composer owns: the tap has to
 * land on the page image, which lives in the reader. The composer toggles the
 * mode and renders whatever coordinates come back.
 */
import { useState } from "react";
import { MapPin, Send, X } from "lucide-react";
import { Button, Checkbox, Textarea } from "@/components/ui";
import { useProfile } from "@/hooks/use-profile";
import { useUpsertNote, type LocalNoteView } from "@/hooks/use-notes";
import { cn } from "@/lib/cn";
import type { NoteView, UpsertNoteInput } from "@/lib/contracts/notes";
import { newNoteId } from "@/lib/notes/transport";

/** A normalised point on the page image. */
export interface NotePin {
  x: number;
  y: number;
}

export interface NoteComposerProps {
  seriesId: string;
  chapterId: string | null;
  /** 1-based page, or null for a chapter-/series-level note. */
  pageIndex: number | null;
  /** Set for a reply; the server inherits the parent's anchor either way. */
  parentId?: string | null;
  /** Chapter reference for the optimistic row, when the caller knows it. */
  chapter?: NoteView["chapter"];
  /** Pin support — omit `onPinModeChange` to hide the pin control entirely. */
  pin?: NotePin | null;
  pinMode?: boolean;
  onPinModeChange?: (active: boolean) => void;
  onClearPin?: () => void;
  onSubmitted?: (note: LocalNoteView) => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
}

export function NoteComposer({
  seriesId,
  chapterId,
  pageIndex,
  parentId = null,
  chapter = null,
  pin = null,
  pinMode = false,
  onPinModeChange,
  onClearPin,
  onSubmitted,
  placeholder = "Leave a note…",
  autoFocus = false,
  className,
}: NoteComposerProps) {
  const [body, setBody] = useState("");
  const [isSpoiler, setIsSpoiler] = useState(false);
  const profile = useProfile();
  const upsert = useUpsertNote(seriesId);

  const canPin = onPinModeChange !== undefined && pageIndex !== null && parentId === null;
  const trimmed = body.trim();

  function submit() {
    if (trimmed === "") return;

    const noteId = newNoteId();
    const usePin = canPin && pin !== null;
    const input: UpsertNoteInput = {
      seriesId,
      chapterId: parentId === null ? chapterId : null,
      pageIndex: parentId === null ? pageIndex : null,
      pinX: usePin ? pin.x : null,
      pinY: usePin ? pin.y : null,
      body: trimmed,
      parentId,
      isSpoiler,
    };

    const now = new Date().toISOString();
    const optimistic: LocalNoteView = {
      id: noteId,
      seriesId,
      chapterId: input.chapterId,
      chapter,
      pageIndex: input.pageIndex,
      pinX: input.pinX,
      pinY: input.pinY,
      body: trimmed,
      author: {
        id: profile.data?.id ?? "",
        displayName: profile.data?.displayName ?? "You",
      },
      parentId,
      isSpoiler,
      hidden: false,
      replyCount: 0,
      canEdit: true,
      editedAt: null,
      createdAt: now,
      updatedAt: now,
      pending: true,
    };

    upsert.mutate({ noteId, input, optimistic });

    setBody("");
    setIsSpoiler(false);
    onPinModeChange?.(false);
    onClearPin?.();
    onSubmitted?.(optimistic);
  }

  return (
    <form
      className={cn("flex flex-col gap-2", className)}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder={placeholder}
        aria-label={parentId === null ? "New note" : "Reply"}
        rows={3}
        autoFocus={autoFocus}
        // Ctrl/Cmd+Enter posts, so the reader's keyboard shortcuts stay usable.
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      />

      <p className="text-xs text-muted">
        Type <span className="font-medium text-foreground">@name</span> to notify someone who can
        see this series.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Checkbox
          checked={isSpoiler}
          onChange={(event) => setIsSpoiler(event.target.checked)}
          label="Spoiler"
        />

        {canPin ? (
          <Button
            type="button"
            size="sm"
            variant={pinMode || pin ? "primary" : "secondary"}
            data-testid="pin-toggle"
            onClick={() => {
              if (pin && !pinMode) {
                onClearPin?.();
                return;
              }
              onPinModeChange?.(!pinMode);
            }}
          >
            {pin && !pinMode ? (
              <X className="h-4 w-4" aria-hidden="true" />
            ) : (
              <MapPin className="h-4 w-4" aria-hidden="true" />
            )}
            {pin && !pinMode ? "Remove pin" : pinMode ? "Tap the page" : "Pin to page"}
          </Button>
        ) : null}

        <Button
          type="submit"
          size="sm"
          className="ml-auto"
          disabled={trimmed === ""}
          loading={upsert.isPending}
        >
          <Send className="h-4 w-4" aria-hidden="true" />
          {parentId === null ? "Post note" : "Reply"}
        </Button>
      </div>
    </form>
  );
}
