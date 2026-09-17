/**
 * PUT /api/series/:id/position — remember where the reader stopped.
 *
 * Idempotent upsert (the reader debounces and flushes on `pagehide`, and the
 * offline queue replays), and reaching the last page of a chapter marks that
 * chapter read as a side effect.
 */
import { z } from "zod";
import { withAuth } from "@/lib/api";
import { updatePosition } from "@/lib/content/reading";
import { updatePositionSchema } from "@/lib/contracts";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

export const PUT = withAuth(
  { params: paramsSchema, body: updatePositionSchema },
  ({ user, params, body }) => updatePosition(user, params.id, body),
);
