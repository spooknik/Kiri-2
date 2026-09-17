"use client";

import type { MouseEvent } from "react";
import { Check, Users } from "lucide-react";
import { AppLink } from "@/components/shell/app-link";
import { Badge, Button, type BadgeTone } from "@/components/ui";
import { useUpdateEntry } from "@/hooks/use-entry";
import { cn } from "@/lib/cn";
import {
  MEDIA_TYPE_LABELS,
  READING_STATUS_LABELS,
  type ReadingStatus,
  type SeriesSummary,
} from "@/lib/contracts";
import { formatRelativeTime } from "@/lib/format";
import { CoverPlaceholder } from "./cover-placeholder";

const STATUS_TONE: Record<ReadingStatus, BadgeTone> = {
  READING: "primary",
  COMPLETED: "success",
  ON_HOLD: "warning",
  DROPPED: "danger",
  PLAN_TO_READ: "neutral",
};

function formatChapterNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export type SeriesCardProps = {
  series: SeriesSummary;
  /** Bulk-select mode: renders as a toggle button with a checkbox overlay instead of a link. */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
};

/**
 * One row of the library grid. Links to the series detail page; when not
 * tracked, shows a "Track" button, otherwise a "+1 chapter" quick action
 * that bumps `currentChapter` (and flips PLAN_TO_READ → READING).
 */
export function SeriesCard({
  series,
  selectable = false,
  selected = false,
  onToggleSelect,
}: SeriesCardProps) {
  const updateEntry = useUpdateEntry(series.id);
  const { entry } = series;
  const chapterTotal = series.chapterCount || series.totalChapters || null;

  function handleQuickAction(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (entry) {
      updateEntry.mutate({
        currentChapter: entry.currentChapter + 1,
        ...(entry.status === "PLAN_TO_READ" ? { status: "READING" as const } : {}),
      });
    } else {
      updateEntry.mutate({});
    }
  }

  const body = (
    <>
      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-md bg-surface-2">
        {series.coverUrl ? (
          // next/image optimization is disabled app-wide (`images.unoptimized`
          // in next.config.ts) — covers are already served/cached by our own
          // route and the service worker, so a plain <img> is equivalent.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={series.coverUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <CoverPlaceholder title={series.title} mediaType={series.mediaType} />
        )}
        {selectable ? (
          <>
            <span
              aria-hidden="true"
              className={cn(
                "absolute inset-0 transition-colors",
                selected ? "bg-primary/50" : "bg-black/10",
              )}
            />
            <span
              aria-hidden="true"
              className={cn(
                "absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-full border-2 shadow",
                selected
                  ? "border-primary bg-primary text-white"
                  : "border-white/90 bg-black/30 text-transparent",
              )}
            >
              <Check className="h-4 w-4" strokeWidth={3} aria-hidden="true" />
            </span>
          </>
        ) : null}
      </div>

      <div className="mt-2 flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1">
          <Badge tone="neutral">{MEDIA_TYPE_LABELS[series.mediaType]}</Badge>
          {entry ? (
            <Badge tone={STATUS_TONE[entry.status]}>{READING_STATUS_LABELS[entry.status]}</Badge>
          ) : null}
          {series.isBookClub ? <Badge tone="primary">Book club</Badge> : null}
          {series.visibility === "PRIVATE" ? <Badge tone="neutral">Private</Badge> : null}
          {series.isAdult ? <Badge tone="danger">18+</Badge> : null}
        </div>

        <p className="truncate text-sm font-semibold leading-tight text-foreground">
          {series.title}
        </p>
        {series.originalTitle ? (
          <p className="truncate text-xs text-muted">{series.originalTitle}</p>
        ) : null}

        <p className="text-xs tabular-nums text-muted">
          {entry
            ? `Ch. ${formatChapterNumber(entry.currentChapter)} / ${chapterTotal ?? "?"}`
            : chapterTotal
              ? `${chapterTotal} chapters`
              : null}
        </p>

        <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
          <span>{formatRelativeTime(series.updatedAt)}</span>
          {series.readerCount > 1 ? (
            <span className="inline-flex items-center gap-1">
              <Users className="h-3 w-3" aria-hidden="true" />
              {series.readerCount}
            </span>
          ) : null}
        </div>
      </div>
    </>
  );

  if (selectable) {
    return (
      <button
        type="button"
        onClick={() => onToggleSelect?.(series.id)}
        aria-pressed={selected}
        aria-label={`Select ${series.title}`}
        className={cn(
          "focus-ring min-h-11 rounded-lg border p-2 text-left transition-colors",
          selected
            ? "border-primary bg-primary/5"
            : "border-card-border bg-card hover:border-primary/30",
        )}
      >
        {body}
      </button>
    );
  }

  return (
    <AppLink
      href={`/series/${series.id}`}
      className="focus-ring block min-h-11 rounded-lg border border-card-border bg-card p-2 transition-colors hover:border-primary/30"
    >
      {body}
      <div className="mt-2">
        {entry ? (
          <Button
            type="button"
            size="md"
            variant="secondary"
            className="w-full"
            loading={updateEntry.isPending}
            onClick={handleQuickAction}
          >
            +1 chapter
          </Button>
        ) : (
          <Button
            type="button"
            size="md"
            variant="primary"
            className="w-full"
            loading={updateEntry.isPending}
            onClick={handleQuickAction}
          >
            Track
          </Button>
        )}
      </div>
    </AppLink>
  );
}
