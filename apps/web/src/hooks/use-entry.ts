"use client";

/**
 * Library-entry mutations shared by the library list and the series page.
 *
 * Both mutations patch every cached `queryKeys.libraryAll` infinite page and
 * `queryKeys.series(seriesId)` optimistically (on `mutate`), roll back on
 * error with a toast, and invalidate both on settle so the server's view
 * wins once the request finishes.
 */
import {
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useToast } from "@/components/ui";
import { api, type ApiClientError } from "@/lib/api-client";
import type {
  LibraryEntryView,
  LibraryPage,
  SeriesDetail,
  SeriesSummary,
  UpdateEntryInput,
} from "@/lib/contracts";
import { queryKeys } from "@/lib/query-keys";

/**
 * Merge a partial `UpdateEntryInput` onto the previous entry (or synthesize
 * a fresh one — matching the server's create-on-missing defaults for
 * `PUT /api/series/:id/entry` — when there wasn't one, e.g. the "Track"
 * button). Fields omitted from `input` (`undefined`) keep their previous
 * value; `rating`/`notes` may be explicitly cleared with `null`.
 */
function applyOptimisticEntry(
  previous: LibraryEntryView | null,
  input: UpdateEntryInput,
): LibraryEntryView {
  const now = new Date().toISOString();
  return {
    status: input.status ?? previous?.status ?? "PLAN_TO_READ",
    currentChapter: input.currentChapter ?? previous?.currentChapter ?? 0,
    rating: input.rating !== undefined ? input.rating : (previous?.rating ?? null),
    notes: input.notes !== undefined ? input.notes : (previous?.notes ?? null),
    favorite: input.favorite ?? previous?.favorite ?? false,
    joinedAt: previous?.joinedAt ?? now,
    updatedAt: now,
  };
}

type LibrarySnapshot = [QueryKey, InfiniteData<LibraryPage> | undefined][];

/** Applies `updater` to every series row matching `seriesId` across all cached library pages; returns a snapshot for rollback. */
function patchLibraryCaches(
  queryClient: QueryClient,
  seriesId: string,
  updater: (item: SeriesSummary) => SeriesSummary | null,
): LibrarySnapshot {
  const snapshot = queryClient.getQueriesData<InfiniteData<LibraryPage>>({
    queryKey: queryKeys.libraryAll,
  });

  for (const [queryKey, data] of snapshot) {
    if (!data) continue;
    queryClient.setQueryData<InfiniteData<LibraryPage>>(queryKey, {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        items: page.items.flatMap((item) => {
          if (item.id !== seriesId) return [item];
          const next = updater(item);
          return next ? [next] : [];
        }),
      })),
    });
  }

  return snapshot;
}

function restoreLibraryCaches(
  queryClient: QueryClient,
  snapshot: LibrarySnapshot | undefined,
): void {
  if (!snapshot) return;
  for (const [queryKey, data] of snapshot) {
    queryClient.setQueryData(queryKey, data);
  }
}

type EntryMutationContext = {
  previousLibrary: LibrarySnapshot;
  previousSeries: SeriesDetail | undefined;
};

/** PUT /api/series/:id/entry — creates the entry when missing. */
export function useUpdateEntry(
  seriesId: string,
): UseMutationResult<LibraryEntryView, ApiClientError, UpdateEntryInput> {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation<LibraryEntryView, ApiClientError, UpdateEntryInput, EntryMutationContext>({
    mutationFn: (input) => api.put<LibraryEntryView>(`/api/series/${seriesId}/entry`, input),
    onMutate: async (input) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: queryKeys.libraryAll }),
        queryClient.cancelQueries({ queryKey: queryKeys.series(seriesId) }),
      ]);

      const previousLibrary = patchLibraryCaches(queryClient, seriesId, (item) => ({
        ...item,
        entry: applyOptimisticEntry(item.entry, input),
      }));

      const previousSeries = queryClient.getQueryData<SeriesDetail>(queryKeys.series(seriesId));
      if (previousSeries) {
        queryClient.setQueryData<SeriesDetail>(queryKeys.series(seriesId), {
          ...previousSeries,
          entry: applyOptimisticEntry(previousSeries.entry, input),
        });
      }

      return { previousLibrary, previousSeries };
    },
    onError: (error, _input, context) => {
      restoreLibraryCaches(queryClient, context?.previousLibrary);
      if (context?.previousSeries) {
        queryClient.setQueryData(queryKeys.series(seriesId), context.previousSeries);
      }
      toast({
        title: error.isOffline ? "Couldn't save — you're offline" : "Couldn't save",
        description: error.isOffline ? undefined : error.message,
        tone: "danger",
      });
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.libraryAll }),
        queryClient.invalidateQueries({ queryKey: queryKeys.series(seriesId) }),
      ]);
    },
  });
}

/** DELETE /api/series/:id/entry — stop tracking (the series itself stays). */
export function useUntrackSeries(
  seriesId: string,
): UseMutationResult<void, ApiClientError, void, EntryMutationContext> {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation<void, ApiClientError, void, EntryMutationContext>({
    mutationFn: () => api.delete<void>(`/api/series/${seriesId}/entry`),
    onMutate: async () => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: queryKeys.libraryAll }),
        queryClient.cancelQueries({ queryKey: queryKeys.series(seriesId) }),
      ]);

      const previousLibrary = patchLibraryCaches(queryClient, seriesId, () => null);

      const previousSeries = queryClient.getQueryData<SeriesDetail>(queryKeys.series(seriesId));
      if (previousSeries) {
        queryClient.setQueryData<SeriesDetail>(queryKeys.series(seriesId), {
          ...previousSeries,
          entry: null,
        });
      }

      return { previousLibrary, previousSeries };
    },
    onError: (error, _input, context) => {
      restoreLibraryCaches(queryClient, context?.previousLibrary);
      if (context?.previousSeries) {
        queryClient.setQueryData(queryKeys.series(seriesId), context.previousSeries);
      }
      toast({
        title: error.isOffline ? "Couldn't save — you're offline" : "Couldn't remove",
        description: error.isOffline ? undefined : error.message,
        tone: "danger",
      });
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.libraryAll }),
        queryClient.invalidateQueries({ queryKey: queryKeys.series(seriesId) }),
      ]);
    },
  });
}
