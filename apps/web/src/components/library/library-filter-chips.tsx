"use client";

import { ArrowDown, ArrowUp, Crown, Heart } from "lucide-react";
import { Select } from "@/components/ui";
import {
  LIBRARY_SORTS,
  MEDIA_TYPES,
  MEDIA_TYPE_LABELS,
  READING_STATUSES,
  READING_STATUS_LABELS,
  type LibraryQuery,
  type LibrarySort,
  type MediaType,
  type ReadingStatus,
} from "@/lib/contracts";
import type { LibraryFilters, SetLibraryFilters } from "@/lib/library-filters";
import { FilterChip } from "./filter-chip";

const SORT_LABELS: Record<LibrarySort, string> = {
  updated: "Last updated",
  title: "Title",
  added: "Date added",
  lastChapter: "Last chapter",
  progress: "Progress",
};

const SCOPE_LABELS: Record<LibraryQuery["scope"], string> = {
  tracked: "Mine",
  created: "Created",
  all: "All",
};
const SCOPES = Object.keys(SCOPE_LABELS) as LibraryQuery["scope"][];

const ADULT_LABELS: Record<LibraryQuery["adult"], string> = {
  include: "Include 18+",
  exclude: "Exclude 18+",
  only: "18+ only",
};
const ADULT_OPTIONS = Object.keys(ADULT_LABELS) as LibraryQuery["adult"][];

export type LibraryFilterChipsProps = {
  filters: LibraryFilters;
  onFiltersChange: SetLibraryFilters;
  /** Unfiltered per-status counts of the user's own entries, from the latest page. */
  statusCounts?: Record<ReadingStatus, number>;
  /** Only rendered for users with `showAdult` — the server never shows adult content otherwise. */
  showAdultChips: boolean;
};

/** Status/scope/media-type/sort filter rows above the library grid. */
export function LibraryFilterChips({
  filters,
  onFiltersChange,
  statusCounts,
  showAdultChips,
}: LibraryFilterChipsProps) {
  function setStatus(status: ReadingStatus) {
    onFiltersChange((prev) => ({ ...prev, status: prev.status === status ? undefined : status }));
  }
  function setScope(scope: LibraryQuery["scope"]) {
    onFiltersChange((prev) => ({ ...prev, scope }));
  }
  function setAdult(adult: LibraryQuery["adult"]) {
    onFiltersChange((prev) => ({ ...prev, adult }));
  }
  function toggleBookClub() {
    onFiltersChange((prev) => ({ ...prev, bookClub: prev.bookClub === "1" ? undefined : "1" }));
  }
  function toggleFavorite() {
    onFiltersChange((prev) => ({ ...prev, favorite: prev.favorite === "1" ? undefined : "1" }));
  }
  function setMediaType(value: string) {
    onFiltersChange((prev) => ({ ...prev, mediaType: value ? (value as MediaType) : undefined }));
  }
  function setSort(value: LibrarySort) {
    onFiltersChange((prev) => ({ ...prev, sort: value }));
  }
  function toggleOrder() {
    onFiltersChange((prev) => ({ ...prev, order: prev.order === "asc" ? "desc" : "asc" }));
  }

  const total = READING_STATUSES.reduce((sum, status) => sum + (statusCounts?.[status] ?? 0), 0);

  return (
    <div className="flex flex-col gap-2">
      <div className="scrollbar-hide flex items-center gap-1.5 overflow-x-auto pb-1">
        <FilterChip
          selected={!filters.status}
          onClick={() => onFiltersChange((prev) => ({ ...prev, status: undefined }))}
        >
          All{statusCounts ? ` (${total})` : ""}
        </FilterChip>
        {READING_STATUSES.map((status) => (
          <FilterChip
            key={status}
            selected={filters.status === status}
            onClick={() => setStatus(status)}
          >
            {READING_STATUS_LABELS[status]}
            {statusCounts ? ` (${statusCounts[status]})` : ""}
          </FilterChip>
        ))}
      </div>

      <div className="scrollbar-hide flex items-center gap-1.5 overflow-x-auto pb-1">
        <FilterChip selected={filters.bookClub === "1"} onClick={toggleBookClub}>
          <Crown className="h-3.5 w-3.5" aria-hidden="true" />
          Book club
        </FilterChip>
        <FilterChip selected={filters.favorite === "1"} onClick={toggleFavorite}>
          <Heart className="h-3.5 w-3.5" aria-hidden="true" />
          Favorites
        </FilterChip>
        <span className="mx-1 h-4 w-px shrink-0 bg-card-border" aria-hidden="true" />
        {SCOPES.map((scope) => (
          <FilterChip
            key={scope}
            selected={filters.scope === scope}
            onClick={() => setScope(scope)}
          >
            {SCOPE_LABELS[scope]}
          </FilterChip>
        ))}
        {showAdultChips ? (
          <>
            <span className="mx-1 h-4 w-px shrink-0 bg-card-border" aria-hidden="true" />
            {ADULT_OPTIONS.map((adult) => (
              <FilterChip
                key={adult}
                selected={filters.adult === adult}
                onClick={() => setAdult(adult)}
              >
                {ADULT_LABELS[adult]}
              </FilterChip>
            ))}
          </>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Media type"
          value={filters.mediaType ?? ""}
          onChange={(event) => setMediaType(event.target.value)}
          className="h-9 w-auto min-w-0"
        >
          <option value="">All types</option>
          {MEDIA_TYPES.map((type) => (
            <option key={type} value={type}>
              {MEDIA_TYPE_LABELS[type]}
            </option>
          ))}
        </Select>

        <Select
          aria-label="Sort by"
          value={filters.sort}
          onChange={(event) => setSort(event.target.value as LibrarySort)}
          className="h-9 w-auto min-w-0"
        >
          {LIBRARY_SORTS.map((sort) => (
            <option key={sort} value={sort}>
              {SORT_LABELS[sort]}
            </option>
          ))}
        </Select>

        <button
          type="button"
          onClick={toggleOrder}
          aria-label={filters.order === "asc" ? "Sort ascending" : "Sort descending"}
          className="focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-card-border text-muted hover:text-foreground"
        >
          {filters.order === "asc" ? (
            <ArrowUp className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ArrowDown className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}
