/**
 * The offline write path: an IndexedDB queue of `SyncOp`s replayed against
 * `POST /api/sync` whenever the network comes back.
 *
 * Design rules, all of them load-bearing:
 *
 *   - **Client-minted ids.** Every op carries a uuid the client generates, so
 *     the server can be idempotent and a double flush is harmless.
 *   - **Coalescing, not appending.** A row's IndexedDB key is a *coalescing
 *     key*: `position:<seriesId>`, `chapterRead:<chapterId>`, `note:<noteId>`.
 *     Turning a hundred pages therefore leaves exactly one row, and marking a
 *     chapter read twice leaves one. `seq` (a monotonic counter) preserves the
 *     order the user actually did things in, which is what the server replays.
 *   - **Never block.** `enqueue` and `flush` swallow every error. Losing a
 *     reading position is not worth an error dialog, and a failed flush simply
 *     backs off and tries again on the next trigger.
 *   - **Re-entrancy guard.** `online`, `visibilitychange` and the load trigger
 *     all fire at once on a phone waking up; only one flush runs.
 *
 * All IO is injected (`SyncQueueStore`, `fetchImpl`, `now`) so the coalescing,
 * batching and backoff rules are unit-testable without a browser.
 */
import type { SyncBatchResult, SyncOp } from "@/lib/contracts/offline";
import { idbDeleteMany, idbGetAll, idbPut, STORE_OPS } from "@/lib/offline/db";

/** The API accepts up to 200 ops; 50 keeps a single request small on mobile. */
export const SYNC_BATCH_SIZE = 50;
/** Backoff ladder after a failed flush: 5 s, 15 s, 45 s, capped at 5 min. */
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_FACTOR = 3;
export const BACKOFF_MAX_MS = 5 * 60_000;

export interface QueuedOp {
  /** Coalescing key; see {@link coalesceKey}. */
  key: string;
  /** Monotonic within a browser profile; defines replay order. */
  seq: number;
  op: SyncOp;
}

export interface SyncQueueStore {
  getAll(): Promise<QueuedOp[]>;
  put(record: QueuedOp): Promise<void>;
  deleteMany(keys: string[]): Promise<void>;
}

export interface FlushResult {
  /** Ops the server accepted and that were removed from the queue. */
  applied: number;
  /** Ops the server rejected or that never left the browser. */
  failed: number;
  /** True when the flush did not run (offline, already running, backing off). */
  skipped: boolean;
  reason?: "offline" | "busy" | "backoff" | "empty";
}

/**
 * The IndexedDB key an op collapses onto. Positions coalesce per series,
 * read-flags per chapter, notes per note. Pure.
 */
export function coalesceKey(op: SyncOp): string {
  switch (op.type) {
    case "position":
      return `position:${op.seriesId}`;
    case "chapterRead":
      return `chapterRead:${op.chapterId}`;
    case "note":
      return `note:${op.noteId}`;
  }
}

/** Backoff for the n-th consecutive failure (0-based). Pure. */
export function backoffDelay(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const raw = BACKOFF_BASE_MS * BACKOFF_FACTOR ** (consecutiveFailures - 1);
  return Math.min(BACKOFF_MAX_MS, raw);
}

/** Split into request-sized batches, oldest first. Pure. */
export function batchOps(ops: QueuedOp[], size = SYNC_BATCH_SIZE): QueuedOp[][] {
  const ordered = [...ops].sort((a, b) => a.seq - b.seq);
  const batches: QueuedOp[][] = [];
  for (let i = 0; i < ordered.length; i += size) {
    batches.push(ordered.slice(i, i + size));
  }
  return batches;
}

export interface SyncQueue {
  enqueue(op: SyncOp): Promise<void>;
  flush(): Promise<FlushResult>;
  /** Number of queued ops; also refreshes the cached count subscribers see. */
  count(): Promise<number>;
  /** Last known count without touching IndexedDB (for `useSyncExternalStore`). */
  cachedCount(): number;
  subscribe(listener: () => void): () => void;
  /** Test seam: clears the in-memory backoff/sequence state. */
  reset(): void;
}

export interface CreateSyncQueueOptions {
  store: SyncQueueStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  batchSize?: number;
  /** Defaults to `navigator.onLine`; tests override it. */
  isOnline?: () => boolean;
  endpoint?: string;
}

