"use client";

/**
 * Fetches the library dashboard (`GET /api/library`) as an infinite,
 * cursor-paginated TanStack Query. Filters come from `useLibraryFilters`
 * (`src/lib/library-filters.ts`); this hook just wires them to the query.
 */
import {
  keepPreviousData,
  useInfiniteQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from "@tanstack/react-query";
import { api, type ApiClientError } from "@/lib/api-client";
import type { LibraryPage, SeriesSummary } from "@/lib/contracts";
import type { LibraryFilters } from "@/lib/library-filters";
import { queryKeys } from "@/lib/query-keys";

const LIBRARY_STALE_TIME_MS = 30 * 1000;

export function useLibrary(
  filters: LibraryFilters,
): UseInfiniteQueryResult<InfiniteData<LibraryPage>, ApiClientError> {
  return useInfiniteQuery<
    LibraryPage,
    ApiClientError,
    InfiniteData<LibraryPage>,
    ReturnType<typeof queryKeys.library>,
    string | undefined
  >({
    queryKey: queryKeys.library(filters),
    queryFn: ({ pageParam }) =>
      api.get<LibraryPage>("/api/library", {
        query: { ...filters, cursor: pageParam },
      }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    staleTime: LIBRARY_STALE_TIME_MS,
  });
}

/** Flattens every fetched page's `items` into one ordered list. */
export function flattenLibraryPages(data: InfiniteData<LibraryPage> | undefined): SeriesSummary[] {
  return data ? data.pages.flatMap((page) => page.items) : [];
}
