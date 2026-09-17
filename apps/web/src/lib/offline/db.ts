/**
 * The offline index: one IndexedDB database, three object stores.
 *
 *   `catalog`   — one row per downloaded series (what is offline, how far the
 *                 download got, how many bytes). Keyed by `seriesId`.
 *   `manifests` — the {@link OfflineManifest} subset that was actually
 *                 downloaded, so resume, reconcile and delete know the exact
 *                 page URLs. Keyed by `seriesId`.
 *   `ops`       — the sync queue: reading positions, chapter-read flags and
 *                 notes written while offline. Keyed by a *coalescing* key
 *                 (see `sync-queue.ts`), which is what collapses a hundred page
 *                 turns into one row.
 *
 * The bytes themselves live in CacheStorage (`cache-names.ts`), never here.
 *
 * Raw IndexedDB rather than a wrapper library: three stores in one database
 * cannot be expressed with `idb-keyval`'s one-store-per-database model, and one
 * database keeps the catalog and its manifests in the same version/upgrade
 * lifecycle. Ported from Kiri v1 (`src/lib/offline-db.ts`) with the store list
 * changed.
 *
 * Every accessor is a safe no-op when IndexedDB is unavailable (SSR, private
 * mode, a browser that refuses storage), so callers never feature-detect.
 */

const DB_NAME = "kiri-offline";
const DB_VERSION = 1;

export const STORE_CATALOG = "catalog";
export const STORE_MANIFESTS = "manifests";
export const STORE_OPS = "ops";

export type OfflineStoreName = typeof STORE_CATALOG | typeof STORE_MANIFESTS | typeof STORE_OPS;

/** Key paths, so a row's key always travels inside the row itself. */
const KEY_PATHS: Record<OfflineStoreName, string> = {
  [STORE_CATALOG]: "seriesId",
  [STORE_MANIFESTS]: "seriesId",
  [STORE_OPS]: "key",
};

export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const [name, keyPath] of Object.entries(KEY_PATHS)) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB upgrade blocked by another tab"));
  });

  // Never cache a rejected promise: a later call must be able to retry.
  dbPromise.catch(() => {
    dbPromise = null;
  });

  return dbPromise;
}

/**
 * Runs `fn` inside one transaction and resolves with the request result *after*
 * the transaction commits — the only way to know a write actually landed.
 */
async function withStore<T>(
  storeName: OfflineStoreName,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | null,
): Promise<T | undefined> {
  const db = await openDb();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    let result: T | undefined;
    const request = fn(tx.objectStore(storeName));
    if (request) {
      request.onsuccess = () => {
        result = request.result;
      };
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function idbGet<T>(store: OfflineStoreName, key: string): Promise<T | null> {
  if (!isIndexedDbAvailable()) return null;
  try {
    const value = await withStore<T | undefined>(store, "readonly", (s) => s.get(key));
    return value ?? null;
  } catch {
    return null;
  }
}

export async function idbGetAll<T>(store: OfflineStoreName): Promise<T[]> {
  if (!isIndexedDbAvailable()) return [];
  try {
    const value = await withStore<T[]>(store, "readonly", (s) => s.getAll());
    return value ?? [];
  } catch {
    return [];
  }
}

/** Resolves false when the write could not be made (quota, private mode). */
export async function idbPut(store: OfflineStoreName, value: unknown): Promise<boolean> {
  if (!isIndexedDbAvailable()) return false;
  try {
    await withStore<IDBValidKey>(store, "readwrite", (s) => s.put(value));
    return true;
  } catch {
    return false;
  }
}

export async function idbDelete(store: OfflineStoreName, key: string): Promise<void> {
  await idbDeleteMany(store, [key]);
}

/** One transaction for the whole batch: a flush removes up to 50 ops at once. */
export async function idbDeleteMany(store: OfflineStoreName, keys: string[]): Promise<void> {
  if (!isIndexedDbAvailable() || keys.length === 0) return;
  try {
    await withStore<undefined>(store, "readwrite", (s) => {
      for (const key of keys) s.delete(key);
      return null;
    });
  } catch {
    // Best effort: a failed delete only means the op is replayed, and every op
    // is idempotent by design.
  }
}

/** Test seam: drops the cached connection so a fresh `indexedDB` mock is used. */
export function resetOfflineDbForTests(): void {
  dbPromise = null;
}
