/**
 * GET/PATCH/DELETE /api/series/:id.
 *
 * GET needs view access, PATCH and DELETE need edit access (creator or admin);
 * both checks live in `src/lib/series/service.ts` so the rules are identical
 * here and in the bulk route.
 */
import { z } from "zod";
import { withAuth } from "@/lib/api";
import { updateSeriesSchema } from "@/lib/contracts";
import { deleteSeries, getSeriesDetail, updateSeries } from "@/lib/series/service";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

export const GET = withAuth({ params: paramsSchema }, ({ user, params }) =>
  getSeriesDetail(user, params.id),
);

export const PATCH = withAuth(
  { params: paramsSchema, body: updateSeriesSchema },
  ({ user, params, body }) => updateSeries(user, params.id, body),
);

export const DELETE = withAuth({ params: paramsSchema }, async ({ user, params }) => {
  await deleteSeries(user, params.id);
});
