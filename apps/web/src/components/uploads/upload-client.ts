/**
 * Chunked, resumable upload client (plain TS, no React — the hook wrapper
 * is `src/hooks/use-upload.ts`).
 *
 * Protocol (per `src/lib/contracts/content.ts`):
 *   1. `POST /api/uploads` — create a session for `{ filename, size, mime }`,
 *      gets back `UploadSessionView` (`chunkSize`, `chunkCount`,
 *      `receivedChunks`).
 *   2. `PUT /api/uploads/:id/chunks/:index` for every chunk not already in
 *      `receivedChunks`, `UPLOAD_PARALLEL_CHUNKS` at a time, each retried up
 *      to `UPLOAD_MAX_RETRIES` times with exponential backoff.
 *   3. `POST /api/uploads/:id/complete` once every chunk has landed.
 *
 * `apiFetch` (src/lib/api-client.ts) always JSON-encodes its body, so chunk
 * PUTs bypass it and use `fetch` directly with
 * `Content-Type: application/octet-stream` and `credentials: "same-origin"`,
 * per that file's own guidance. Session create/get/complete go through
 * `api.*` since those are plain JSON calls.
 *
 * "Resumable within the session": if `uploadFile()` is called again for the
 * same File (matched by name+size+lastModified) before a previous attempt's
 * session finished, the in-memory session from that attempt is reused —
 * refreshed via `GET /api/uploads/:id` so `receivedChunks` reflects the
 * server's truth (another tab, or chunks that landed despite a client-side
 * timeout) — instead of creating a new session and re-sending everything.
 * This cache is module-level and only lives for the page's lifetime; a hard
 * reload always starts a fresh session. (`GET /api/uploads/:id` isn't in
 * the explicit list of routes other agents are building alongside this UI —
 * it's assumed here as the natural REST counterpart to the other
 * `/api/uploads/:id...` routes; verify it exists before relying on resume
 * across a failed attempt.)
 */
import { api, ApiClientError } from "@/lib/api-client";
import { UPLOAD_CHUNK_SIZE, type UploadSessionView } from "@/lib/contracts/content";

export interface ChunkPlan {
  index: number;
  start: number;
  /** Exclusive. */
  end: number;
}

/** Pure: splits `size` bytes into `chunkSize`-sized (0-based, ascending) chunk ranges. */
export function planChunks(size: number, chunkSize: number = UPLOAD_CHUNK_SIZE): ChunkPlan[] {
  if (size <= 0 || chunkSize <= 0) return [];
  const count = Math.ceil(size / chunkSize);
  return Array.from({ length: count }, (_, index) => {
    const start = index * chunkSize;
    return { index, start, end: Math.min(size, start + chunkSize) };
  });
}

/** Pure: chunk indexes in `[0, chunkCount)` not yet present in `receivedChunks`, ascending. */
export function pendingChunkIndexes(
  chunkCount: number,
  receivedChunks: readonly number[],
): number[] {
  const received = new Set(receivedChunks);
  const pending: number[] = [];
  for (let i = 0; i < chunkCount; i++) {
    if (!received.has(i)) pending.push(i);
  }
  return pending;
}

export interface UploadProgress {
  sentBytes: number;
  totalBytes: number;
}

export interface UploadOptions {
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}

