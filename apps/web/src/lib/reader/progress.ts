/**
 * Reading-progress persistence for the reader.
 *
 * Behaviour ported from Kiri v1 (`src/lib/progress-store.ts` plus the reader's
 * debounce/`pagehide` flush): every position change is coalesced per series on
 * a 600 ms debounce, and any pending write is flushed immediately when the
 * chapter changes or the page is being hidden (`pagehide`,
 * `visibilitychange` -> hidden). The unload flush uses `keepalive: true` so the
 * request survives the navigation.
 *
 * Failures are swallowed: losing a position is never worth an error dialog.
 * Subscribers registered with `subscribeProgressErrors` get told once per
 * failure so the reader can show a single "saved locally when you're back
 * online" toast.
 *
 * PHASE 5 SWAP POINT
 * ------------------
 * The whole network surface is the `ProgressTransport` interface. The offline
 * sync queue replaces it in one call at startup:
 *
 *   setProgressTransport({ savePosition, setChapterRead })
 *
 * Nothing else in the reader needs to change: the debounce, the flush triggers
 * and the call sites stay exactly as they are.
 */

/** A position to persist. `pageIndex` is 0-based, matching the API contract. */
export interface ProgressPosition {
  seriesId: string;
  chapterId: string | null;
  pageIndex: number;
}

export interface SaveOptions {
  /** Set for unload flushes so the browser keeps the request in flight. */
  keepalive?: boolean;
}

export interface ProgressTransport {
  /** PUT /api/series/:id/position. Rejects on any non-2xx or network error. */
  savePosition(position: ProgressPosition, options: SaveOptions): Promise<void>;
  /** PUT /api/chapters/:id/read. Rejects on any non-2xx or network error. */
  setChapterRead(chapterId: string, read: boolean): Promise<void>;
}

export const PROGRESS_DEBOUNCE_MS = 600;

async function put(path: string, body: unknown, options: SaveOptions): Promise<void> {
  const response = await fetch(path, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive: options.keepalive === true,
  });
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}`);
  }
}

/** Default transport: plain `fetch`, so `keepalive` is available on unload. */
export const httpProgressTransport: ProgressTransport = {
  savePosition({ seriesId, chapterId, pageIndex }, options) {
    return put(`/api/series/${seriesId}/position`, { chapterId, pageIndex }, options);
  },
  setChapterRead(chapterId, read) {
    return put(`/api/chapters/${chapterId}/read`, { read }, {});
  },
};

let currentTransport: ProgressTransport = httpProgressTransport;

/** Phase 5: point progress writes at the offline sync queue. */
export function setProgressTransport(transport: ProgressTransport): void {
  currentTransport = transport;
}

export function getProgressTransport(): ProgressTransport {
  return currentTransport;
}

/** Restores the HTTP transport (tests, and a Phase 5 teardown path). */
export function resetProgressTransport(): void {
  currentTransport = httpProgressTransport;
}

type ProgressErrorListener = (error: unknown, position: ProgressPosition) => void;

const errorListeners = new Set<ProgressErrorListener>();

/** Returns an unsubscribe function. */
export function subscribeProgressErrors(listener: ProgressErrorListener): () => void {
  errorListeners.add(listener);
  return () => {
    errorListeners.delete(listener);
  };
}

function emitProgressError(error: unknown, position: ProgressPosition): void {
  for (const listener of errorListeners) {
    try {
      listener(error, position);
    } catch {
      // A broken listener must not break progress saving.
    }
  }
}

export interface ProgressSaver {
  /** Queue a position; coalesced per series on the debounce window. */
  save(position: ProgressPosition): void;
  /** Send every pending position now. */
  flush(options?: SaveOptions): void;
  /** Drop pending positions and timers without sending. */
  cancel(): void;
  /** Number of series with a pending write (tests, diagnostics). */
  pendingCount(): number;
}

export interface CreateProgressSaverOptions {
  /** Defaults to the module transport, read at call time so swaps apply. */
  transport?: ProgressTransport;
  debounceMs?: number;
  onError?: ProgressErrorListener;
}

/**
 * Creates an isolated saver. The reader uses the module-level singleton below;
 * tests use this so they never share timers.
 */
export function createProgressSaver(options: CreateProgressSaverOptions = {}): ProgressSaver {
  const debounceMs = options.debounceMs ?? PROGRESS_DEBOUNCE_MS;
  const pending = new Map<string, ProgressPosition>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function transport(): ProgressTransport {
    return options.transport ?? getProgressTransport();
  }

  function report(error: unknown, position: ProgressPosition): void {
    if (options.onError) {
      options.onError(error, position);
      return;
    }
    emitProgressError(error, position);
  }

  function send(position: ProgressPosition, saveOptions: SaveOptions): void {
    void Promise.resolve()
      .then(() => transport().savePosition(position, saveOptions))
      .catch((error: unknown) => report(error, position));
  }

  function clearTimer(seriesId: string): void {
    const timer = timers.get(seriesId);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(seriesId);
    }
  }

  return {
    save(position) {
      pending.set(position.seriesId, position);
      clearTimer(position.seriesId);
      timers.set(
        position.seriesId,
        setTimeout(() => {
          timers.delete(position.seriesId);
          const latest = pending.get(position.seriesId);
          if (!latest) return;
          pending.delete(position.seriesId);
          send(latest, {});
        }, debounceMs),
      );
    },
    flush(saveOptions = {}) {
      for (const seriesId of [...timers.keys()]) {
        clearTimer(seriesId);
      }
      const positions = [...pending.values()];
      pending.clear();
      for (const position of positions) {
        send(position, saveOptions);
      }
    },
    cancel() {
      for (const seriesId of [...timers.keys()]) {
        clearTimer(seriesId);
      }
      pending.clear();
    },
    pendingCount() {
      return pending.size;
    },
  };
}

const defaultSaver = createProgressSaver();

/** Queue a position for the current user. Debounced per series; never throws. */
export function saveProgress(position: ProgressPosition): void {
  defaultSaver.save(position);
}

/** Flush pending positions immediately (chapter change, unload). */
export function flushProgress(options?: SaveOptions): void {
  defaultSaver.flush(options);
}

/** Marks a chapter read. Resolves to false when the write failed. */
export async function markChapterRead(chapterId: string, read = true): Promise<boolean> {
  try {
    await getProgressTransport().setChapterRead(chapterId, read);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wires the flush triggers. Returns a teardown that also performs a final
 * flush, so unmounting the reader persists the last position.
 */
export function installProgressFlushHandlers(): () => void {
  if (typeof window === "undefined") return () => {};

  const handlePageHide = () => flushProgress({ keepalive: true });
  const handleVisibility = () => {
    if (document.visibilityState === "hidden") flushProgress({ keepalive: true });
  };

  window.addEventListener("pagehide", handlePageHide);
  document.addEventListener("visibilitychange", handleVisibility);

  return () => {
    window.removeEventListener("pagehide", handlePageHide);
    document.removeEventListener("visibilitychange", handleVisibility);
    flushProgress({ keepalive: true });
  };
}
