"use client";

/**
 * Series detail + create/edit/delete hooks. Library-entry mutations
 * (status/chapter/rating/notes/favorite, and "stop tracking") live in
 * `src/hooks/use-entry.ts` — this file only owns the series record itself.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api, type ApiClientError } from "@/lib/api-client";
import type {
  CreateSeriesInput,
  MalSearchResponse,
  SeriesDetail,
  UpdateSeriesInput,
} from "@/lib/contracts";
import { queryKeys } from "@/lib/query-keys";

/** GET /api/series/:id */
export function useSeries(id: string): UseQueryResult<SeriesDetail, ApiClientError> {
  return useQuery<SeriesDetail, ApiClientError>({
    queryKey: queryKeys.series(id),
    queryFn: () => api.get<SeriesDetail>(`/api/series/${id}`),
  });
}

/** GET /api/search/mal?q= — the caller debounces `q`; enabled once it's 2+ chars. */
export function useMalSearch(q: string): UseQueryResult<MalSearchResponse, ApiClientError> {
  const query = q.trim();
  return useQuery<MalSearchResponse, ApiClientError>({
    queryKey: queryKeys.malSearch(query),
    queryFn: () => api.get<MalSearchResponse>("/api/search/mal", { query: { q: query } }),
    enabled: query.length >= 2,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

/**
 * POST /api/series. On success, seeds the detail cache and navigates to the
 * new series. On a 409 CONFLICT the mutation rejects normally — read
 * `getExistingSeriesId(createSeries.error)` (see
 * `src/components/series/series-form-utils.ts`) to drive the "already in
 * the library" card.
 */
export function useCreateSeries(): UseMutationResult<
  SeriesDetail,
  ApiClientError,
  CreateSeriesInput
> {
  const queryClient = useQueryClient();
  const router = useRouter();
  return useMutation<SeriesDetail, ApiClientError, CreateSeriesInput>({
    mutationFn: (input) => api.post<SeriesDetail>("/api/series", input),
    onSuccess: (series) => {
      queryClient.setQueryData(queryKeys.series(series.id), series);
      void queryClient.invalidateQueries({ queryKey: queryKeys.libraryAll });
      router.push(`/series/${series.id}`);
    },
  });
}

/** PATCH /api/series/:id, optimistically patching the detail cache. */
export function useUpdateSeries(
  id: string,
): UseMutationResult<SeriesDetail, ApiClientError, UpdateSeriesInput, { previous?: SeriesDetail }> {
  const queryClient = useQueryClient();
  return useMutation<SeriesDetail, ApiClientError, UpdateSeriesInput, { previous?: SeriesDetail }>({
    mutationFn: (input) => api.patch<SeriesDetail>(`/api/series/${id}`, input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.series(id) });
      const previous = queryClient.getQueryData<SeriesDetail>(queryKeys.series(id));
      if (previous) {
        // Only patch fields that mean the same thing on SeriesDetail as they
        // do on UpdateSeriesInput — `coverUrl` (source URL to fetch) and
        // `removeCover` have no 1:1 counterpart, so they're left for the
        // refetch in onSettled instead of guessed at optimistically.
        queryClient.setQueryData<SeriesDetail>(queryKeys.series(id), {
          ...previous,
          ...(input.title !== undefined && { title: input.title }),
          ...(input.originalTitle !== undefined && { originalTitle: input.originalTitle ?? null }),
          ...(input.synopsis !== undefined && { synopsis: input.synopsis ?? null }),
          ...(input.mediaType !== undefined && { mediaType: input.mediaType }),
          ...(input.visibility !== undefined && { visibility: input.visibility }),
          ...(input.isAdult !== undefined && { isAdult: input.isAdult }),
          ...(input.publicationYear !== undefined && {
            publicationYear: input.publicationYear ?? null,
          }),
          ...(input.totalChapters !== undefined && { totalChapters: input.totalChapters ?? null }),
          ...(input.totalVolumes !== undefined && { totalVolumes: input.totalVolumes ?? null }),
          ...(input.tags !== undefined && { tags: input.tags }),
          ...(input.sourceUrl !== undefined && { sourceUrl: input.sourceUrl ?? null }),
          ...(input.malId !== undefined && { malId: input.malId ?? null }),
          ...(input.isBookClub !== undefined && { isBookClub: input.isBookClub }),
        });
      }
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.series(id), context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.series(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.libraryAll });
    },
  });
}

/** DELETE /api/series/:id — deletes the series (and everyone's progress) entirely. */
export function useDeleteSeries(id: string): UseMutationResult<void, ApiClientError, void> {
  const queryClient = useQueryClient();
  const router = useRouter();
  return useMutation<void, ApiClientError, void>({
    mutationFn: () => api.delete<void>(`/api/series/${id}`),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: queryKeys.series(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.libraryAll });
      router.push("/");
    },
  });
}
