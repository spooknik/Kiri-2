"use client";

import { useEffect, useRef, useState } from "react";
import { BookOpen, SearchX, WifiOff } from "lucide-react";
import { Button, EmptyState } from "@/components/ui";
import { flattenLibraryPages, useLibrary } from "@/hooks/use-library";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { useLibraryFilters } from "@/lib/library-filters";
import { BulkActionBar } from "./bulk-action-bar";
import { ContinueReading } from "./continue-reading";
import { LibraryFilterChips } from "./library-filter-chips";
import { LibraryToolbar } from "./library-toolbar";
import { SeriesGrid } from "./series-grid";

const SEARCH_DEBOUNCE_MS = 300;

export type LibraryViewUser = {
  displayName: string;
  showAdult: boolean;
};

export type LibraryViewProps = {
  user: LibraryViewUser;
};

/** The `/` dashboard: sticky toolbar, filter chips, infinite series grid, and bulk-select mode. */
export function LibraryView({ user }: LibraryViewProps) {
  const { filters, setFilters, resetFilters } = useLibraryFilters();
  const query = useLibrary(filters);
  const isOnline = useOnlineStatus();

  // Debounced search: `searchInput` drives the input's visible value;
  // `filters.q` only updates 300ms after typing stops. The ref guards
  // against feedback loops between the two sync effects below.
  const [searchInput, setSearchInput] = useState(filters.q ?? "");
  const lastSyncedQuery = useRef(filters.q ?? "");

  useEffect(() => {
    if (lastSyncedQuery.current !== (filters.q ?? "")) {
      lastSyncedQuery.current = filters.q ?? "";
      setSearchInput(filters.q ?? "");
    }
  }, [filters.q]);

  useEffect(() => {
    const handle = setTimeout(() => {
      if (searchInput !== (filters.q ?? "")) {
        lastSyncedQuery.current = searchInput;
        setFilters((prev) => ({ ...prev, q: searchInput.trim() ? searchInput : undefined }));
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // Only re-run when the typed value changes; `filters.q`/`setFilters` are
    // read for comparison, not to drive this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  function toggleSelectMode() {
    setSelectMode((mode) => !mode);
    setSelectedIds(new Set());
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function clearFiltersAndSearch() {
    resetFilters();
    setSearchInput("");
  }

  const items = flattenLibraryPages(query.data);
  const firstPage = query.data?.pages[0];
  const statusCounts = firstPage?.statusCounts;
  const total = firstPage?.total ?? 0;

  const hasActiveFilters = Boolean(
    filters.q ||
    filters.status ||
    filters.mediaType ||
    filters.tag ||
    filters.bookClub ||
    filters.favorite ||
    filters.scope !== "tracked" ||
    filters.adult !== "include",
  );

  const showOfflineBanner = !isOnline || Boolean(query.isError && query.error?.isOffline);

  const emptyState = hasActiveFilters ? (
    <EmptyState
      icon={SearchX}
      title="No matches"
      description="Try a different search or clear your filters."
      action={
        <Button type="button" variant="secondary" size="sm" onClick={clearFiltersAndSearch}>
          Clear filters
        </Button>
      }
    />
  ) : (
    <EmptyState
      icon={BookOpen}
      title="Your library is empty"
      description={`Add a series to start tracking, ${user.displayName}.`}
      action={
        <Button href="/add" size="sm">
          Add a series
        </Button>
      }
    />
  );

  return (
    <div className="flex flex-col gap-3">
      <LibraryToolbar
        searchValue={searchInput}
        onSearchChange={setSearchInput}
        selectMode={selectMode}
        onToggleSelectMode={toggleSelectMode}
      />

      {showOfflineBanner ? (
        <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning-light px-3 py-2 text-xs text-warning">
          <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            You&rsquo;re offline{items.length > 0 ? " — showing your last synced library." : "."}
          </span>
        </div>
      ) : null}

      <LibraryFilterChips
        filters={filters}
        onFiltersChange={setFilters}
        statusCounts={statusCounts}
        showAdultChips={user.showAdult}
      />

      <div className="flex items-center justify-between text-xs text-muted">
        <span>{query.isLoading ? "Loading…" : `${total} series`}</span>
        {hasActiveFilters ? (
          <button
            type="button"
            onClick={clearFiltersAndSearch}
            className="text-primary hover:underline"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      <ContinueReading />

      <SeriesGrid
        items={items}
        isInitialLoading={query.isLoading}
        isFetchingNextPage={query.isFetchingNextPage}
        hasNextPage={Boolean(query.hasNextPage)}
        onLoadMore={() => {
          void query.fetchNextPage();
        }}
        selectable={selectMode}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelected}
        emptyState={emptyState}
      />

      {selectMode && selectedIds.size > 0 ? (
        <BulkActionBar
          selectedIds={[...selectedIds]}
          items={items.filter((item) => selectedIds.has(item.id))}
          onClear={() => setSelectedIds(new Set())}
          onApplied={() => setSelectedIds(new Set())}
        />
      ) : null}
    </div>
  );
}
