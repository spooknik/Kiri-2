"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, type Query } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { ToastProvider } from "@/components/ui/toast";
import {
  createQueryPersister,
  QUERY_CACHE_MAX_AGE_MS,
  QUERY_GC_TIME_MS,
  shouldPersistQuery,
} from "@/lib/offline/query-persister";

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30 * 1000,
            retry: 1,
            refetchOnWindowFocus: true,
            // Rehydrated data is shown instantly, but it is a *snapshot* from
            // the last session and `staleTime` would otherwise suppress the
            // refetch for its whole window — so a full page load could render
            // half-minute-old data as if it were fresh. Always revalidating on
            // mount restores the pre-persistence guarantee (a navigation shows
            // current data) while keeping the offline win (something renders
            // immediately, and offline the service worker answers the refetch
            // from its own cache).
            refetchOnMount: "always",
            gcTime: QUERY_GC_TIME_MS,
          },
        },
      }),
  );

  // Null on the server and wherever IndexedDB is unavailable; the app then
  // renders with an ordinary, non-persisted client.
  const [persister] = useState(() => createQueryPersister());

  if (!persister) {
    return (
      <QueryClientProvider client={queryClient}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    );
  }

  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: QUERY_CACHE_MAX_AGE_MS,
        // A deploy that changes a response shape must not rehydrate the old one.
        buster: APP_VERSION,
        dehydrateOptions: {
          shouldDehydrateQuery: (query: Query) => shouldPersistQuery(query),
        },
      }}
    >
      <ToastProvider>{children}</ToastProvider>
    </PersistQueryClientProvider>
  );
}
