/**
 * `localStorage`-backed store for reader preferences, exposed as an external
 * store so components can read it with `useSyncExternalStore`.
 *
 * Reading storage during render would break hydration (the server has no
 * storage) and reading it in an effect would mean a setState cascade on every
 * mount. `useSyncExternalStore` is the sanctioned way out: the server and the
 * hydration pass see `EMPTY_STORED_PREFS`, the client swaps in the real value
 * immediately after, and a `storage` event keeps other tabs in step.
 */
import {
  EMPTY_STORED_PREFS,
  loadStoredPrefs,
  READER_PREFS_STORAGE_KEY,
  saveStoredPrefs,
  type StoredReaderPrefs,
} from "./prefs";

let cache: StoredReaderPrefs | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function handleStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== READER_PREFS_STORAGE_KEY) return;
  cache = loadStoredPrefs();
  emit();
}

export function subscribeReaderPrefs(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", handleStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorage);
    }
  };
}

/** Stable reference until something actually changes. */
export function getReaderPrefsSnapshot(): StoredReaderPrefs {
  cache ??= loadStoredPrefs();
  return cache;
}

export function getReaderPrefsServerSnapshot(): StoredReaderPrefs {
  return EMPTY_STORED_PREFS;
}

/** Applies `updater`, persists the result, and notifies subscribers. */
export function updateReaderPrefs(
  updater: (current: StoredReaderPrefs) => StoredReaderPrefs,
): void {
  const current = getReaderPrefsSnapshot();
  const next = updater(current);
  if (next === current) return;
  cache = next;
  saveStoredPrefs(next);
  emit();
}

/** Test hook: forget the in-memory copy so the next read hits storage again. */
export function resetReaderPrefsCache(): void {
  cache = null;
}
