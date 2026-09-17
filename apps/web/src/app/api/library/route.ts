/**
 * GET /api/library — the dashboard list.
 *
 * All the work happens in `src/lib/library/query.ts`; the route only binds the
 * contract schema to it.
 */
import { withAuth } from "@/lib/api";
import { libraryQuerySchema } from "@/lib/contracts";
import { listLibrary } from "@/lib/library/query";

export const dynamic = "force-dynamic";

export const GET = withAuth({ query: libraryQuerySchema }, ({ user, query }) =>
  listLibrary(user, query),
);
