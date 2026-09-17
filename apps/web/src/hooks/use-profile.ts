"use client";

/** The signed-in user's own profile: `GET`/`PATCH /api/profile`. */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { api, type ApiClientError } from "@/lib/api-client";
import type { ProfileView, UpdateProfileInput } from "@/lib/contracts";
import { queryKeys } from "@/lib/query-keys";

export function useProfile(): UseQueryResult<ProfileView, ApiClientError> {
  return useQuery<ProfileView, ApiClientError>({
    queryKey: queryKeys.profile,
    queryFn: () => api.get<ProfileView>("/api/profile"),
  });
}

export function useUpdateProfile(): UseMutationResult<
  ProfileView,
  ApiClientError,
  UpdateProfileInput
> {
  const queryClient = useQueryClient();

  return useMutation<ProfileView, ApiClientError, UpdateProfileInput>({
    mutationFn: (input) => api.patch<ProfileView>("/api/profile", input),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.profile, data);
    },
  });
}
