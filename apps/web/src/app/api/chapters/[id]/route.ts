/**
 * GET/PATCH/DELETE /api/chapters/:id.
 *
 * GET needs view access to the chapter's series, PATCH and DELETE need edit
 * access (creator or admin); both checks live in `src/lib/content/chapters.ts`.
 * PATCH and DELETE answer with the updated detail / 204.
 */
import { z } from "zod";
import { withAuth } from "@/lib/api";
import { deleteChapter, getChapterDetail, updateChapter } from "@/lib/content/chapters";
import { updateChapterSchema } from "@/lib/contracts";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

export const GET = withAuth({ params: paramsSchema }, ({ user, params }) =>
  getChapterDetail(user, params.id),
);

export const PATCH = withAuth(
  { params: paramsSchema, body: updateChapterSchema },
  ({ user, params, body }) => updateChapter(user, params.id, body),
);

export const DELETE = withAuth({ params: paramsSchema }, async ({ user, params }) => {
  await deleteChapter(user, params.id);
});
