/**
 * GET /api/series/:id/chapters — the chapter list plus this user's read state
 * and reading position. Needs view access to the series.
 */
import { z } from "zod";
import { withAuth } from "@/lib/api";
import { listChapters } from "@/lib/content/chapters";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

export const GET = withAuth({ params: paramsSchema }, ({ user, params }) =>
  listChapters(user, params.id),
);
