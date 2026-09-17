/**
 * GET /api/uploads/:id — progress of one upload (which chunks arrived).
 * DELETE /api/uploads/:id — abandon it and free the disk.
 *
 * Both are 404 for a session that belongs to someone else: an upload id must
 * not be probeable.
 */
import { z } from "zod";
import { withAuth } from "@/lib/api";
import { deleteUploadSession, getUploadSession } from "@/lib/uploads/sessions";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

export const GET = withAuth({ params: paramsSchema }, ({ user, params }) =>
  getUploadSession(user.id, params.id),
);

export const DELETE = withAuth({ params: paramsSchema }, async ({ user, params }) => {
  await deleteUploadSession(user.id, params.id);
});
