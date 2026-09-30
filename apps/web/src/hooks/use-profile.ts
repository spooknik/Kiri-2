"use client";

/** The signed-in user's own profile: `GET`/`PATCH /api/profile`. */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api, type ApiClientError } from "@/lib/api-client";
import { contentQueryKeys } from "@/lib/content-query-keys";
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
  const router = useRouter();

  return useMutation<ProfileView, ApiClientError, UpdateProfileInput>({
    mutationFn: (input) => api.patch<ProfileView>("/api/profile", input),
    onSuccess: (data, input) => {
      queryClient.setQueryData(queryKeys.profile, data);
      if (input.showAdult !== undefined) {
        // Adult filtering is server-side: refetch everything it shapes, and
        // re-render server components (the library's `showAdult` prop).
        void queryClient.invalidateQueries({ queryKey: queryKeys.libraryAll });
        void queryClient.invalidateQueries({ queryKey: contentQueryKeys.continueReading });
        router.refresh();
      }
    },
  });
}
