"use client";

/**
 * What you see after the last page: the next chapter if there is one, and a way
 * back to the series either way.
 *
 * In the strip it sits inline at the end of the scroll; in the paged modes the
 * shell renders it as an overlay when you turn past the last page.
 */
import { ArrowRight, BookCheck, Check } from "lucide-react";
import { Button } from "@/components/ui";
import type { ChapterRef } from "@/lib/contracts/content";
import { formatChapterLabel } from "@/lib/reader/chapters";

export interface ChapterEndCardProps {
  nextChapter: ChapterRef | null;
  onNextChapter: () => void;
  onMarkReadAndExit: () => void;
  /** Rendered as a full-screen overlay instead of inline (paged modes). */
  overlay?: boolean;
  onDismiss?: () => void;
}

export function ChapterEndCard({
  nextChapter,
  onNextChapter,
  onMarkReadAndExit,
  overlay = false,
  onDismiss,
}: ChapterEndCardProps) {
  const body = (
    <div className="mx-auto flex w-full max-w-sm flex-col items-center gap-3 rounded-lg border border-white/10 bg-black/70 p-6 text-center text-white backdrop-blur">
      {nextChapter ? (
        <>
          <p className="text-sm text-white/60">Next chapter</p>
          <p className="text-base font-semibold">{formatChapterLabel(nextChapter)}</p>
          <Button onClick={onNextChapter} className="w-full">
            Continue
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </>
      ) : (
        <>
          <BookCheck className="h-8 w-8 text-white/70" aria-hidden="true" />
          <p className="text-base font-semibold">You&apos;re caught up</p>
          <p className="text-sm text-white/60">No further chapters have been downloaded yet.</p>
        </>
      )}

      <Button
        variant="secondary"
        onClick={onMarkReadAndExit}
        className="w-full border-white/20 bg-white/10 text-white hover:bg-white/20"
      >
        <Check className="h-4 w-4" aria-hidden="true" />
        Mark as read &amp; back to series
      </Button>

      {overlay && onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="focus-ring mt-1 h-11 rounded-md px-3 text-sm text-white/60 hover:text-white"
        >
          Keep reading this chapter
        </button>
      ) : null}
    </div>
  );

  if (overlay) {
    return (
      <div
        data-testid="chapter-end-card"
        className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-4"
      >
        {body}
      </div>
    );
  }

  return (
    <div data-testid="chapter-end-card" className="px-4 py-10">
      {body}
    </div>
  );
}
