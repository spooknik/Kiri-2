/**
 * PUT /api/chapters/:id/read — mark a chapter read or unread for the current
 * user. Idempotent, so the offline sync queue can replay it safely. Answers
 * with the updated chapter list item.
 */
import { z } from "zod";
import { withAuth } from "@/lib/api";
import { setChapterRead } from "@/lib/content/reading";
import { setChapterReadSchema } from "@/lib/contracts";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

export const PUT = withAuth(
  { params: paramsSchema, body: setChapterReadSchema },
  ({ user, params, body }) => setChapterRead(user, params.id, body.read),
);
