/**
 * Chunked upload sessions.
 *
 * A browser uploading a 700 MB CBZ through a reverse proxy with a body limit
 * cannot do it in one request, so uploads are split into fixed
 * `UPLOAD_CHUNK_SIZE` chunks that may arrive in any order and be retried
 * individually. A session is a directory under `DATA_ROOT/uploads/<id>/`:
 *
 *   session.json   immutable metadata + the `complete` flag
 *   chunk-<n>      one file per received chunk (0-based)
 *   file           the concatenated upload, written by completeUpload()
 *
 * Which chunks arrived is **derived from the directory listing**, never stored
 * in session.json — parallel chunk PUTs would otherwise race each other's
 * rewrites of that file and lose progress. session.json is written exactly
 * twice: at creation and at completion.
 *
 * Sessions are owned by one user and expire 24 h after creation; the retention
 * sweep removes the leftovers. Creating one reserves disk before a single byte
 * arrives, so a user may hold at most {@link MAX_LIVE_UPLOAD_SESSIONS} live
 * sessions declaring {@link MAX_UPLOAD_BYTES_PER_USER} in total — otherwise a
 * loop of `POST /api/uploads` fills the volume with empty directories and
 * promises.
 */
import { open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ApiError, badRequest, conflict, notFound } from "@/lib/api";
import { ensureDir, resolveInside } from "@/lib/content/store";
import {
  UPLOAD_CHUNK_SIZE,
  UPLOAD_MAX_BYTES,
  type CreateUploadInput,
  type UploadSessionView,
} from "@/lib/contracts/content";
import { uploadsDir, writeFileAtomic } from "@/lib/content/store";

/** How long an unfinished (or unconsumed) upload survives. */
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/** Live sessions one user may hold at once. */
export const MAX_LIVE_UPLOAD_SESSIONS = 10;
/** Bytes one user's live sessions may declare in total (8 GB). */
export const MAX_UPLOAD_BYTES_PER_USER = 8 * 1024 * 1024 * 1024;

const SESSION_FILE = "session.json";
const PAYLOAD_FILE = "file";
const CHUNK_PREFIX = "chunk-";

/** What `session.json` holds. Everything else is derived from the directory. */
export interface UploadSessionRecord {
  id: string;
  userId: string;
  filename: string;
  size: number;
  mime: string | null;
  chunkSize: number;
  chunkCount: number;
  complete: boolean;
  createdAt: string;
  expiresAt: string;
}

/** A finished upload handed to a job handler. */
export interface CompletedUpload {
  id: string;
  /** Absolute path of the assembled file. */
  path: string;
  filename: string;
  mime: string | null;
  size: number;
}

/* -------------------------------------------------------------------------- */
/* Paths and helpers                                                          */
/* -------------------------------------------------------------------------- */

function sessionDir(id: string): string {
  // `id` is a uuid from us, but it arrives through the URL: contain it anyway.
  return resolveInside(uploadsDir(), id);
}

function chunkPath(id: string, index: number): string {
  return resolveInside(sessionDir(id), `${CHUNK_PREFIX}${index}`);
}

function payloadPath(id: string): string {
  return resolveInside(sessionDir(id), PAYLOAD_FILE);
}

/** Control characters have no place in a stored filename. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Never let a client-supplied name become a path; keep the basename only. */
function safeFilename(raw: string): string {
  const flat = raw.replaceAll("\\", "/").replace(CONTROL_CHARS, "");
  const base = path.posix.basename(flat).trim();
  return base === "" || base === "." || base === ".." ? "upload" : base.slice(0, 255);
}

export function chunkCountFor(size: number, chunkSize: number = UPLOAD_CHUNK_SIZE): number {
  return Math.max(1, Math.ceil(size / chunkSize));
}

/** Bytes the chunk at `index` must contain, exactly. */
export function expectedChunkSize(record: UploadSessionRecord, index: number): number {
  const isLast = index === record.chunkCount - 1;
  return isLast ? record.size - index * record.chunkSize : record.chunkSize;
}

function isExpired(record: UploadSessionRecord): boolean {
  return Date.parse(record.expiresAt) <= Date.now();
}

