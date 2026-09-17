import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncOp } from "@/lib/contracts/offline";
import {
  backoffDelay,
  batchOps,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  coalesceKey,
  createSyncQueue,
  type QueuedOp,
  type SyncQueueStore,
} from "@/lib/offline/sync-queue";

/** In-memory stand-in for the IndexedDB store; same coalescing-by-key semantics. */
function memoryStore(): SyncQueueStore & { rows: Map<string, QueuedOp> } {
  const rows = new Map<string, QueuedOp>();
  return {
    rows,
    getAll: async () => [...rows.values()],
    put: async (record) => {
      rows.set(record.key, record);
    },
    deleteMany: async (keys) => {
      for (const key of keys) rows.delete(key);
    },
  };
}

function position(seriesId: string, pageIndex: number): SyncOp {
  return {
    type: "position",
    id: `op-${seriesId}-${pageIndex}`,
    seriesId,
    chapterId: "chapter-1",
    pageIndex,
    at: new Date(1_700_000_000_000 + pageIndex).toISOString(),
  };
}

function chapterRead(chapterId: string, read = true): SyncOp {
  return { type: "chapterRead", id: `read-${chapterId}-${read}`, chapterId, read, at: "now" };
}

function okResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ results: ids.map((id) => ({ id, ok: true })) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("coalesceKey", () => {
  it("collapses positions per series and read flags per chapter", () => {
    expect(coalesceKey(position("s1", 3))).toBe("position:s1");
    expect(coalesceKey(position("s1", 99))).toBe("position:s1");
    expect(coalesceKey(position("s2", 3))).toBe("position:s2");
    expect(coalesceKey(chapterRead("c1"))).toBe("chapterRead:c1");
    expect(coalesceKey(chapterRead("c1", false))).toBe("chapterRead:c1");
  });

  it("keys notes by note id, not op id", () => {
    const op: SyncOp = { type: "note", id: "op-1", noteId: "note-9", at: "now", note: {} };
    expect(coalesceKey(op)).toBe("note:note-9");
  });
});

describe("backoffDelay", () => {
  it("starts at the base delay and triples, capped", () => {
    expect(backoffDelay(0)).toBe(0);
    expect(backoffDelay(1)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelay(2)).toBe(BACKOFF_BASE_MS * 3);
    expect(backoffDelay(3)).toBe(BACKOFF_BASE_MS * 9);
    expect(backoffDelay(20)).toBe(BACKOFF_MAX_MS);
  });
});

describe("batchOps", () => {
  it("orders by seq and splits into batches", () => {
    const rows: QueuedOp[] = [3, 1, 2, 4, 5].map((seq) => ({
      key: `k${seq}`,
      seq,
      op: position(`s${seq}`, seq),
    }));
    const batches = batchOps(rows, 2);
    expect(batches).toHaveLength(3);
    expect(batches[0]?.map((row) => row.seq)).toEqual([1, 2]);
    expect(batches[2]?.map((row) => row.seq)).toEqual([5]);
  });
});

describe("createSyncQueue", () => {
  let store: ReturnType<typeof memoryStore>;
  let clock: number;

  beforeEach(() => {
    store = memoryStore();
    clock = 1_000_000;
  });

  const makeQueue = (fetchImpl: typeof fetch, batchSize = 50) =>
    createSyncQueue({
      store,
      fetchImpl,
      now: () => clock,
      batchSize,
      isOnline: () => true,
    });

  it("coalesces repeated positions for one series into a single row", async () => {
    const queue = makeQueue(vi.fn());
    for (let page = 0; page < 25; page += 1) {
      clock += 10;
      await queue.enqueue(position("series-1", page));
    }
    await queue.enqueue(position("series-2", 0));

    expect(store.rows.size).toBe(2);
    const kept = store.rows.get("position:series-1");
    expect(kept?.op).toMatchObject({ type: "position", pageIndex: 24 });
    expect(await queue.count()).toBe(2);
  });

  it("keeps ops in the order they were enqueued", async () => {
    const queue = makeQueue(vi.fn());
    await queue.enqueue(chapterRead("c1"));
    clock += 50;
    await queue.enqueue(position("s1", 5));

    const ordered = batchOps([...store.rows.values()]).flat();
    expect(ordered.map((row) => row.op.type)).toEqual(["chapterRead", "position"]);
  });

  it("posts in batches of the configured size and removes what the server accepted", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { ops: SyncOp[] };
      return okResponse(body.ops.map((op) => op.id));
    }) as unknown as typeof fetch;

    const queue = makeQueue(fetchImpl, 2);
    for (const seriesId of ["s1", "s2", "s3", "s4", "s5"]) {
      clock += 10;
      await queue.enqueue(position(seriesId, 1));
    }

    const result = await queue.flush();
    expect(result).toMatchObject({ applied: 5, failed: 0, skipped: false });
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(3);
    expect(store.rows.size).toBe(0);
    expect(queue.cachedCount()).toBe(0);
  });

  it("keeps ops and backs off when the network fails, then retries after the delay", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const queue = makeQueue(fetchImpl);
    await queue.enqueue(position("s1", 1));

    const first = await queue.flush();
    expect(first).toMatchObject({ applied: 0, skipped: false });
    expect(store.rows.size).toBe(1);

    // Immediately afterwards the queue refuses to try again.
    const second = await queue.flush();
    expect(second).toMatchObject({ skipped: true, reason: "backoff" });
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);

    // Once the backoff has elapsed it tries again.
    clock += BACKOFF_BASE_MS + 1;
    await queue.flush();
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(2);
  });

  it("drops ops the server rejected so one bad op cannot wedge the queue", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ results: [{ id: "op-s1-1", ok: false, error: "gone" }] }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;

    const queue = makeQueue(fetchImpl);
    await queue.enqueue(position("s1", 1));

    const result = await queue.flush();
    expect(result).toMatchObject({ applied: 0, failed: 1, skipped: false });
    expect(store.rows.size).toBe(0);
    // A rejection is not a network problem, so no backoff was armed.
    expect(await queue.flush()).toMatchObject({ skipped: true, reason: "empty" });
  });

  it("skips while offline and while another flush is running", async () => {
    const offlineQueue = createSyncQueue({
      store,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      now: () => clock,
      isOnline: () => false,
    });
    await offlineQueue.enqueue(position("s1", 1));
    expect(await offlineQueue.flush()).toMatchObject({ skipped: true, reason: "offline" });

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return okResponse(["op-s1-1"]);
    }) as unknown as typeof fetch;

    const queue = makeQueue(fetchImpl);
    const inFlight = queue.flush();
    const reentrant = await queue.flush();
    expect(reentrant).toMatchObject({ skipped: true, reason: "busy" });
    release?.();
    await inFlight;
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);
  });

  it("notifies subscribers when the pending count changes", async () => {
    const queue = makeQueue(vi.fn());
    const listener = vi.fn();
    const unsubscribe = queue.subscribe(listener);

    await queue.enqueue(position("s1", 1));
    expect(listener).toHaveBeenCalled();
    expect(queue.cachedCount()).toBe(1);

    unsubscribe();
    listener.mockClear();
    clock += 10;
    await queue.enqueue(position("s2", 1));
    expect(listener).not.toHaveBeenCalled();
  });
});
