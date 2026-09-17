"use client";

/**
 * Chapter-list + chapter mutation hooks for the series content-management
 * UI, series-level image optimization, and the cross-series "continue
 * reading" hook for the dashboard.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useToast } from "@/components/ui";
import { api, type ApiClientError } from "@/lib/api-client";
import type {
  ChapterDetail,
  ChapterListResponse,
  ContinueReadingResponse,
  EnqueuedJobResponse,
  UpdateChapterInput,
} from "@/lib/contracts/content";
import { contentQueryKeys } from "@/lib/content-query-keys";
import { useSeriesJobs } from "./use-jobs";

const CHAPTERS_STALE_TIME_MS = 30_000;
const CHAPTERS_ACTIVE_JOB_POLL_MS = 5_000;

/** GET /api/series/:id/chapters — polls every 5s while a job for this series is QUEUED/RUNNING. */
export function useChapters(seriesId: string): UseQueryResult<ChapterListResponse, ApiClientError> {
  const seriesJobs = useSeriesJobs(seriesId);
  const hasActiveJob =
    seriesJobs.data?.pages.some((page) =>
      page.items.some((job) => job.status === "QUEUED" || job.status === "RUNNING"),
    ) ?? false;

  return useQuery<ChapterListResponse, ApiClientError>({
    queryKey: contentQueryKeys.chapters(seriesId),
    queryFn: () => api.get<ChapterListResponse>(`/api/series/${seriesId}/chapters`),
    staleTime: CHAPTERS_STALE_TIME_MS,
    refetchInterval: hasActiveJob ? CHAPTERS_ACTIVE_JOB_POLL_MS : false,
  });
}

type SetChapterReadVariables = { chapterId: string; read: boolean };

/** PUT /api/chapters/:id/read — optimistic toggle in the chapters cache. */
export function useSetChapterRead(
  seriesId: string,
): UseMutationResult<
  void,
  ApiClientError,
  SetChapterReadVariables,
  { previous?: ChapterListResponse }
> {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation<
    void,
    ApiClientError,
    SetChapterReadVariables,
    { previous?: ChapterListResponse }
  >({
    mutationFn: ({ chapterId, read }) => api.put<void>(`/api/chapters/${chapterId}/read`, { read }),
    onMutate: async ({ chapterId, read }) => {
      await queryClient.cancelQueries({ queryKey: contentQueryKeys.chapters(seriesId) });
      const previous = queryClient.getQueryData<ChapterListResponse>(
        contentQueryKeys.chapters(seriesId),
      );
      if (previous) {
        let delta = 0;
        const chapters = previous.chapters.map((chapter) => {
          if (chapter.id !== chapterId || chapter.read === read) return chapter;
          delta += read ? 1 : -1;
          return { ...chapter, read, readAt: read ? new Date().toISOString() : null };
        });
        queryClient.setQueryData<ChapterListResponse>(contentQueryKeys.chapters(seriesId), {
          ...previous,
          chapters,
          readCount: Math.max(0, previous.readCount + delta),
        });
      }
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(contentQueryKeys.chapters(seriesId), context.previous);
      }
      toast({
        title: error.isOffline ? "Couldn't save — you're offline" : "Couldn't update chapter",
        description: error.isOffline ? undefined : error.message,
        tone: "danger",
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: contentQueryKeys.chapters(seriesId) });
    },
  });
}

type UpdateChapterVariables = { chapterId: string; input: UpdateChapterInput };

/** PATCH /api/chapters/:id */
export function useUpdateChapter(
  seriesId: string,
): UseMutationResult<ChapterDetail, ApiClientError, UpdateChapterVariables> {
  const queryClient = useQueryClient();

  return useMutation<ChapterDetail, ApiClientError, UpdateChapterVariables>({
    mutationFn: ({ chapterId, input }) =>
      api.patch<ChapterDetail>(`/api/chapters/${chapterId}`, input),
    onSuccess: (updated) => {
      queryClient.setQueryData<ChapterListResponse>(
        contentQueryKeys.chapters(seriesId),
        (current) => {
          if (!current) return current;
          return {
            ...current,
            chapters: current.chapters.map((chapter) =>
              chapter.id === updated.id
                ? {
                    ...chapter,
                    title: updated.title,
                    number: updated.number,
                    volume: updated.volume,
                  }
                : chapter,
            ),
          };
        },
      );
      void queryClient.invalidateQueries({ queryKey: contentQueryKeys.chapters(seriesId) });
    },
  });
}

/** DELETE /api/chapters/:id */
export function useDeleteChapter(
  seriesId: string,
): UseMutationResult<void, ApiClientError, string, { previous?: ChapterListResponse }> {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation<void, ApiClientError, string, { previous?: ChapterListResponse }>({
    mutationFn: (chapterId) => api.delete<void>(`/api/chapters/${chapterId}`),
    onMutate: async (chapterId) => {
      await queryClient.cancelQueries({ queryKey: contentQueryKeys.chapters(seriesId) });
      const previous = queryClient.getQueryData<ChapterListResponse>(
        contentQueryKeys.chapters(seriesId),
      );
      if (previous) {
        const removed = previous.chapters.find((chapter) => chapter.id === chapterId);
        const wasReadable = removed?.status === "COMPLETED" && (removed?.pageCount ?? 0) > 0;
        queryClient.setQueryData<ChapterListResponse>(contentQueryKeys.chapters(seriesId), {
          ...previous,
          chapters: previous.chapters.filter((chapter) => chapter.id !== chapterId),
          readCount: removed?.read ? Math.max(0, previous.readCount - 1) : previous.readCount,
          readableCount: wasReadable
            ? Math.max(0, previous.readableCount - 1)
            : previous.readableCount,
        });
      }
      return { previous };
    },
    onError: (error, _chapterId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(contentQueryKeys.chapters(seriesId), context.previous);
      }
      toast({
        title: error.isOffline ? "Couldn't delete — you're offline" : "Couldn't delete chapter",
        description: error.isOffline ? undefined : error.message,
        tone: "danger",
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: contentQueryKeys.chapters(seriesId) });
    },
  });
}

export type OptimizeSeriesInput = { chapterIds?: string[] };

/** POST /api/series/:id/optimize — enqueue an OPTIMIZE job for the series (or specific chapters). */
export function useOptimizeSeries(
  seriesId: string,
): UseMutationResult<EnqueuedJobResponse, ApiClientError, OptimizeSeriesInput | undefined> {
  const queryClient = useQueryClient();
  return useMutation<EnqueuedJobResponse, ApiClientError, OptimizeSeriesInput | undefined>({
    mutationFn: (input) =>
      api.post<EnqueuedJobResponse>(`/api/series/${seriesId}/optimize`, input ?? {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: contentQueryKeys.jobsAll });
    },
  });
}

/** GET /api/library/continue — recent reading positions across series, for the dashboard strip. */
export function useContinueReading(): UseQueryResult<ContinueReadingResponse, ApiClientError> {
  return useQuery<ContinueReadingResponse, ApiClientError>({
    queryKey: contentQueryKeys.continueReading,
    queryFn: () => api.get<ContinueReadingResponse>("/api/library/continue"),
    staleTime: CHAPTERS_STALE_TIME_MS,
  });
}
