"use client";

/**
 * Chapter list in a dialog: filterable, read state ticked, current chapter
 * highlighted, unreadable chapters (still downloading, failed, missing from
 * the source) listed but disabled so the list matches the series page.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import { Dialog, Input } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { ChapterListItem } from "@/lib/contracts/content";
import { filterChapters, formatChapterLabel, isReadableChapter } from "@/lib/reader/chapters";

export interface ChapterPickerProps {
  open: boolean;
  onClose: () => void;
  chapters: ChapterListItem[];
  currentChapterId: string | null;
  onSelect: (chapterId: string) => void;
}

export function ChapterPicker({
  open,
  onClose,
  chapters,
  currentChapterId,
  onSelect,
}: ChapterPickerProps) {
  const [query, setQuery] = useState("");
  const currentRef = useRef<HTMLButtonElement>(null);

  // Clearing the filter on the way out (rather than on the way in) keeps the
  // reset in an event handler, where it belongs.
  function close() {
    setQuery("");
    onClose();
  }

  // Scroll the chapter you're on into view when the dialog opens.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      currentRef.current?.scrollIntoView({ block: "center" });
    }, 0);
    return () => clearTimeout(timer);
  }, [open]);

  const visible = useMemo(() => filterChapters(chapters, query), [chapters, query]);

  return (
    <Dialog open={open} onClose={close} title="Chapters" className="max-w-lg">
      <Input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter chapters"
        aria-label="Filter chapters"
      />

      <ul className="mt-3 max-h-[60vh] overflow-y-auto" data-testid="chapter-picker-list">
        {visible.length === 0 ? (
          <li className="p-4 text-center text-sm text-muted">No chapters match that filter.</li>
        ) : null}
        {visible.map((chapter) => {
          const readable = isReadableChapter(chapter);
          const isCurrent = chapter.id === currentChapterId;
          return (
            <li key={chapter.id}>
              <button
                ref={isCurrent ? currentRef : undefined}
                type="button"
                disabled={!readable}
                aria-current={isCurrent ? "true" : undefined}
                onClick={() => {
                  onSelect(chapter.id);
                  close();
                }}
                className={cn(
                  "focus-ring flex w-full items-center gap-3 rounded-md px-3 py-3 text-left text-sm",
                  isCurrent ? "bg-primary-light text-primary" : "hover:bg-surface-2",
                  !readable && "cursor-not-allowed opacity-50",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{formatChapterLabel(chapter)}</span>
                {chapter.volume ? (
                  <span className="shrink-0 text-xs text-muted">Vol. {chapter.volume}</span>
                ) : null}
                {!readable ? (
                  <span className="shrink-0 text-xs text-muted">
                    {chapter.status.toLowerCase()}
                  </span>
                ) : null}
                {chapter.read ? (
                  <Check className="h-4 w-4 shrink-0 text-success" aria-label="Read" role="img" />
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
