"use client";

/**
 * Auto-hiding top chrome: back to the series, what you're reading, where you
 * are in the chapter, and the settings gear.
 *
 * Always dark regardless of the page background pref — white chrome over a
 * white page would vanish, and dark chrome reads fine over both.
 */
import { ChevronLeft, MessageSquare, Settings } from "lucide-react";
import { AppLink } from "@/components/shell/app-link";
import { cn } from "@/lib/cn";

export interface ReaderTopBarProps {
  visible: boolean;
  seriesId: string | null;
  seriesTitle: string;
  chapterTitle: string;
  pageNumber: number;
  pageCount: number;
  onOpenSettings: () => void;
  /** Omit to hide the notes button entirely (notes are an optional surface). */
  onToggleNotes?: () => void;
  /** Notes anchored to the page on screen; shown as a badge on the button. */
  notesCount?: number;
  notesOpen?: boolean;
}

export function ReaderTopBar({
  visible,
  seriesId,
  seriesTitle,
  chapterTitle,
  pageNumber,
  pageCount,
  onOpenSettings,
  onToggleNotes,
  notesCount = 0,
  notesOpen = false,
}: ReaderTopBarProps) {
  return (
    <header
      data-testid="reader-top-bar"
      className={cn(
        "pointer-events-auto absolute inset-x-0 top-0 z-20 bg-black/75 text-white backdrop-blur transition-transform duration-200",
        "pt-[env(safe-area-inset-top)]",
        visible ? "translate-y-0" : "-translate-y-full",
      )}
      aria-hidden={!visible}
    >
      <div className="flex h-14 items-center gap-2 px-1">
        <AppLink
          href={seriesId ? `/series/${seriesId}` : "/"}
          aria-label="Back to series"
          className="focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-white/80 hover:text-white"
          tabIndex={visible ? undefined : -1}
        >
          <ChevronLeft className="h-6 w-6" aria-hidden="true" />
        </AppLink>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{seriesTitle || "Reader"}</p>
          <p className="truncate text-xs text-white/60">{chapterTitle}</p>
        </div>

        {pageCount > 0 ? (
          <span className="shrink-0 rounded bg-white/10 px-2 py-1 text-xs font-medium tabular-nums text-white/80">
            {pageNumber} / {pageCount}
          </span>
        ) : null}

        {onToggleNotes ? (
          <button
            type="button"
            onClick={onToggleNotes}
            aria-label={notesOpen ? "Hide notes" : "Show notes"}
            aria-pressed={notesOpen}
            data-testid="reader-notes-button"
            tabIndex={visible ? undefined : -1}
            className="focus-ring relative flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-white/80 hover:text-white"
          >
            <MessageSquare className="h-5 w-5" aria-hidden="true" />
            {notesCount > 0 ? (
              <span className="absolute right-1 top-1.5 min-w-4 rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-white">
                {notesCount > 9 ? "9+" : notesCount}
              </span>
            ) : null}
          </button>
        ) : null}

        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="Reader settings"
          tabIndex={visible ? undefined : -1}
          className="focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-white/80 hover:text-white"
        >
          <Settings className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
