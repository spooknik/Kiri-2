/**
 * GET  /api/plugins — what is installed (any signed-in user; the series page
 *                     needs to know which sites are supported).
 * POST /api/plugins — install one (admin). 202 with the job id; poll
 *                     /api/jobs/:id for progress, since a clone plus an npm
 *                     install is not a request-shaped amount of work.
 */
import { jsonResponse, withAuth } from "@/lib/api";
import { isAdmin } from "@/lib/auth/types";
import { installPluginSchema, type PluginView } from "@/lib/contracts/plugins";
import type { EnqueuedJobResponse } from "@/lib/contracts/content";
import { enqueueJob } from "@/lib/jobs/queue";
import { triggerJobProcessing } from "@/lib/jobs/runner";
import { listPlugins } from "@/lib/plugins/registry";
import { toMemberPluginView } from "@/lib/plugins/serialize";

export const dynamic = "force-dynamic";

/**
 * A bare array, as the other list endpoints do (/api/admin/users, /invites).
 *
 * Members get the same shape with the operational fields blanked: where a
 * plugin came from and how it last broke are an admin's business. `hosts`
 * stays — the series form uses it to say which sites are recognised.
 */
export const GET = withAuth({}, async ({ user }): Promise<PluginView[]> => {
  const plugins = await listPlugins();
  return isAdmin(user) ? plugins : plugins.map(toMemberPluginView);
});

export const POST = withAuth(
  { role: "admin", body: installPluginSchema },
  async ({ user, body }) => {
    const job = await enqueueJob({
      kind: "PLUGIN_INSTALL",
      requestedById: user.id,
      config: { source: body, requestedById: user.id },
    });
    triggerJobProcessing();
    return jsonResponse({ jobId: job.id } satisfies EnqueuedJobResponse, { status: 202 });
  },
);
