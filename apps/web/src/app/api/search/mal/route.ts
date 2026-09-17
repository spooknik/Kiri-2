/**
 * GET /api/search/mal — MyAnimeList search, proxied through Jikan v4.
 *
 * Behind auth (V1 exposed it unauthenticated), filtered to safe-for-work
 * unless the user opted into adult content, and annotated with
 * `existingSeriesId` so the add form can offer "open it" instead of creating a
 * duplicate.
 */
import { withAuth } from "@/lib/api";
import type { MalSearchResponse } from "@/lib/contracts";
import { malSearchQuerySchema } from "@/lib/contracts";
import { JikanRateLimitError, searchMal } from "@/lib/jikan";
import { checkRateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { findVisibleSeriesIdsByMalIds } from "@/lib/series/dedupe";

export const dynamic = "force-dynamic";

export const GET = withAuth({ query: malSearchQuerySchema }, async ({ user, query }) => {
  // Jikan's own bucket is shared by the whole instance, so one member typing
  // fast could 429 everybody else. Spend a per-user token first.
  const gate = checkRateLimit(`mal:search:${user.id}`, { capacity: 5, refillPerSecond: 0.5 });
  if (!gate.allowed) return rateLimitedResponse(gate.retryAfterMs);

  let results;
  try {
    results = await searchMal(query.q, query.limit, { sfw: !user.showAdult });
  } catch (error) {
    if (error instanceof JikanRateLimitError) {
      return rateLimitedResponse(error.retryAfterMs);
    }
    throw error;
  }

  const existing = await findVisibleSeriesIdsByMalIds(
    user,
    results.map((result) => result.malId),
  );

  const response: MalSearchResponse = {
    results: results.map((result) => ({
      ...result,
      existingSeriesId: existing.get(result.malId) ?? null,
    })),
  };
  return response;
});
