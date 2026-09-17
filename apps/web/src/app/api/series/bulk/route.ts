/**
 * PATCH /api/series/bulk — one action across a selection.
 *
 * Static segment, so it wins over `/api/series/[id]`. Permission is decided
 * per id in `src/lib/series/bulk.ts`; the response reports what was applied
 * and why the rest was skipped.
 */
import { withAuth } from "@/lib/api";
import { bulkSeriesSchema } from "@/lib/contracts";
import { bulkUpdateSeries } from "@/lib/series/bulk";

export const dynamic = "force-dynamic";

export const PATCH = withAuth({ body: bulkSeriesSchema }, ({ user, body }) =>
  bulkUpdateSeries(user, body),
);
