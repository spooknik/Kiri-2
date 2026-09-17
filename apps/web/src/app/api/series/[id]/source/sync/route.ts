/**
 * POST /api/series/:id/source/sync — ask the plugin for new chapters
 * (`kind: "sync"`) or re-check what is on disk (`kind: "verify"`).
 *
 * 202 with the job id; a second request while one is in flight is a 409 from
 * the queue's one-active-job-per-series rule.
 */
import { z } from "zod";
import { jsonResponse, withAuth } from "@/lib/api";
import { syncSourceSchema } from "@/lib/contracts/plugins";
import type { EnqueuedJobResponse } from "@/lib/contracts/content";
import { requestSync } from "@/lib/plugins/source";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

export const POST = withAuth(
  { params: paramsSchema, body: syncSourceSchema },
  async ({ user, params, body }) => {
    const { jobId } = await requestSync(user, params.id, body.kind);
    return jsonResponse({ jobId } satisfies EnqueuedJobResponse, { status: 202 });
  },
);
