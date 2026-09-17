"use client";

/**
 * Notification list + unread-mutation hooks backing the bell/center.
 *
 * `useNotifications` polls `/api/notifications` every 10s, but only while the
 * tab is visible and the browser is online (`refetchIntervalInBackground` is
 * left false and the interval callback itself short-circuits when hidden or
 * offline, so a backgrounded/offline tab never fires the request at all).
 */
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { z } from "zod";
import { api, type ApiClientError } from "@/lib/api-client";
import type { markNotificationsSchema, NotificationsPage } from "@/lib/contracts";
import { queryKeys } from "@/lib/query-keys";
import { useOnlineStatus } from "./use-online-status";

const POLL_INTERVAL_MS = 10_000;

export type MarkNotificationsInput = z.infer<typeof markNotificationsSchema>;

export function useNotifications(): UseInfiniteQueryResult<
  InfiniteData<NotificationsPage>,
  ApiClientError
> {
  const isOnline = useOnlineStatus();

  return useInfiniteQuery<
    NotificationsPage,
    ApiClientError,
    InfiniteData<NotificationsPage>,
    typeof queryKeys.notifications,
    string | undefined
  >({
    queryKey: queryKeys.notifications,
    queryFn: ({ pageParam }) =>
      api.get<NotificationsPage>("/api/notifications", { query: { cursor: pageParam } }),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: () => {
      if (!isOnline) return false;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return false;
      return POLL_INTERVAL_MS;
    },
    refetchIntervalInBackground: false,
  });
}

/** Reads the current unread count out of an infinite notifications query. */
export function getUnreadCount(data: InfiniteData<NotificationsPage> | undefined): number {
  return data?.pages[0]?.unreadCount ?? 0;
}

type NotificationsCache = InfiniteData<NotificationsPage>;

/**
 * PATCH /api/notifications. Pass `{ ids: [...] }` to mark specific
 * notifications read, or `{}` to mark everything read. Optimistically flips
 * `readAt` and decrements `unreadCount` on the cached pages, rolling back on
 * error.
 */
export function useMarkNotificationsRead(): UseMutationResult<
  void,
  ApiClientError,
  MarkNotificationsInput,
  { previous?: NotificationsCache }
> {
  const queryClient = useQueryClient();

  return useMutation<
    void,
    ApiClientError,
    MarkNotificationsInput,
    { previous?: NotificationsCache }
  >({
    mutationFn: (input) => api.patch<void>("/api/notifications", input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.notifications });
      const previous = queryClient.getQueryData<NotificationsCache>(queryKeys.notifications);
      const ids = input.ids && input.ids.length > 0 ? new Set(input.ids) : null;
      const now = new Date().toISOString();

      queryClient.setQueryData<NotificationsCache>(queryKeys.notifications, (data) => {
        if (!data) return data;
        let decrement = 0;
        const pages = data.pages.map((page) => ({
          ...page,
          items: page.items.map((item) => {
            if (item.readAt) return item;
            if (ids && !ids.has(item.id)) return item;
            decrement += 1;
            return { ...item, readAt: now };
          }),
        }));
        return {
          ...data,
          pages: pages.map((page) => ({
            ...page,
            unreadCount: Math.max(0, page.unreadCount - decrement),
          })),
        };
      });

      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.notifications, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
    },
  });
}
