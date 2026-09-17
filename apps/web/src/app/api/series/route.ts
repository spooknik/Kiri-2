/**
 * POST /api/series — add a series to the instance.
 *
 * The listing lives at GET /api/library; this route only creates. Lightly
 * rate limited per user (30 burst, 30/min sustained) so a runaway importer or
 * a stuck retry loop cannot fill the library.
 */
import { jsonResponse, withAuth } from "@/lib/api";
import { createSeriesSchema } from "@/lib/contracts";
import { checkRateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { createSeries } from "@/lib/series/service";

export const dynamic = "force-dynamic";

export const POST = withAuth({ body: createSeriesSchema }, async ({ user, body }) => {
  const gate = checkRateLimit(`series:create:${user.id}`, {
    capacity: 30,
    refillPerSecond: 0.5,
  });
  if (!gate.allowed) return rateLimitedResponse(gate.retryAfterMs);

  const detail = await createSeries(user, body);
  return jsonResponse(detail, { status: 201 });
});
