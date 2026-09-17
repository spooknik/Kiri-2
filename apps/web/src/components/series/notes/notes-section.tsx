"use client";

/**
 * Notes on the series page: how many notes each chapter holds, the most recent
 * threads, and a composer for notes about the series as a whole.
 *
 * The per-chapter counts are links into the reader with `notes=1`, which the
 * reader honours by opening its panel on arrival — that is the whole hand-off
 * between this page and the overlay.
 *
 * `canEdit` is about editing the *series*; anybody who can see a series can
 * leave notes on it, so it is deliberately not used to gate the composer.
 */
import { MessageSquare } from "lucide-react";
import { NoteComposer } from "@/components/notes/note-composer";
import { NoteThread } from "@/components/notes/note-thread";
import { AppLink } from "@/components/shell/app-link";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Spinner,
} from "@/components/ui";
import { useChapters } from "@/hooks/use-chapters";
import { useNotes, useNotesSummary, type LocalNoteView } from "@/hooks/use-notes";
import type { ChapterListItem } from "@/lib/contracts/content";
import { formatChapterLabel } from "@/lib/reader/chapters";

/** Most recent threads shown inline; the reader is where the rest live. */
const RECENT_LIMIT = 8;

export interface NotesSectionProps {
  seriesId: string;
  canEdit: boolean;
}

/** `/read?...&notes=1` — the reader opens its notes panel when it sees this. */
function readerNotesHref(seriesId: string, chapterId: string, pageIndex?: number | null): string {
  const params = new URLSearchParams({ series: seriesId, chapter: chapterId });
  if (pageIndex != null) params.set("page", String(pageIndex));
  params.set("notes", "1");
  return `/read?${params.toString()}`;
}

export function NotesSection({ seriesId }: NotesSectionProps) {
  const summary = useNotesSummary(seriesId);
  const recent = useNotes(seriesId);
  const chapters = useChapters(seriesId);

  const byId = new Map<string, ChapterListItem>(
    (chapters.data?.chapters ?? []).map((chapter) => [chapter.id, chapter]),
  );

  const counts = (summary.data?.byChapter ?? [])
    .map((entry) => ({ ...entry, chapter: byId.get(entry.chapterId) }))
    .sort((a, b) => (a.chapter?.sortIndex ?? 0) - (b.chapter?.sortIndex ?? 0));

  const items = ((recent.data?.items ?? []) as LocalNoteView[]).slice(0, RECENT_LIMIT);

  function contextLabel(note: LocalNoteView): string | undefined {
    if (note.chapterId === null) return "About the series";
    const chapter = note.chapter ?? byId.get(note.chapterId) ?? null;
    const label = chapter ? formatChapterLabel(chapter) : "Chapter";
    return note.pageIndex === null ? label : `${label} · page ${note.pageIndex}`;
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4" aria-hidden="true" />
          Notes
        </CardTitle>
        {summary.data ? (
          <Badge tone={summary.data.total > 0 ? "primary" : "neutral"}>
            {summary.data.total} total
          </Badge>
        ) : null}
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        {counts.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {counts.map((entry) => (
              <AppLink
                key={entry.chapterId}
                href={readerNotesHref(seriesId, entry.chapterId)}
                className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-card-border bg-surface-2 px-3 py-1 text-xs font-medium text-secondary hover:text-foreground"
              >
                <span className="truncate">
                  {entry.chapter ? formatChapterLabel(entry.chapter) : "Chapter"}
                </span>
                <span className="tabular-nums text-primary">{entry.count}</span>
              </AppLink>
            ))}
          </div>
        ) : null}

        {recent.isPending ? (
          <div className="flex justify-center py-4">
            <Spinner label="Loading notes" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="No notes yet"
            description="Leave a note here, or pin one to a page while you read."
            className="py-6"
          />
        ) : (
          <div className="flex flex-col gap-4">
            {items.map((note) => (
              <NoteThread
                key={note.id}
                seriesId={seriesId}
                note={note}
                contextLabel={contextLabel(note)}
              />
            ))}
          </div>
        )}

        <div className="border-t border-card-border pt-4">
          <NoteComposer
            seriesId={seriesId}
            chapterId={null}
            pageIndex={null}
            placeholder="Leave a note about this series…"
          />
        </div>
      </CardContent>
    </Card>
  );
}
