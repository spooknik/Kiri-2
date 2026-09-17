"use client";

/**
 * Client-side filter state for the library dashboard: a subset of
 * `LibraryQuery` (everything except pagination — `cursor`/`limit`), derived
 * from the same zod schema so it can never drift from what `/api/library`
 * accepts.
 *
 * `useLibraryFilters` persists the whole object to localStorage
 * (`kiri.library.filters`) and reflects `q` in the `?q=` URL search param so
 * a search can be shared/bookmarked. Implemented as a `useSyncExternalStore`
 * (ported approach from Kiri v1's `library-list.tsx`) rather than
 * state+effect: it's SSR-safe via `getServerSnapshot` (always
 * `DEFAULT_LIBRARY_FILTERS` — localStorage/URL don't exist on the server),
 * picks up the real value synchronously on the client's first render (no
 * post-hydration flash), and reacts to same-tab writes and other tabs'
 * `storage` events without a manual `setState`-in-effect.
 */
import { useCallback, useSyncExternalStore } from "react";
import type { z } from "zod";
import { libraryQuerySchema } from "./contracts/library";

export const libraryFiltersSchema = libraryQuerySchema.pick({
  q: true,
  status: true,
  mediaType: true,
  tag: true,
  bookClub: true,
  scope: true,
  favorite: true,
  sort: true,
  order: true,
  adult: true,
});

export type LibraryFilters = z.infer<typeof libraryFiltersSchema>;

/** `(updater) => void`, matching `setState`'s functional-update form. */
export type SetLibraryFilters = (
  updater: LibraryFilters | ((prev: LibraryFilters) => LibraryFilters),
) => void;

export const DEFAULT_LIBRARY_FILTERS: LibraryFilters = libraryFiltersSchema.parse({});

const STORAGE_KEY = "kiri.library.filters";
const FILTERS_EVENT = "kiri:library-filters-change";

function parseFilters(raw: string | null): LibraryFilters {
  if (!raw) return DEFAULT_LIBRARY_FILTERS;
  try {
    const parsed = libraryFiltersSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_LIBRARY_FILTERS;
  } catch {
    return DEFAULT_LIBRARY_FILTERS;
  }
}

function readUrlQuery(): string | undefined {
  const value = new URLSearchParams(window.location.search).get("q");
  return value && value.trim() ? value : undefined;
}

// getSnapshot must return a stable (`Object.is`-equal) reference when
// nothing changed, or `useSyncExternalStore` re-renders in a loop. Cache the
// last raw localStorage string alongside the parsed+URL-merged result so
// repeat reads between actual writes return the same object.
let cachedRaw: string | null = null;
let cachedResult: LibraryFilters = DEFAULT_LIBRARY_FILTERS;

function getSnapshot(): LibraryFilters {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === cachedRaw) {
    return cachedResult;
  }
  cachedRaw = raw;
  const stored = parseFilters(raw);
  const urlQuery = readUrlQuery();
  cachedResult = urlQuery ? { ...stored, q: urlQuery } : stored;
  return cachedResult;
}

function getServerSnapshot(): LibraryFilters {
  return DEFAULT_LIBRARY_FILTERS;
}

function subscribe(onStoreChange: () => void): () => void {
  const handleChange = () => onStoreChange();
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) onStoreChange();
  };
  window.addEventListener(FILTERS_EVENT, handleChange);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(FILTERS_EVENT, handleChange);
    window.removeEventListener("storage", handleStorage);
  };
}

/** Persists `next`, reflects its `q` in the URL, and notifies subscribers. */
function writeFilters(next: LibraryFilters): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable (private mode, quota): filters still work for
    // this session, they just won't persist.
  }

  const url = new URL(window.location.href);
  if (next.q && next.q.trim()) {
    url.searchParams.set("q", next.q);
  } else {
    url.searchParams.delete("q");
  }
  const nextHref = `${url.pathname}${url.search}${url.hash}`;
  const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextHref !== currentHref) {
    window.history.replaceState(window.history.state, "", nextHref);
  }

  window.dispatchEvent(new Event(FILTERS_EVENT));
}

export type UseLibraryFiltersResult = {
  filters: LibraryFilters;
  setFilters: SetLibraryFilters;
  resetFilters: () => void;
};

export function useLibraryFilters(): UseLibraryFiltersResult {
  const filters = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setFilters = useCallback<SetLibraryFilters>((updater) => {
    const prev = getSnapshot();
    writeFilters(typeof updater === "function" ? updater(prev) : updater);
  }, []);

  const resetFilters = useCallback(() => {
    writeFilters(DEFAULT_LIBRARY_FILTERS);
  }, []);

  return { filters, setFilters, resetFilters };
}
