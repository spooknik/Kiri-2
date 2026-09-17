"use client";

/**
 * Admin plugin-management hooks: list/install/enable-disable/uninstall
 * installed content-source plugins, the extension-token card, and URL
 * resolution (used by the series source section and the series form's
 * "recognised by" hint).
 *
 * Route paths (`/api/plugins`, `/api/plugins/:id`, `/api/plugins/resolve`,
 * `/api/admin/plugins/extension-token`) follow `src/lib/contracts/plugins.ts`
 * — the routes themselves are being built by another agent in parallel and
 * did not exist at the time these hooks were written. See the phase report
 * for what could/couldn't be verified live.
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
  updatePluginSchema,
  type ExtensionTokenResponse,
  type InstallPluginInput,
  type PluginView,
  type ResolveUrlResponse,
} from "@/lib/contracts/plugins";
import { pluginQueryKeys } from "@/lib/plugin-query-keys";

// The contract only exports the zod schema for PATCH /api/plugins/:id, not
// an inferred type — derive one locally rather than duplicating the shape.
export type UpdatePluginInput = z.infer<typeof updatePluginSchema>;

/** GET /api/plugins — any signed-in user; the route returns a bare `PluginView[]`. */
export function usePlugins(): UseQueryResult<PluginView[], ApiClientError> {
  return useQuery<PluginView[], ApiClientError>({
    queryKey: pluginQueryKeys.pluginsAll,
    queryFn: () => api.get<PluginView[]>("/api/plugins"),
  });
}

/** POST /api/plugins (admin) — starts a PLUGIN_INSTALL job; returns 202 { jobId }. */
export function useInstallPlugin(): UseMutationResult<
  EnqueuedJobResponse,
  ApiClientError,
  InstallPluginInput
> {
  const queryClient = useQueryClient();
  return useMutation<EnqueuedJobResponse, ApiClientError, InstallPluginInput>({
    mutationFn: (input) => api.post<EnqueuedJobResponse>("/api/plugins", input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: contentQueryKeys.jobsAll });
    },
  });
}

export type UpdatePluginVariables = { id: string; input: UpdatePluginInput };

/** PATCH /api/plugins/:id (admin) — enable/disable. */
export function useUpdatePlugin(): UseMutationResult<
  PluginView,
  ApiClientError,
  UpdatePluginVariables
> {
  const queryClient = useQueryClient();
  return useMutation<PluginView, ApiClientError, UpdatePluginVariables>({
    mutationFn: ({ id, input }) => api.patch<PluginView>(`/api/plugins/${id}`, input),
    onSuccess: (data) => {
      queryClient.setQueryData<PluginView[]>(pluginQueryKeys.pluginsAll, (current) =>
        current ? current.map((plugin) => (plugin.id === data.id ? data : plugin)) : current,
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: pluginQueryKeys.pluginsAll });
    },
  });
}

/** DELETE /api/plugins/:id (admin) */
export function useUninstallPlugin(): UseMutationResult<void, ApiClientError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiClientError, string>({
    mutationFn: (id) => api.delete<void>(`/api/plugins/${id}`),
    onSuccess: (_data, id) => {
      queryClient.setQueryData<PluginView[]>(pluginQueryKeys.pluginsAll, (current) =>
        current ? current.filter((plugin) => plugin.id !== id) : current,
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: pluginQueryKeys.pluginsAll });
    },
  });
}

/** GET /api/admin/plugins/extension-token (admin) */
export function useExtensionToken(): UseQueryResult<ExtensionTokenResponse, ApiClientError> {
  return useQuery<ExtensionTokenResponse, ApiClientError>({
    queryKey: pluginQueryKeys.extensionToken,
    queryFn: () => api.get<ExtensionTokenResponse>("/api/admin/plugins/extension-token"),
    // Derived from APP_SECRET; only changes if the server config changes.
    staleTime: 5 * 60_000,
  });
}

export type ResolveUrlVariables = { url: string };

/** POST /api/plugins/resolve — which plugin (if any) handles a URL. */
export function useResolveUrl(): UseMutationResult<
  ResolveUrlResponse,
  ApiClientError,
  ResolveUrlVariables
> {
  return useMutation<ResolveUrlResponse, ApiClientError, ResolveUrlVariables>({
    mutationFn: ({ url }) => api.post<ResolveUrlResponse>("/api/plugins/resolve", { url }),
  });
}
