/**
 * SOURCE_SYNC and SOURCE_VERIFY job handlers.
 *
 * Config (written by `src/lib/plugins/source.ts` and the auto-sync scheduler):
 *   `{ seriesId, sourceId, kind: "sync" | "verify", autoSync?: boolean }`
 *
 * Both kinds run the same code path — the difference is one verb and whether
 * `lastSyncedAt` moves — so they share `runSourceSync`. The plugin subprocess
 * takes `ctx.signal`, so cancelling the job kills the process group (and the
 * browser tree a `browser`-capability plugin may have started).
 */
import { registerJobHandler, type JobContext } from "@/lib/jobs/types";
import { runSourceSync, type SyncResult } from "@/lib/plugins/sync";

/** A sync is retried at most once: the site is usually the reason it failed. */
const MAX_ATTEMPTS = 2;

export function handleSourceSync(ctx: JobContext): Promise<SyncResult> {
  return runSourceSync(ctx);
}

export function handleSourceVerify(ctx: JobContext): Promise<SyncResult> {
  // The verb comes from the config, which the route sets to "verify"; falling
  // back on the job kind keeps an old queued row working after a deploy.
  if (ctx.job.config["kind"] === undefined) ctx.job.config["kind"] = "verify";
  return runSourceSync(ctx);
}

registerJobHandler("SOURCE_SYNC", handleSourceSync, { maxAttempts: MAX_ATTEMPTS });
registerJobHandler("SOURCE_VERIFY", handleSourceVerify, { maxAttempts: 1 });
