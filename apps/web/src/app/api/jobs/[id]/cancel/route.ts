/**
 * POST /api/jobs/:id/cancel.
 *
 * A QUEUED job is cancelled outright; a RUNNING one is asked to stop and the
 * response shows it still RUNNING until the worker finalises it — poll
 * /api/jobs/:id for the terminal state.
 */
import { z } from "zod";
import { withAuth } from "@/lib/api";
import { cancelJob } from "@/lib/jobs/queue";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

export const POST = withAuth({ params: paramsSchema }, ({ user, params }) =>
  cancelJob(user, params.id),
);
