"use client";

/**
 * Per-series content-source hooks backing `SourceSection`: fetch/configure/
 * update/unbind the source, manage the series-level cookie credential, and
 * request a sync/verify job.
 *
 * Route paths (`/api/series/:id/source*`) follow
 * `src/lib/contracts/plugins.ts` — the routes themselves are being built by
 * another agent in parallel and did not exist at the time these hooks were
 * written. See the phase report for what could/couldn't be verified live.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { z } from "zod";
import { api, type ApiClientError } from "@/lib/api-client";
import { contentQueryKeys } from "@/lib/content-query-keys";
import type { EnqueuedJobResponse } from "@/lib/contracts/content";
import {
  configureSourceSchema,
  sourceCredentialSchema,
  syncSourceSchema,
  updateSourceSchema,
  type SourceView,
} from "@/lib/contracts/plugins";
import { pluginQueryKeys } from "@/lib/plugin-query-keys";

const SOURCE_ACTIVE_POLL_MS = 3_000;

export type ConfigureSourceInput = z.infer<typeof configureSourceSchema>;
export type UpdateSourceInput = z.infer<typeof updateSourceSchema>;
export type SourceCredentialInput = z.infer<typeof sourceCredentialSchema>;
export type SyncSourceInput = z.infer<typeof syncSourceSchema>;

/** GET /api/series/:id/source — refetches every 3s while a sync/verify job is active. */
export function useSource(seriesId: string): UseQueryResult<SourceView, ApiClientError> {
  return useQuery<SourceView, ApiClientError>({
    queryKey: pluginQueryKeys.source(seriesId),
    queryFn: () => api.get<SourceView>(`/api/series/${seriesId}/source`),
    enabled: Boolean(seriesId),
    refetchInterval: (query) => (query.state.data?.activeJobId ? SOURCE_ACTIVE_POLL_MS : false),
  });
}

/** PUT /api/series/:id/source — bind a URL (resolve + create/replace the source). */
export function useConfigureSource(
  seriesId: string,
): UseMutationResult<SourceView, ApiClientError, ConfigureSourceInput> {
  const queryClient = useQueryClient();
  return useMutation<SourceView, ApiClientError, ConfigureSourceInput>({
    mutationFn: (input) => api.put<SourceView>(`/api/series/${seriesId}/source`, input),
    onSuccess: (data) => {
      queryClient.setQueryData(pluginQueryKeys.source(seriesId), data);
      void queryClient.invalidateQueries({ queryKey: contentQueryKeys.jobsAll });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: pluginQueryKeys.source(seriesId) });
    },
  });
}

/** PATCH /api/series/:id/source — auto-sync mode/interval, plugin settings. */
export function useUpdateSource(
  seriesId: string,
): UseMutationResult<SourceView, ApiClientError, UpdateSourceInput> {
  const queryClient = useQueryClient();
  return useMutation<SourceView, ApiClientError, UpdateSourceInput>({
    mutationFn: (input) => api.patch<SourceView>(`/api/series/${seriesId}/source`, input),
    onSuccess: (data) => {
      queryClient.setQueryData(pluginQueryKeys.source(seriesId), data);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: pluginQueryKeys.source(seriesId) });
    },
  });
}

/** DELETE /api/series/:id/source — disconnect; downloaded chapters stay. */
export function useUnbindSource(seriesId: string): UseMutationResult<void, ApiClientError, void> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiClientError, void>({
    mutationFn: () => api.delete<void>(`/api/series/${seriesId}/source`),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: pluginQueryKeys.source(seriesId) });
    },
  });
}

/** PUT /api/series/:id/source/credential — paste a per-series cookie. */
export function useSetSourceCredential(
  seriesId: string,
): UseMutationResult<SourceView, ApiClientError, SourceCredentialInput> {
  const queryClient = useQueryClient();
  return useMutation<SourceView, ApiClientError, SourceCredentialInput>({
    mutationFn: (input) => api.put<SourceView>(`/api/series/${seriesId}/source/credential`, input),
    onSuccess: (data) => {
      queryClient.setQueryData(pluginQueryKeys.source(seriesId), data);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: pluginQueryKeys.source(seriesId) });
    },
  });
}

/** DELETE /api/series/:id/source/credential — remove the per-series cookie; returns the updated source. */
export function useClearSourceCredential(
  seriesId: string,
): UseMutationResult<SourceView, ApiClientError, void> {
  const queryClient = useQueryClient();
  return useMutation<SourceView, ApiClientError, void>({
    mutationFn: () => api.delete<SourceView>(`/api/series/${seriesId}/source/credential`),
    onSuccess: (data) => {
      queryClient.setQueryData(pluginQueryKeys.source(seriesId), data);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: pluginQueryKeys.source(seriesId) });
    },
  });
}

/** POST /api/series/:id/source/sync — enqueue a SOURCE_SYNC or SOURCE_VERIFY job. */
export function useRequestSync(
  seriesId: string,
): UseMutationResult<EnqueuedJobResponse, ApiClientError, SyncSourceInput> {
  const queryClient = useQueryClient();
  return useMutation<EnqueuedJobResponse, ApiClientError, SyncSourceInput>({
    mutationFn: (input) =>
      api.post<EnqueuedJobResponse>(`/api/series/${seriesId}/source/sync`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: pluginQueryKeys.source(seriesId) });
      void queryClient.invalidateQueries({ queryKey: contentQueryKeys.jobsAll });
    },
  });
}
