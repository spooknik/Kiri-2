"use client";

/**
 * The placeholder a spoiler-gated note renders instead of its body.
 *
 * Purely presentational: it says *why* the note is hidden and offers one
 * action. The fetch that actually returns the body (`GET /api/notes/:id`
 * with `reveal=1`) belongs to the card that owns the note, so this component
 * stays trivial to test and can be dropped anywhere a body would go.
 */
import { EyeOff } from "lucide-react";
import { Spinner } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { HiddenReason } from "@/lib/notes/spoilers";

export interface SpoilerShieldProps {
  /** Why the note is hidden: the author flagged it, or you are not there yet. */
  reason: HiddenReason;
  /** True while the revealed body is being fetched. */
  revealing?: boolean;
  onReveal: () => void;
  className?: string;
}

const REASON_LABEL: Record<HiddenReason, string> = {
  spoiler: "Hidden — marked spoiler",
  progress: "Hidden — beyond your progress",
};

export function SpoilerShield({ reason, revealing, onReveal, className }: SpoilerShieldProps) {
  return (
    <button
      type="button"
      onClick={onReveal}
      disabled={revealing}
      data-testid="spoiler-shield"
      className={cn(
        "focus-ring flex w-full items-center gap-2 rounded-md border border-dashed border-card-border bg-surface-2 px-3 py-2 text-left text-sm text-muted hover:text-foreground disabled:cursor-wait",
        className,
      )}
    >
      <EyeOff className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{REASON_LABEL[reason]}</span>
      {revealing ? (
        <Spinner size="sm" />
      ) : (
        <span className="shrink-0 font-medium text-primary">Reveal</span>
      )}
    </button>
  );
}
