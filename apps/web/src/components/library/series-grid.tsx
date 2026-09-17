"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Button, Skeleton } from "@/components/ui";
import type { SeriesSummary } from "@/lib/contracts";
import { SeriesCard } from "./series-card";

export type SeriesGridProps = {
  items: SeriesSummary[];
  isInitialLoading: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  onLoadMore: () => void;
  selectable: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  /** Rendered instead of the grid once loading has finished with zero items. */
  emptyState: ReactNode;
};

const SKELETON_COUNT = 8;
const GRID_CLASSES = "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4";

function SkeletonGrid() {
  return (
    <div className={GRID_CLASSES} aria-hidden="true">
      {Array.from({ length: SKELETON_COUNT }, (_, index) => (
        <div key={index} className="flex flex-col gap-2">
          <Skeleton className="aspect-[2/3] w-full" />
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

/** The infinite-scrolling grid: skeletons on first load, an IntersectionObserver sentinel + "Load more" fallback at the bottom, or the caller's empty state. */
export function SeriesGrid({
  items,
  isInitialLoading,
  isFetchingNextPage,
  hasNextPage,
  onLoadMore,
  selectable,
  selectedIds,
  onToggleSelect,
  emptyState,
}: SeriesGridProps) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadMoreRef.current();
        }
      },
      { rootMargin: "400px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage]);

  if (isInitialLoading) {
    return <SkeletonGrid />;
  }

  if (items.length === 0) {
    return <>{emptyState}</>;
  }

  return (
    <>
      <div className={GRID_CLASSES}>
        {items.map((series) => (
          <SeriesCard
            key={series.id}
            series={series}
            selectable={selectable}
            selected={selectedIds.has(series.id)}
            onToggleSelect={onToggleSelect}
          />
        ))}
      </div>
      {hasNextPage ? (
        <div ref={sentinelRef} className="flex justify-center py-4">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={isFetchingNextPage}
            onClick={onLoadMore}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}
