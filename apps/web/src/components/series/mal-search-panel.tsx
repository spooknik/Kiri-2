"use client";

import { Search } from "lucide-react";
import { AppLink } from "@/components/shell/app-link";
import { EmptyState, Input, Spinner } from "@/components/ui";
import { cn } from "@/lib/cn";
import { MEDIA_TYPE_LABELS } from "@/lib/contracts/series";
import type { MalSearchResult } from "@/lib/contracts/search";

export interface MalSearchPanelProps {
  query: string;
  onQueryChange: (query: string) => void;
  results: MalSearchResult[];
  isLoading: boolean;
  isError: boolean;
  selectedMalId: number | null;
  onSelect: (result: MalSearchResult) => void;
}

/** Search input + result list for the "Search MyAnimeList" add-series tab. */
export function MalSearchPanel({
  query,
  onQueryChange,
  results,
  isLoading,
  isError,
  selectedMalId,
  onSelect,
}: MalSearchPanelProps) {
  const trimmed = query.trim();

  return (
    <div className="flex flex-col gap-3">
      <Input
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search manga, manhwa, light novels…"
        aria-label="Search MyAnimeList"
      />

      {isLoading ? (
        <div className="flex items-center justify-center py-6">
          <Spinner label="Searching…" />
        </div>
      ) : null}

      {!isLoading && isError ? (
        <p className="text-sm text-danger">Search failed. Try again in a moment.</p>
      ) : null}

      {!isLoading && !isError && trimmed.length >= 2 && results.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No results"
          description="Try a different search, or switch to Manual."
        />
      ) : null}

      {!isLoading && results.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {results.map((result) => {
            const selected = selectedMalId === result.malId;
            return (
              <li key={result.malId}>
                <button
                  type="button"
                  onClick={() => onSelect(result)}
                  aria-pressed={selected}
                  className={cn(
                    "focus-ring flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                    selected
                      ? "border-primary bg-primary-light"
                      : "border-card-border bg-card hover:border-primary/40",
                  )}
                >
                  <span className="h-16 w-11 shrink-0 overflow-hidden rounded bg-surface-2">
                    {result.coverUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- arbitrary remote URL, unoptimized
                      <img src={result.coverUrl} alt="" className="h-full w-full object-cover" />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {result.title}
                      </span>
                      <span className="shrink-0 rounded-full bg-primary-light px-2 py-0.5 text-xs font-medium text-primary">
                        {MEDIA_TYPE_LABELS[result.mediaType]}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-xs text-muted">
                      {result.publicationYear ?? "—"}
                      {result.totalChapters ? ` · ${result.totalChapters} ch.` : ""}
                    </span>
                    {result.existingSeriesId ? (
                      <AppLink
                        href={`/series/${result.existingSeriesId}`}
                        onClick={(e) => e.stopPropagation()}
                        className="mt-1 inline-block text-xs text-primary hover:underline"
                      >
                        Already in library — open
                      </AppLink>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
