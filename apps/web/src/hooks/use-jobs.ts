"use client";

/**
 * Background job hooks: the user-scoped job list/detail/cancel
 * (`/api/jobs*`) and the admin job dashboard (`/api/admin/jobs*`).
 *
 * Both list hooks poll fast (JOBS_ACTIVE_POLL_MS) while any fetched job is
 * QUEUED/RUNNING, and slow (JOBS_IDLE_POLL_MS) otherwise — mirroring
 * `useNotifications` (src/hooks/use-notifications.ts) — and only while the
 * tab is visible and the browser is online.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { api, type ApiClientError } from "@/lib/api-client";
import type { JobRunnerStatus, JobsPage, JobsQuery, JobView } from "@/lib/contracts/content";
import { contentQueryKeys } from "@/lib/content-query-keys";
import { useOnlineStatus } from "./use-online-status";

const JOBS_ACTIVE_POLL_MS = 3_000;
const JOBS_IDLE_POLL_MS = 30_000;

export type JobsFilter = Pick<JobsQuery, "seriesId" | "status" | "kind">;

function hasActiveJob(data: InfiniteData<JobsPage> | undefined): boolean {
  return (
    data?.pages.some((page) =>
      page.items.some((job) => job.status === "QUEUED" || job.status === "RUNNING"),
    ) ?? false
  );
}

function useJobsList(
  queryKey: readonly unknown[],
  path: string,
  filter: JobsFilter,
  isOnline: boolean,
): UseInfiniteQueryResult<InfiniteData<JobsPage>, ApiClientError> {
  return useInfiniteQuery<
    JobsPage,
    ApiClientError,
    InfiniteData<JobsPage>,
    readonly unknown[],
    string | undefined
  >({
    queryKey,
    queryFn: ({ pageParam }) =>
      api.get<JobsPage>(path, { query: { ...filter, cursor: pageParam } }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: (query) => {
      if (!isOnline) return false;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return false;
      const data = query.state.data as InfiniteData<JobsPage> | undefined;
      return hasActiveJob(data) ? JOBS_ACTIVE_POLL_MS : JOBS_IDLE_POLL_MS;
    },
    refetchIntervalInBackground: false,
  });
}

/** GET /api/jobs — own jobs + jobs on series the user can view. */
export function useJobs(
  filter: JobsFilter = {},
): UseInfiniteQueryResult<InfiniteData<JobsPage>, ApiClientError> {
  const isOnline = useOnlineStatus();
  return useJobsList(contentQueryKeys.jobs(filter), "/api/jobs", filter, isOnline);
}

/**
 * All non-terminal-ly-hidden jobs for one series — backs `JobStatusStrip`
 * (QUEUED/RUNNING with progress, FAILED shown until dismissed) and
 * `useChapters`' active-job polling.
 */
export function useSeriesJobs(
  seriesId: string,
): UseInfiniteQueryResult<InfiniteData<JobsPage>, ApiClientError> {
  return useJobs({ seriesId });
}

/** GET /api/jobs/:id */
export function useJob(id: string | null): UseQueryResult<JobView, ApiClientError> {
  return useQuery<JobView, ApiClientError>({
    queryKey: contentQueryKeys.job(id ?? ""),
    queryFn: () => api.get<JobView>(`/api/jobs/${id}`),
    enabled: Boolean(id),
  });
}

/** POST /api/jobs/:id/cancel */
export function useCancelJob(): UseMutationResult<JobView, ApiClientError, string> {
  const queryClient = useQueryClient();
  return useMutation<JobView, ApiClientError, string>({
    mutationFn: (id) => api.post<JobView>(`/api/jobs/${id}/cancel`),
    onSuccess: (job) => {
      queryClient.setQueryData(contentQueryKeys.job(job.id), job);
      void queryClient.invalidateQueries({ queryKey: contentQueryKeys.jobsAll });
      void queryClient.invalidateQueries({ queryKey: contentQueryKeys.adminJobsAll });
    },
  });
}

/** GET /api/admin/jobs — admin-only, sees every job on the instance. */
export function useAdminJobs(
  filter: JobsFilter = {},
): UseInfiniteQueryResult<InfiniteData<JobsPage>, ApiClientError> {
  const isOnline = useOnlineStatus();
  return useJobsList(contentQueryKeys.adminJobs(filter), "/api/admin/jobs", filter, isOnline);
}

/** GET /api/admin/jobs/status — runner health for the admin dashboard. */
export function useRunnerStatus(): UseQueryResult<JobRunnerStatus, ApiClientError> {
  const isOnline = useOnlineStatus();
  return useQuery<JobRunnerStatus, ApiClientError>({
    queryKey: contentQueryKeys.runnerStatus,
    queryFn: () => api.get<JobRunnerStatus>("/api/admin/jobs/status"),
    refetchInterval: () => {
      if (!isOnline) return false;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return false;
      return JOBS_ACTIVE_POLL_MS;
    },
    refetchIntervalInBackground: false,
  });
}
