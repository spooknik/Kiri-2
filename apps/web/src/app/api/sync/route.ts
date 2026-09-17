/**
 * POST /api/sync — replay a batch of operations authored while offline.
 *
 * The queue on the client coalesces and orders; this route just applies. Three
 * properties matter:
 *
 *   - **Ordered.** Ops are applied sequentially, in the order the client sent
 *     them, because a position and a chapter-read for the same chapter are not
 *     commutative (`updatePosition` marks the chapter read as a side effect
 *     when the last page is reached).
 *   - **Idempotent.** Each op carries a client-minted uuid. A short-lived
 *     per-user set of seen ids absorbs the common double-flush (two tabs, or a
 *     response lost on the way back); underneath, every operation is an upsert,
 *     so even a cold process replaying the same batch is harmless.
 *   - **Partial success.** One bad op — a series that was deleted, a chapter
 *     the user lost access to — must not fail the batch. Every op reports its
 *     own `{ id, ok, error? }`, and the client drops both the applied and the
 *     rejected ones.
 */
import { ApiError, badRequest, withAuth } from "@/lib/api";
import type { SessionUser } from "@/lib/auth/types";
import { setChapterRead, updatePosition } from "@/lib/content/reading";
import { syncBatchSchema, type SyncBatchResult, type SyncOp } from "@/lib/contracts/offline";
import { applyNoteSyncOp } from "@/lib/notes/sync";

export const dynamic = "force-dynamic";

/**
 * Recently applied op ids, per user. Deliberately in-memory and small: this is
 * an optimisation for the double-flush case, not the correctness mechanism (the
 * upserts underneath are). A restart simply replays, which is a no-op.
 */
const SEEN_TTL_MS = 10 * 60_000;
const SEEN_MAX_PER_USER = 500;

interface SeenEntry {
  ids: Map<string, number>;
}

const seenByUser = new Map<string, SeenEntry>();

function markSeen(userId: string, opId: string, now: number): boolean {
  let entry = seenByUser.get(userId);
  if (!entry) {
    entry = { ids: new Map() };
    seenByUser.set(userId, entry);
  }

  const previous = entry.ids.get(opId);
  if (previous !== undefined && now - previous < SEEN_TTL_MS) {
    return true;
  }

  entry.ids.set(opId, now);
  if (entry.ids.size > SEEN_MAX_PER_USER) {
    // Map iterates in insertion order, so the oldest ids are dropped first.
    for (const [id, at] of entry.ids) {
      if (entry.ids.size <= SEEN_MAX_PER_USER && now - at < SEEN_TTL_MS) break;
      entry.ids.delete(id);
    }
  }
  return false;
}

async function applyOp(user: SessionUser, op: SyncOp): Promise<void> {
  switch (op.type) {
    case "position":
      await updatePosition(user, op.seriesId, {
        chapterId: op.chapterId,
        pageIndex: op.pageIndex,
      });
      return;
    case "chapterRead":
      await setChapterRead(user, op.chapterId, op.read);
      return;
    case "note": {
      // The notes module owns this; it is a stub until Phase 6 lands, and a
      // stub's `{ ok: false }` is reported per op rather than throwing.
      const result = await applyNoteSyncOp(user, {
        noteId: op.noteId,
        note: op.note,
        at: op.at,
      });
      if (!result.ok) {
        // An ApiError so `opErrorMessage` forwards it: this string is written
        // for the person syncing, not an internal failure.
        throw badRequest(result.error ?? "Note could not be synced");
      }
      return;
    }
  }
}

function opErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (process.env.NODE_ENV === "production" || !(error instanceof Error)) {
    return "Operation failed";
  }
  return error.message;
}

export const POST = withAuth({ body: syncBatchSchema }, async ({ user, body }) => {
  const now = Date.now();
  const results: SyncBatchResult["results"] = [];

  for (const op of body.ops) {
    if (markSeen(user.id, op.id, now)) {
      results.push({ id: op.id, ok: true });
      continue;
    }
    try {
      await applyOp(user, op);
      results.push({ id: op.id, ok: true });
    } catch (error) {
      // Re-queueing a permanently broken op would wedge the client's queue, so
      // the failure is reported and the client drops it. The message follows
      // the same rule as `handleError` in src/lib/api.ts: an ApiError is
      // written for the user and safe to forward, anything else may carry
      // internals (a Prisma query, a connection string) and is masked in
      // production while the original is logged.
      console.error(`[sync] op ${op.id} (${op.type}) failed`, error);
      results.push({ id: op.id, ok: false, error: opErrorMessage(error) });
    }
  }

  return { results } satisfies SyncBatchResult;
});
