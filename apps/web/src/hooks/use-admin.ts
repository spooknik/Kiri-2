"use client";

/**
 * Admin-area data hooks: users, invites, instance settings, audit log.
 *
 * Route paths (`/api/admin/users`, `/api/admin/users/:id`,
 * `/api/admin/invites`, `/api/admin/invites/:id`, `/api/admin/settings`,
 * `/api/admin/audit`) are assumed REST conventions over the
 * `src/lib/contracts/admin.ts` types — the routes themselves are being built
 * by another agent in parallel and did not exist at the time these hooks were
 * written. See the phase report for what could/couldn't be verified live.
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
import type {
  AdminUserView,
  AppSettingsView,
  AuditPage,
  CreateInviteInput,
  InviteView,
  UpdateSettingsInput,
  UpdateUserInput,
} from "@/lib/contracts";
import { queryKeys } from "@/lib/query-keys";

// Users -----------------------------------------------------------------------

export function useAdminUsers(): UseQueryResult<AdminUserView[], ApiClientError> {
  return useQuery<AdminUserView[], ApiClientError>({
    queryKey: queryKeys.admin.users,
    queryFn: () => api.get<AdminUserView[]>("/api/admin/users"),
  });
}

export type UpdateAdminUserVariables = { id: string; input: UpdateUserInput };

export function useUpdateAdminUser(): UseMutationResult<
  AdminUserView,
  ApiClientError,
  UpdateAdminUserVariables
> {
  const queryClient = useQueryClient();

  return useMutation<AdminUserView, ApiClientError, UpdateAdminUserVariables>({
    mutationFn: ({ id, input }) => api.patch<AdminUserView>(`/api/admin/users/${id}`, input),
    onSuccess: (data) => {
      queryClient.setQueryData<AdminUserView[]>(queryKeys.admin.users, (current) =>
        current ? current.map((user) => (user.id === data.id ? data : user)) : current,
      );
    },
  });
}

// Invites ---------------------------------------------------------------------

export function useAdminInvites(): UseQueryResult<InviteView[], ApiClientError> {
  return useQuery<InviteView[], ApiClientError>({
    queryKey: queryKeys.admin.invites,
    queryFn: () => api.get<InviteView[]>("/api/admin/invites"),
  });
}

export function useCreateInvite(): UseMutationResult<
  InviteView,
  ApiClientError,
  CreateInviteInput
> {
  const queryClient = useQueryClient();

  return useMutation<InviteView, ApiClientError, CreateInviteInput>({
    mutationFn: (input) => api.post<InviteView>("/api/admin/invites", input),
    onSuccess: (data) => {
      queryClient.setQueryData<InviteView[]>(queryKeys.admin.invites, (current) =>
        current ? [data, ...current] : [data],
      );
    },
  });
}

/** DELETE /api/admin/invites/:id — only valid for PENDING invites. */
export function useRevokeInvite(): UseMutationResult<void, ApiClientError, string> {
  const queryClient = useQueryClient();

  return useMutation<void, ApiClientError, string>({
    mutationFn: (id) => api.delete<void>(`/api/admin/invites/${id}`),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.invites });
    },
  });
}

// Settings ----------------------------------------------------------------------

export function useAdminSettings(): UseQueryResult<AppSettingsView, ApiClientError> {
  return useQuery<AppSettingsView, ApiClientError>({
    queryKey: queryKeys.admin.settings,
    queryFn: () => api.get<AppSettingsView>("/api/admin/settings"),
  });
}

export function useUpdateAdminSettings(): UseMutationResult<
  AppSettingsView,
  ApiClientError,
  UpdateSettingsInput
> {
  const queryClient = useQueryClient();

  return useMutation<AppSettingsView, ApiClientError, UpdateSettingsInput>({
    mutationFn: (input) => api.patch<AppSettingsView>("/api/admin/settings", input),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.admin.settings, data);
    },
  });
}

// Audit -------------------------------------------------------------------------

export function useAdminAudit(): UseInfiniteQueryResult<InfiniteData<AuditPage>, ApiClientError> {
  return useInfiniteQuery<
    AuditPage,
    ApiClientError,
    InfiniteData<AuditPage>,
    typeof queryKeys.admin.audit,
    string | undefined
  >({
    queryKey: queryKeys.admin.audit,
    queryFn: ({ pageParam }) =>
      api.get<AuditPage>("/api/admin/audit", { query: { cursor: pageParam } }),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}
