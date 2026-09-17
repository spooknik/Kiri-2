/**
 * GET    /api/notes/:id?reveal=1 — one note with its replies. `reveal` returns
 *                                  spoiler-gated bodies the viewer asked for.
 * PUT    /api/notes/:id          — idempotent upsert on the client-minted id;
 *                                  201 when it created the note, 200 when it
 *                                  edited the caller's existing one.
 * PATCH  /api/notes/:id          — author-only body/spoiler edit.
 * DELETE /api/notes/:id          — soft delete by the author or an admin (204).
 */
import { z } from "zod";
import { jsonResponse, withAuth } from "@/lib/api";
import { editNoteSchema, upsertNoteSchema } from "@/lib/contracts/notes";
import { deleteNote, editNote, getThread, upsertNote } from "@/lib/notes/service";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });
const threadQuerySchema = z.object({ reveal: z.enum(["1"]).optional() });

export const GET = withAuth(
  { params: paramsSchema, query: threadQuerySchema },
  ({ user, params, query }) => getThread(user, params.id, { reveal: query.reveal === "1" }),
);

export const PUT = withAuth(
  { params: paramsSchema, body: upsertNoteSchema },
  async ({ user, params, body }) => {
    const { note, created } = await upsertNote(user, params.id, body);
    return jsonResponse(note, { status: created ? 201 : 200 });
  },
);

export const PATCH = withAuth(
  { params: paramsSchema, body: editNoteSchema },
  ({ user, params, body }) => editNote(user, params.id, body),
);

export const DELETE = withAuth({ params: paramsSchema }, async ({ user, params }) => {
  await deleteNote(user, params.id);
});