export function createSyncQueue(options: CreateSyncQueueOptions): SyncQueue {
  const {
    store,
    fetchImpl,
    now = () => Date.now(),
    batchSize = SYNC_BATCH_SIZE,
    isOnline = () => typeof navigator === "undefined" || navigator.onLine !== false,
    endpoint = "/api/sync",
  } = options;

  let seq = 0;
  let flushing = false;
  let failures = 0;
  let nextAttemptAt = 0;
  let cached = 0;
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A broken subscriber must not break the queue.
      }
    }
  }

  function setCount(value: number): void {
    if (cached === value) return;
    cached = value;
    emit();
  }

  async function refreshCount(): Promise<number> {
    const rows = await store.getAll();
    setCount(rows.length);
    return rows.length;
  }

  return {
    async enqueue(op) {
      // Wall clock keeps the order sensible across sessions; the max() keeps
      // it strictly increasing when two ops land in the same millisecond.
      seq = Math.max(seq + 1, now());
      try {
        await store.put({ key: coalesceKey(op), seq, op });
      } catch {
        // Storage refused the write (private mode, quota): the op is lost, and
        // that is strictly better than throwing into the reader's render path.
        return;
      }
      await refreshCount();
    },

    async flush() {
      if (flushing) return { applied: 0, failed: 0, skipped: true, reason: "busy" };
      if (!isOnline()) return { applied: 0, failed: 0, skipped: true, reason: "offline" };
      if (now() < nextAttemptAt) {
        return { applied: 0, failed: 0, skipped: true, reason: "backoff" };
      }

      flushing = true;
      let applied = 0;
      let failed = 0;
      // Only a dead network backs the queue off; ops the server *rejected* are
      // dropped and must not delay the next flush.
      let networkFailed = false;
      try {
        const rows = await store.getAll();
        if (rows.length === 0) {
          failures = 0;
          nextAttemptAt = 0;
          setCount(0);
          return { applied: 0, failed: 0, skipped: true, reason: "empty" };
        }

        const doFetch = fetchImpl ?? fetch;
        for (const batch of batchOps(rows, batchSize)) {
          let result: SyncBatchResult | null = null;
          try {
            const response = await doFetch(endpoint, {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json", Accept: "application/json" },
              body: JSON.stringify({ ops: batch.map((row) => row.op) }),
            });
            if (response.ok) {
              result = (await response.json()) as SyncBatchResult;
            }
          } catch {
            result = null;
          }

          if (!result) {
            // Network died mid-flush: stop, keep the rest, back off.
            failed += batch.length;
            networkFailed = true;
            break;
          }

          const okIds = new Set(
            result.results.filter((entry) => entry.ok).map((entry) => entry.id),
          );
          const doneKeys = batch.filter((row) => okIds.has(row.op.id)).map((row) => row.key);
          // A rejected op is dropped too: it is invalid (deleted series,
          // revoked access) and would otherwise wedge the queue forever.
          const rejectedKeys = batch.filter((row) => !okIds.has(row.op.id)).map((row) => row.key);
          await store.deleteMany([...doneKeys, ...rejectedKeys]);
          applied += doneKeys.length;
          failed += rejectedKeys.length;
        }

        if (networkFailed) {
          failures += 1;
          nextAttemptAt = now() + backoffDelay(failures);
        } else {
          failures = 0;
          nextAttemptAt = 0;
        }

        await refreshCount();
        return { applied, failed, skipped: false };
      } finally {
        flushing = false;
      }
    },

    count: refreshCount,
    cachedCount: () => cached,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      seq = 0;
      flushing = false;
      failures = 0;
      nextAttemptAt = 0;
      cached = 0;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The app's queue                                                            */
/* -------------------------------------------------------------------------- */

const indexedDbStore: SyncQueueStore = {
  getAll: () => idbGetAll<QueuedOp>(STORE_OPS),
  put: async (record) => {
    await idbPut(STORE_OPS, record);
  },
  deleteMany: (keys) => idbDeleteMany(STORE_OPS, keys),
};

export const syncQueue: SyncQueue = createSyncQueue({ store: indexedDbStore });

export function enqueueSyncOp(op: SyncOp): Promise<void> {
  return syncQueue.enqueue(op);
}

export function flushSyncQueue(): Promise<FlushResult> {
  return syncQueue.flush();
}

/** Fresh uuid for a client-minted op id. */
export function newOpId(): string {
  return crypto.randomUUID();
}
