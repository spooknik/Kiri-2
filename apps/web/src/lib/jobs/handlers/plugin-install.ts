/**
 * PLUGIN_INSTALL job handler.
 *
 * Config (written by `POST /api/plugins`):
 *   `{ source: InstallPluginInput, requestedById: string | null }`
 *
 * All the work lives in `src/lib/plugins/installer.ts`; this file is the seam
 * that validates the config, keeps the job log honest and refuses to retry.
 *
 * `maxAttempts: 1` on purpose: an uploaded zip is consumed, a git clone may hit
 * a rate limit, and a half-finished install that retries itself is exactly the
 * thing the staging-then-rename design exists to avoid. A failed install is a
 * button the admin presses again.
 */
import { z } from "zod";
import { installPluginSchema } from "@/lib/contracts/plugins";
import { JobFailure, registerJobHandler, type JobContext } from "@/lib/jobs/types";
import { installPlugin, type InstallPluginResult } from "@/lib/plugins/installer";
import { clearResolveCache } from "@/lib/plugins/resolve";

/** Installs are network-bound (clone, npm) but never long-running. */
const TIMEOUT_MS = 20 * 60 * 1000;

const configSchema = z.object({
  source: installPluginSchema,
  requestedById: z.string().nullish(),
});

export async function handlePluginInstall(ctx: JobContext): Promise<InstallPluginResult> {
  const parsed = configSchema.safeParse(ctx.job.config);
  if (!parsed.success) {
    throw new JobFailure(
      "INVALID_CONFIG",
      `Invalid PLUGIN_INSTALL config: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }

  const requestedById = parsed.data.requestedById ?? ctx.job.requestedById;
  const result = await installPlugin(ctx, parsed.data.source, requestedById ?? null);

  // Every cached "no plugin handles this link" answer is now potentially wrong.
  clearResolveCache();
  ctx.log(`Installed ${result.name} ${result.version} as ${result.pluginId}`);
  return result;
}

registerJobHandler("PLUGIN_INSTALL", handlePluginInstall, {
  timeoutMs: TIMEOUT_MS,
  maxAttempts: 1,
});
