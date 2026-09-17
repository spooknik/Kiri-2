/**
 * PUT/DELETE /api/series/:id/entry — the current user's tracking row.
 *
 * PUT creates the entry when it is missing, so "start tracking" and "update my
 * progress" are the same call. DELETE only removes the caller's entry; the
 * series itself always survives, even when the creator untracks it.
 */
import { z } from "zod";
import { withAuth } from "@/lib/api";
import { updateEntrySchema } from "@/lib/contracts";
import { removeEntry, upsertEntry } from "@/lib/series/service";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

export const PUT = withAuth(
  { params: paramsSchema, body: updateEntrySchema },
  ({ user, params, body }) => upsertEntry(user, params.id, body),
);

export const DELETE = withAuth({ params: paramsSchema }, async ({ user, params }) => {
  await removeEntry(user, params.id);
});
