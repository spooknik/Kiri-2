"use client";

import { useState } from "react";
import { Button, useToast } from "@/components/ui";
import { useSetChapterRead } from "@/hooks/use-chapters";
import type { ChapterListItem } from "@/lib/contracts/content";
import { ChapterRow } from "./chapter-row";

const COLLAPSE_AFTER = 30;

export interface ChapterListProps {
  seriesId: string;
  chapters: ChapterListItem[];
  canEdit: boolean;
}

/** Chapter rows sorted by sortIndex, collapsed to `COLLAPSE_AFTER` with a "Show all" toggle for long lists. */
export function ChapterList({ seriesId, chapters, canEdit }: ChapterListProps) {
  const [expanded, setExpanded] = useState(false);
  const [markingUpTo, setMarkingUpTo] = useState<string | null>(null);
  const setChapterRead = useSetChapterRead(seriesId);
  const { toast, dismiss } = useToast();

  const sorted = [...chapters].sort((a, b) => a.sortIndex - b.sortIndex);
  const visible = expanded ? sorted : sorted.slice(0, COLLAPSE_AFTER);
  const hiddenCount = sorted.length - visible.length;

  async function markAllReadUpTo(chapter: ChapterListItem) {
    const toMark = sorted.filter((c) => c.sortIndex <= chapter.sortIndex && !c.read);
    if (toMark.length === 0) return;

    setMarkingUpTo(chapter.id);
    let toastId = toast({ title: `Marking chapters as read… 0 / ${toMark.length}`, duration: 0 });

    let done = 0;
    let failed = 0;
    for (const target of toMark) {
      try {
        await setChapterRead.mutateAsync({ chapterId: target.id, read: true });
      } catch {
        failed += 1;
      }
      done += 1;
      dismiss(toastId);
      const allDone = done === toMark.length;
      toastId = toast({
        title: allDone
          ? failed > 0
            ? `Marked ${done - failed} of ${toMark.length} chapters as read`
            : `Marked ${toMark.length} chapter${toMark.length === 1 ? "" : "s"} as read`
          : `Marking chapters as read… ${done} / ${toMark.length}`,
        tone: allDone ? (failed > 0 ? "warning" : "success") : "neutral",
        duration: allDone ? 4000 : 0,
      });
    }
    setMarkingUpTo(null);
  }

  if (sorted.length === 0) {
    return <p className="py-6 text-center text-sm text-muted">No chapters yet.</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col divide-y divide-card-border">
        {visible.map((chapter) => (
          <ChapterRow
            key={chapter.id}
            seriesId={seriesId}
            chapter={chapter}
            canEdit={canEdit}
            onMarkAllReadUpTo={() => void markAllReadUpTo(chapter)}
            markingAllRead={markingUpTo === chapter.id}
          />
        ))}
      </ul>
      {hiddenCount > 0 || expanded ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((v) => !v)}
          className="self-start"
        >
          {expanded ? "Collapse" : `Show all (${hiddenCount} more)`}
        </Button>
      ) : null}
    </div>
  );
}
