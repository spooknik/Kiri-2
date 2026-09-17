/**
 * IndexedDB persistence for the TanStack Query cache.
 *
 * This is what makes a cold, offline launch show a library instead of a
 * spinner: the last successful `library` / `series` / `chapters` /
 * `notifications` / reader responses are rehydrated before any fetch is
 * attempted, and the service worker's cached API responses then refresh them
 * when the network returns.
 *
 * `localStorage` was not an option — a library page of covers and chapter lists
 * blows past its 5 MB budget, and writing it synchronously on every query
 * settle janks the main thread. `idb-keyval` gives an async store in a handful
 * of bytes of code.
 *
 * Two guards worth knowing about:
 *   - the store is created lazily, inside the accessors, so importing this
 *     module during SSR never touches `indexedDB`;
 *   - `buster` is the app version, so a deploy that changes a response shape
 *     throws the old cache away instead of rendering it.
 */
import { createStore, del, get, set, type UseStore } from "idb-keyval";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type { Query } from "@tanstack/react-query";

const DB_NAME = "kiri-query-cache";
const STORE_NAME = "queries";

/** Seven days: long enough for a holiday without a connection. */
export const QUERY_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long an *unobserved* query stays in memory. The default (5 min) would
 * collect the library cache while the user is reading a chapter, and a
 * collected query is never written to disk — so the next cold launch would come
 * up empty. A day is plenty and keeps the in-memory cache bounded.
 */
export const QUERY_GC_TIME_MS = 24 * 60 * 60 * 1000;

/**
 * Query-key roots worth keeping on disk. Everything else (jobs, admin tables,
 * MAL search) is either useless offline or stale enough to mislead.
 *
 * `reader` is included on purpose: it is the one cache whose absence is
 * visible, because the reader mounts before the service worker can answer.
 */
export const PERSISTED_QUERY_ROOTS = new Set([
  "library",
  "series",
  "chapters",
  "notifications",
  "continue-reading",
  "reader",
]);

/** Pure: the dehydrate filter, so the allow-list is testable on its own. */
export function shouldPersistQueryKey(queryKey: readonly unknown[]): boolean {
  const root = queryKey[0];
  return typeof root === "string" && PERSISTED_QUERY_ROOTS.has(root);
}

export function shouldPersistQuery(query: Query): boolean {
  return query.state.status === "success" && shouldPersistQueryKey(query.queryKey);
}

let store: UseStore | null = null;

function getStore(): UseStore {
  store ??= createStore(DB_NAME, STORE_NAME);
  return store;
}

/** Structurally an `AsyncStorage<string>`; typed inline so this module does not
 * depend on `@tanstack/query-persist-client-core` (a transitive package). */
const idbStorage = {
  getItem: async (key: string): Promise<string | null> =>
    (await get<string>(key, getStore())) ?? null,
  setItem: async (key: string, value: string): Promise<void> => {
    await set(key, value, getStore());
  },
  removeItem: async (key: string): Promise<void> => {
    await del(key, getStore());
  },
};

/**
 * Built once per client (in `Providers`). Returns null on the server and in
 * browsers without IndexedDB, and `PersistQueryClientProvider` is then simply
 * not mounted.
 */
export function createQueryPersister() {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") return null;
  return createAsyncStoragePersister({
    storage: idbStorage,
    key: "kiri-query-cache",
    throttleTime: 1_000,
  });
}
