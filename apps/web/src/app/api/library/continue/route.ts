/**
 * GET /api/library/continue — the most recent reading positions across every
 * series the user can see, for the "continue reading" rail.
 */
import { z } from "zod";
import { withAuth } from "@/lib/api";
import { continueReading } from "@/lib/content/reading";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const GET = withAuth({ query: querySchema }, ({ user, query }) =>
  continueReading(user, query.limit),
);