export const UPLOAD_MAX_RETRIES = 3;
export const UPLOAD_PARALLEL_CHUNKS = 2;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 4000;

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function defaultWait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/** Injectable dependencies, so `uploadFile` is testable without real timers or network. */
export interface UploadDeps {
  fetchImpl: typeof fetch;
  wait: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultDeps: UploadDeps = {
  fetchImpl: (input, init) => fetch(input, init),
  wait: defaultWait,
};

/** In-flight/failed sessions, keyed by file fingerprint — see module docs on resuming. */
const sessionCache = new Map<string, UploadSessionView>();

function fingerprint(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

async function putChunkWithRetry(
  sessionId: string,
  chunk: ChunkPlan,
  file: File,
  signal: AbortSignal | undefined,
  deps: UploadDeps,
): Promise<void> {
  const body = file.slice(chunk.start, chunk.end);
  let lastError: unknown;

  for (let attempt = 0; attempt < UPLOAD_MAX_RETRIES; attempt++) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    try {
      const response = await deps.fetchImpl(`/api/uploads/${sessionId}/chunks/${chunk.index}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/octet-stream" },
        body,
        signal,
      });
      // 409 = another attempt already landed this chunk; treat as success.
      if (response.ok || response.status === 409) return;
      throw new ApiClientError(
        response.status,
        `HTTP_${response.status}`,
        response.statusText || "Chunk upload failed",
      );
    } catch (err) {
      if (isAbortError(err)) throw err;
      lastError = err;
      if (attempt < UPLOAD_MAX_RETRIES - 1) {
        await deps.wait(Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** attempt), signal);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Chunk upload failed");
}

/**
 * Uploads every pending chunk of `session` through a small worker pool
 * (`UPLOAD_PARALLEL_CHUNKS` concurrent), reporting cumulative sent bytes via
 * `onProgress` (already-received bytes are reported immediately, before any
 * new chunk lands). Mutates `session.receivedChunks` as chunks land so a
 * caller that keeps a reference sees live progress.
 */
async function uploadPendingChunks(
  session: UploadSessionView,
  file: File,
  options: UploadOptions,
  deps: UploadDeps,
): Promise<void> {
  const plan = planChunks(session.size, session.chunkSize);
  const pending = pendingChunkIndexes(session.chunkCount, session.receivedChunks);
  const pendingSet = new Set(pending);
  const receivedBytes = plan
    .filter((chunk) => !pendingSet.has(chunk.index))
    .reduce((sum, chunk) => sum + (chunk.end - chunk.start), 0);

  let sentBytes = receivedBytes;
  options.onProgress?.({ sentBytes, totalBytes: session.size });
  if (pending.length === 0) return;

  const received = new Set(session.receivedChunks);
  const queue = [...pending];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const index = queue.shift();
      if (index === undefined) return;
      const chunk = plan[index];
      if (!chunk) continue;

      await putChunkWithRetry(session.id, chunk, file, options.signal, deps);

      received.add(index);
      session.receivedChunks = Array.from(received).sort((a, b) => a - b);
      sentBytes += chunk.end - chunk.start;
      options.onProgress?.({ sentBytes, totalBytes: session.size });
    }
  }

  const workerCount = Math.min(UPLOAD_PARALLEL_CHUNKS, pending.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
}

/**
 * Uploads one file end to end: create-or-resume session → chunk PUTs →
 * complete. See module docs for the resume behaviour and the `deps`
 * parameter (test-only; production callers should omit it).
 */
export async function uploadFile(
  file: File,
  options: UploadOptions = {},
  deps: UploadDeps = defaultDeps,
): Promise<UploadSessionView> {
  const key = fingerprint(file);
  let session = sessionCache.get(key);

  if (session && !session.complete) {
    try {
      session = await api.get<UploadSessionView>(`/api/uploads/${session.id}`, {
        signal: options.signal,
      });
    } catch {
      // Session likely expired or was never found server-side; start fresh.
      session = undefined;
    }
  }

  if (!session) {
    session = await api.post<UploadSessionView>(
      "/api/uploads",
      { filename: file.name, size: file.size, mime: file.type || undefined },
      { signal: options.signal },
    );
  }
  sessionCache.set(key, session);

  if (!session.complete) {
    await uploadPendingChunks(session, file, options, deps);
    session = await api.post<UploadSessionView>(`/api/uploads/${session.id}/complete`, undefined, {
      signal: options.signal,
    });
  }

  sessionCache.delete(key);
  return session;
}

/** Test-only: clears the module-level resume cache between test cases. */
export function clearUploadSessionCache(): void {
  sessionCache.clear();
}
