/**
 * Server-side entry used by the offline sync endpoint (`POST /api/sync`) to
 * replay a queued note operation. The signature is the contract the sync route
 * codes against; the body arrives as an unvalidated record because the queue
 * stored whatever the browser wrote, so it is re-validated here against the
 * same schema the HTTP route uses.
 *
 * Idempotency comes from `upsertNote`: the note id was minted by the client
 * before the write was queued, so replaying an op updates the existing row
 * instead of inserting a second one, and only the first replay notifies.
 */
import { ApiError } from "@/lib/api";
import type { SessionUser } from "@/lib/auth/types";
import { upsertNoteSchema } from "@/lib/contracts/notes";
import { upsertNote } from "@/lib/notes/service";

export interface NoteSyncResult {
  ok: boolean;
  error?: string;
}

export async function applyNoteSyncOp(
  user: SessionUser,
  op: { noteId: string; note: Record<string, unknown>; at: string },
): Promise<NoteSyncResult> {
  const parsed = upsertNoteSchema.safeParse(op.note);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? `${first.path.join(".")}: ` : "";
    return { ok: false, error: `Invalid note: ${where}${first?.message ?? "unknown field"}` };
  }

  try {
    await upsertNote(user, op.noteId, parsed.data);
    return { ok: true };
  } catch (error) {
    // A rejected replay must not fail the whole batch: the sync route reports
    // it per op so the client can drop or retry that one write.
    if (error instanceof ApiError) return { ok: false, error: error.message };
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}
