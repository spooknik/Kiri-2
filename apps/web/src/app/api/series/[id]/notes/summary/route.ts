/**
 * GET /api/series/:id/notes/summary — note totals and per-chapter counts for
 * the series page. Counts only; no bodies, so nothing here is spoiler-gated.
 */
import { z } from "zod";
import { withAuth } from "@/lib/api";
import { getSummary } from "@/lib/notes/service";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

export const GET = withAuth({ params: paramsSchema }, ({ user, params }) =>
  getSummary(user, params.id),
);
