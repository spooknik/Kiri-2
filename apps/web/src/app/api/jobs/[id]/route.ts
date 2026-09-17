/** GET /api/jobs/:id — one job, 404 when the caller may not see it. */
import { z } from "zod";
import { withAuth } from "@/lib/api";
import { getJob } from "@/lib/jobs/queue";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

export const GET = withAuth({ params: paramsSchema }, ({ user, params }) =>
  getJob(user, params.id),
);
