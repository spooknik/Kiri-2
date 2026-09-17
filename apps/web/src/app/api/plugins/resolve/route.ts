/**
 * POST /api/plugins/resolve — "does anything here handle this link?"
 *
 * Used by the add-series form while the user pastes a URL, so it is available
 * to any signed-in user (not admins only) and answers from a five-minute cache
 * when it can. A URL no plugin claims is `handled: false`, not an error.
 *
 * A miss costs up to three plugin subprocesses, which makes this the cheapest
 * route on the instance to turn into a fork bomb. Two things stop that: the
 * process-wide semaphore in `resolve.ts`, and the per-user bucket here — ten
 * back-to-back checks (one form's worth of typing) refilling at one every two
 * seconds.
 */
import { withAuth } from "@/lib/api";
import { resolveUrlSchema, type ResolveUrlResponse } from "@/lib/contracts/plugins";
import { resolveSourceUrl } from "@/lib/plugins/resolve";
import { checkRateLimit, rateLimitedResponse } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export const POST = withAuth(
  { body: resolveUrlSchema },
  async ({ user, body }): Promise<ResolveUrlResponse | Response> => {
    const gate = checkRateLimit(`plugins:resolve:${user.id}`, {
      capacity: 10,
      refillPerSecond: 0.5,
    });
    if (!gate.allowed) return rateLimitedResponse(gate.retryAfterMs);
    return resolveSourceUrl(user, body.url);
  },
);
