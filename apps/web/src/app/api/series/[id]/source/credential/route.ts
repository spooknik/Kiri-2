/**
 * PUT    /api/series/:id/source/credential — paste a cookie for this series.
 * DELETE /api/series/:id/source/credential — forget it.
 *
 * The cookie is stripped of Cloudflare's per-session bot cookies, normalised
 * (a bare token becomes `cf_clearance=<token>`), encrypted with APP_SECRET and
 * stamped with `cookieUpdatedAt` — the timestamp the recency rule in
 * `src/lib/plugins/credentials.ts` compares against the extension's capture.
 *
 * The response never contains the cookie: `SourceView` only says whether one
 * exists and when it was set.
 */
import { z } from "zod";
import { withAuth } from "@/lib/api";
import { sourceCredentialSchema } from "@/lib/contracts/plugins";
import { clearSeriesCredential, setSeriesCredential } from "@/lib/plugins/source";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

export const PUT = withAuth(
  { params: paramsSchema, body: sourceCredentialSchema },
  ({ user, params, body }) => setSeriesCredential(user, params.id, body),
);

export const DELETE = withAuth({ params: paramsSchema }, ({ user, params }) =>
  clearSeriesCredential(user, params.id),
);