async function readRecord(id: string): Promise<UploadSessionRecord | null> {
  try {
    const raw = await readFile(resolveInside(sessionDir(id), SESSION_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as UploadSessionRecord;
    if (typeof record.id !== "string" || typeof record.userId !== "string") return null;
    return record;
  } catch {
    return null;
  }
}

/** What the client should see as received: every chunk once complete. */
async function listChunkIndexes(record: UploadSessionRecord): Promise<number[]> {
  if (record.complete) return Array.from({ length: record.chunkCount }, (_, index) => index);
  return readReceivedChunks(record.id);
}

/** Chunk indexes present on disk, ascending. */
async function readReceivedChunks(id: string): Promise<number[]> {
  let entries: string[];
  try {
    entries = await readdir(sessionDir(id));
  } catch {
    return [];
  }
  const indexes: number[] = [];
  for (const name of entries) {
    if (!name.startsWith(CHUNK_PREFIX)) continue;
    const index = Number(name.slice(CHUNK_PREFIX.length));
    if (Number.isInteger(index) && index >= 0) indexes.push(index);
  }
  return indexes.sort((a, b) => a - b);
}

export function toUploadSessionView(
  record: UploadSessionRecord,
  receivedChunks: number[],
): UploadSessionView {
  return {
    id: record.id,
    filename: record.filename,
    size: record.size,
    mime: record.mime,
    chunkSize: record.chunkSize,
    chunkCount: record.chunkCount,
    receivedChunks,
    complete: record.complete,
    expiresAt: record.expiresAt,
  };
}

/**
 * Load a session the user owns. A session that belongs to someone else, has
 * expired, or never existed is reported identically as 404 — an upload id is
 * not a capability anyone else should be able to probe.
 */
async function requireOwned(userId: string, id: string): Promise<UploadSessionRecord> {
  const record = await readRecord(id);
  if (!record || record.userId !== userId) throw notFound("Upload");
  if (isExpired(record)) throw notFound("Upload");
  return record;
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

/** 409 — the per-user ceiling, not a problem with this request's contents. */
function uploadQuota(message: string): ApiError {
  return new ApiError(409, "UPLOAD_QUOTA", message);
}

/**
 * What this user currently holds: live (unexpired) sessions and the bytes they
 * declared. Derived from the directory, like everything else here, so a crashed
 * process or a hand-deleted session cannot leave a phantom reservation.
 */
async function usageFor(userId: string): Promise<{ sessions: number; bytes: number }> {
  let entries: string[];
  try {
    entries = await readdir(uploadsDir());
  } catch {
    return { sessions: 0, bytes: 0 };
  }
  let sessions = 0;
  let bytes = 0;
  for (const name of entries) {
    const record = await readRecord(name);
    if (!record || record.userId !== userId || isExpired(record)) continue;
    sessions += 1;
    if (typeof record.size === "number" && Number.isFinite(record.size)) bytes += record.size;
  }
  return { sessions, bytes };
}

/** POST /api/uploads — reserve a session and tell the client its chunk plan. */
export async function createUploadSession(
  userId: string,
  input: CreateUploadInput,
): Promise<UploadSessionView> {
  if (input.size > UPLOAD_MAX_BYTES) {
    throw badRequest(`Uploads are limited to ${UPLOAD_MAX_BYTES} bytes`);
  }

  const usage = await usageFor(userId);
  if (usage.sessions >= MAX_LIVE_UPLOAD_SESSIONS) {
    throw uploadQuota(
      `You already have ${MAX_LIVE_UPLOAD_SESSIONS} uploads waiting. Finish or cancel one before starting another.`,
    );
  }
  if (usage.bytes + input.size > MAX_UPLOAD_BYTES_PER_USER) {
    const gigabytes = Math.round(MAX_UPLOAD_BYTES_PER_USER / (1024 * 1024 * 1024));
    throw uploadQuota(
      `Uploads waiting to be processed may reserve at most ${gigabytes} GB per user. Finish or cancel one before starting another.`,
    );
  }

  const now = Date.now();
  const record: UploadSessionRecord = {
    id: randomUUID(),
    userId,
    filename: safeFilename(input.filename),
    size: input.size,
    mime: input.mime?.trim() || null,
    chunkSize: UPLOAD_CHUNK_SIZE,
    chunkCount: chunkCountFor(input.size),
    complete: false,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + UPLOAD_TTL_MS).toISOString(),
  };
  await ensureDir(sessionDir(record.id));
  await writeFileAtomic(
    resolveInside(sessionDir(record.id), SESSION_FILE),
    JSON.stringify(record, null, 2),
  );
  return toUploadSessionView(record, []);
}

/** GET /api/uploads/:id. */
export async function getUploadSession(userId: string, id: string): Promise<UploadSessionView> {
  const record = await requireOwned(userId, id);
  return toUploadSessionView(record, await listChunkIndexes(record));
}

/** Anything a chunk body can arrive as. */
export type ChunkSource = Uint8Array | AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

function toAsyncIterable(source: ChunkSource): AsyncIterable<Uint8Array> {
  if (source instanceof Uint8Array) {
    return (async function* single() {
      yield source;
    })();
  }
  if (Symbol.asyncIterator in source) {
    return source;
  }
  // A web ReadableStream without async iteration (older undici): read manually.
  const reader = (source as ReadableStream<Uint8Array>).getReader();
  return (async function* fromReader() {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  })();
}

/** 413 — a chunk larger than the plan allows. */
export function payloadTooLarge(message: string): ApiError {
  return new ApiError(413, "PAYLOAD_TOO_LARGE", message);
}

/**
 * PUT /api/uploads/:id/chunks/:index — store one chunk.
 *
 * The body is streamed to a temp file and renamed into place, so a half-sent
 * chunk never looks received. Anything over the exact expected size is a 413:
 * the client computed the chunk plan from `chunkSize`, so a mismatch is a bug
 * or an attempt to blow past `size`.
 */
export async function writeChunk(
  userId: string,
  id: string,
  index: number,
  body: ChunkSource,
): Promise<UploadSessionView> {
  const record = await requireOwned(userId, id);
  if (record.complete) throw conflict("This upload is already complete");
  if (!Number.isInteger(index) || index < 0 || index >= record.chunkCount) {
    throw badRequest(`Chunk index must be between 0 and ${record.chunkCount - 1}`);
  }

  const expected = expectedChunkSize(record, index);
  const target = chunkPath(id, index);
  const temp = `${target}.${randomUUID().slice(0, 8)}.part`;

  let written = 0;
  try {
    const handle = await open(temp, "w");
    try {
      for await (const chunk of toAsyncIterable(body)) {
        written += chunk.byteLength;
        if (written > expected) {
          throw payloadTooLarge(`Chunk ${index} may be at most ${expected} bytes`);
        }
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }
    if (written !== expected) {
      throw badRequest(`Chunk ${index} must be exactly ${expected} bytes, received ${written}`);
    }
  } catch (error) {
    // A rejected or interrupted chunk leaves nothing behind, so the client can
    // simply retry the same index.
    await rm(temp, { force: true });
    throw error;
  }
  await rename(temp, target);

  return toUploadSessionView(record, await readReceivedChunks(id));
}

/**
 * POST /api/uploads/:id/complete — concatenate the chunks into `file`.
 *
 * Idempotent: completing an already-complete session returns it unchanged.
 * The chunk files are removed afterwards so a finished upload costs its size
 * once, not twice.
 */
export async function completeUpload(userId: string, id: string): Promise<UploadSessionView> {
  const record = await requireOwned(userId, id);
  if (record.complete) return toUploadSessionView(record, await listChunkIndexes(record));

  const received = await readReceivedChunks(id);
  const missing: number[] = [];
  for (let index = 0; index < record.chunkCount; index += 1) {
    if (!received.includes(index)) missing.push(index);
  }
  if (missing.length > 0) {
    throw conflict(
      `Upload is missing ${missing.length} chunk(s): ${missing.slice(0, 10).join(", ")}`,
    );
  }

  const temp = `${payloadPath(id)}.${randomUUID().slice(0, 8)}.part`;
  let total = 0;
  const handle = await open(temp, "w");
  try {
    for (let index = 0; index < record.chunkCount; index += 1) {
      const bytes = await readFile(chunkPath(id, index));
      total += bytes.byteLength;
      await handle.write(bytes);
    }
  } finally {
    await handle.close();
  }

  if (total !== record.size) {
    await rm(temp, { force: true });
    throw badRequest(`Upload is ${total} bytes but was declared as ${record.size}`);
  }
  await rename(temp, payloadPath(id));

  const completed: UploadSessionRecord = { ...record, complete: true };
  await writeFileAtomic(
    resolveInside(sessionDir(id), SESSION_FILE),
    JSON.stringify(completed, null, 2),
  );
  for (let index = 0; index < record.chunkCount; index += 1) {
    await rm(chunkPath(id, index), { force: true });
  }
  return toUploadSessionView(completed, await listChunkIndexes(completed));
}

/** DELETE /api/uploads/:id — drop the session and everything in it. */
export async function deleteUploadSession(userId: string, id: string): Promise<void> {
  await requireOwned(userId, id);
  await rm(sessionDir(id), { recursive: true, force: true });
}

/**
 * Hand a finished upload to a job handler. Does not delete anything: the
 * handler removes the session once it has moved the bytes into the library, so
 * a crashed job can be retried while the upload is still on disk.
 */
export async function takeCompletedUpload(userId: string, id: string): Promise<CompletedUpload> {
  const record = await requireOwned(userId, id);
  if (!record.complete) throw conflict(`Upload ${record.filename} has not been completed yet`);
  const file = payloadPath(id);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw notFound("Upload");
  return {
    id: record.id,
    path: file,
    filename: record.filename,
    mime: record.mime,
    size: info.size,
  };
}

/**
 * Remove expired sessions, plus stray directories with no readable
 * `session.json` that are older than the TTL. Never throws — it runs from the
 * retention sweep.
 */
export async function purgeExpiredUploads(): Promise<number> {
  const root = uploadsDir();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    try {
      const dir = resolveInside(root, name);
      const record = await readRecord(name);
      if (record) {
        if (!isExpired(record)) continue;
      } else {
        const info = await stat(dir);
        if (info.mtimeMs > Date.now() - UPLOAD_TTL_MS) continue;
      }
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Vanished or unreadable: leave it for the next sweep.
    }
  }
  return removed;
}
