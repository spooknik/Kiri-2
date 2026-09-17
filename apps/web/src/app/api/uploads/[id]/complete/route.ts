/**
 * POST /api/uploads/:id/complete — concatenate the chunks into one file.
 *
 * Idempotent: a session that is already complete comes back unchanged, so a
 * client that lost the response can simply ask again.
 */
import { z } from "zod";
import { withAuth } from "@/lib/api";
import { completeUpload } from "@/lib/uploads/sessions";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

export const POST = withAuth({ params: paramsSchema }, ({ user, params }) =>
  completeUpload(user.id, params.id),
);
