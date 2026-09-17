"use client";

import { AppLink } from "@/components/shell/app-link";
import { Skeleton } from "@/components/ui";
import { useContinueReading } from "@/hooks/use-chapters";
import type { ChapterRef, ContinueReadingItem } from "@/lib/contracts/content";
import { formatRelativeTime } from "@/lib/format";
import { buildReadHref } from "@/lib/reader-url";

function hasChapter(
  item: ContinueReadingItem,
): item is ContinueReadingItem & { chapter: ChapterRef } {
  return item.chapter !== null;
}

/** Horizontal-scroll "continue reading" strip above the library grid; renders nothing when there's nothing to show. */
export function ContinueReading() {
  const { data, isPending, isError } = useContinueReading();

  if (isPending) {
    return (
      <div className="scrollbar-hide flex gap-3 overflow-x-auto pb-1">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-40 w-28 shrink-0" />
        ))}
      </div>
    );
  }

  if (isError || !data) {
    return null;
  }

  const items = data.items.filter(hasChapter);
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-foreground">Continue reading</h2>
      <div className="scrollbar-hide flex gap-3 overflow-x-auto pb-1">
        {items.map((item) => (
          <AppLink
            key={item.series.id}
            href={buildReadHref(item.series.id, item.chapter.id, item.pageIndex + 1)}
            className="focus-ring flex w-28 shrink-0 flex-col gap-1.5"
          >
            <div className="h-40 w-28 overflow-hidden rounded-lg border border-card-border bg-surface-2">
              {item.series.coverUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- served cover, unoptimized images
                <img src={item.series.coverUrl} alt="" className="h-full w-full object-cover" />
              ) : null}
            </div>
            <p className="truncate text-xs font-medium text-foreground">{item.series.title}</p>
            <p className="truncate text-[11px] text-muted">
              Ch. {item.chapter.number ?? item.chapter.title} · p. {item.pageIndex + 1}
            </p>
            <p className="text-[11px] text-muted">{formatRelativeTime(item.updatedAt)}</p>
          </AppLink>
        ))}
      </div>
    </div>
  );
}
