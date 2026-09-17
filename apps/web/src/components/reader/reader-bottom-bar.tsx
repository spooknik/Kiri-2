"use client";

/**
 * Auto-hiding bottom chrome: chapter stepping, the chapter picker, and — in
 * the paged modes, where scrolling can't do it — a page slider.
 *
 * The slider runs in reading order, so in `rtl` it is mirrored: dragging left
 * moves forward, which is what the page-turn gesture does on the same screen.
 */
import { ChevronLeft, ChevronRight, List } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ReaderDirection } from "@/lib/reader/prefs";

export interface ReaderBottomBarProps {
  visible: boolean;
  chapterLabel: string;
  hasPrevChapter: boolean;
  hasNextChapter: boolean;
  onPrevChapter: () => void;
  onNextChapter: () => void;
  onOpenChapters: () => void;
  /** Slider is only shown in the paged modes. */
  showSlider: boolean;
  direction: ReaderDirection;
  pageIndex: number;
  pageCount: number;
  onSeekPage: (index: number) => void;
}

export function ReaderBottomBar({
  visible,
  chapterLabel,
  hasPrevChapter,
  hasNextChapter,
  onPrevChapter,
  onNextChapter,
  onOpenChapters,
  showSlider,
  direction,
  pageIndex,
  pageCount,
  onSeekPage,
}: ReaderBottomBarProps) {
  const tabIndex = visible ? undefined : -1;

  return (
    <footer
      data-testid="reader-bottom-bar"
      className={cn(
        "pointer-events-auto absolute inset-x-0 bottom-0 z-20 bg-black/75 text-white backdrop-blur transition-transform duration-200",
        "pb-[env(safe-area-inset-bottom)]",
        visible ? "translate-y-0" : "translate-y-full",
      )}
      aria-hidden={!visible}
    >
      {showSlider && pageCount > 1 ? (
        <div className="flex items-center gap-3 px-4 pt-3">
          <span className="w-8 shrink-0 text-right text-xs tabular-nums text-white/60">
            {pageIndex + 1}
          </span>
          <input
            type="range"
            min={0}
            max={pageCount - 1}
            step={1}
            value={pageIndex}
            tabIndex={tabIndex}
            aria-label="Page"
            onChange={(event) => onSeekPage(Number(event.target.value))}
            className="h-11 flex-1 accent-white"
            style={{ direction: direction === "rtl" ? "rtl" : "ltr" }}
          />
          <span className="w-8 shrink-0 text-xs tabular-nums text-white/60">{pageCount}</span>
        </div>
      ) : null}

      <div className="flex h-16 items-center gap-1 px-1">
        <button
          type="button"
          onClick={onPrevChapter}
          disabled={!hasPrevChapter}
          tabIndex={tabIndex}
          aria-label="Previous chapter"
          className="focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-white/80 hover:text-white disabled:opacity-30"
        >
          <ChevronLeft className="h-6 w-6" aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={onOpenChapters}
          tabIndex={tabIndex}
          className="focus-ring flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium text-white/90 hover:bg-white/10"
        >
          <List className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{chapterLabel || "Chapters"}</span>
        </button>

        <button
          type="button"
          onClick={onNextChapter}
          disabled={!hasNextChapter}
          tabIndex={tabIndex}
          aria-label="Next chapter"
          className="focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-white/80 hover:text-white disabled:opacity-30"
        >
          <ChevronRight className="h-6 w-6" aria-hidden="true" />
        </button>
      </div>
    </footer>
  );
}
