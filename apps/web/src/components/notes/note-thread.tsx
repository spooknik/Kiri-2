"use client";

/**
 * A top-level note with its replies.
 *
 * Replies are fetched lazily (`GET /api/notes/:id`) the first time the thread
 * is expanded, so a page full of notes costs one list request rather than one
 * request per note. A deleted parent keeps its place here: its card renders the
 * "deleted" placeholder and the replies below it stay readable.
 */
import { useState } from "react";
import { MessageSquare } from "lucide-react";
import { NoteCard } from "@/components/notes/note-card";
import { NoteComposer } from "@/components/notes/note-composer";
import { Button, Spinner } from "@/components/ui";
import { useNoteThread, type LocalNoteView } from "@/hooks/use-notes";
import { cn } from "@/lib/cn";

export interface NoteThreadProps {
  seriesId: string;
  note: LocalNoteView;
  /** e.g. "Ch. 3 · page 12" — shown on the series page. */
  contextLabel?: string;
  /** Expand replies and the reply box straight away (deep link from a link). */
  defaultOpen?: boolean;
  className?: string;
}

export function NoteThread({
  seriesId,
  note,
  contextLabel,
  defaultOpen = false,
  className,
}: NoteThreadProps) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const [replying, setReplying] = useState(defaultOpen);

  // A deep link can select this thread after it is already on screen (tapping
  // a marker for a note the list already holds). Adjusting state during render
  // is React's own answer to "derive from props" — cheaper, and without the
  // extra committed frame an effect would cost.
  const [wasDefaultOpen, setWasDefaultOpen] = useState(defaultOpen);
  if (defaultOpen !== wasDefaultOpen) {
    setWasDefaultOpen(defaultOpen);
    if (defaultOpen) setExpanded(true);
  }

  const shouldLoad = expanded && !note.pending;
  const thread = useNoteThread(note.id, false, shouldLoad);
  const replies = thread.data?.replies ?? [];
  const replyCount = Math.max(note.replyCount, replies.length);

  return (
    <section className={cn("flex flex-col gap-2", className)} data-testid="note-thread">
      <NoteCard
        seriesId={seriesId}
        note={note}
        contextLabel={contextLabel}
        onReply={() => {
          setExpanded(true);
          setReplying(true);
        }}
      />

      {replyCount > 0 && !expanded ? (
        <Button size="sm" variant="ghost" className="self-start" onClick={() => setExpanded(true)}>
          <MessageSquare className="h-4 w-4" aria-hidden="true" />
          {replyCount === 1 ? "1 reply" : `${replyCount} replies`}
        </Button>
      ) : null}

      {expanded ? (
        <div className="flex flex-col gap-2 pl-3">
          {thread.isPending && shouldLoad ? <Spinner size="sm" label="Loading replies" /> : null}
          {replies.map((reply) => (
            <NoteCard key={reply.id} seriesId={seriesId} note={reply} asReply />
          ))}

          {replying ? (
            <NoteComposer
              seriesId={seriesId}
              chapterId={note.chapterId}
              pageIndex={note.pageIndex}
              parentId={note.id}
              chapter={note.chapter}
              placeholder="Write a reply…"
              autoFocus
            />
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() => setReplying(true)}
            >
              Reply
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}
