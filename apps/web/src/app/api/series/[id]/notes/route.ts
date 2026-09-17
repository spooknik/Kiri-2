/**
 * GET /api/series/:id/notes — one keyset page of top-level notes on the
 * series, optionally narrowed to a chapter or a single page. Needs view access
 * to the series; spoiler gating is applied per note (see
 * `src/lib/notes/spoilers.ts`).
 */
import { z } from "zod";
import { withAuth } from "@/lib/api";
import { notesQuerySchema } from "@/lib/contracts/notes";
import { listNotes } from "@/lib/notes/service";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

export const GET = withAuth(
  { params: paramsSchema, query: notesQuerySchema },
  ({ user, params, query }) => listNotes(user, params.id, query),
);
