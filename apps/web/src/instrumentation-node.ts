/**
 * Node-runtime half of the Next.js instrumentation hook (see
 * src/instrumentation.ts). Only ever imported when NEXT_RUNTIME is "nodejs",
 * so this file may reach for Prisma, timers and the filesystem freely.
 *
 * It schedules the retention sweep, scans the plugins directory, starts the job
 * runner and arms the auto-sync scheduler (V1 kicked these off from
 * `/api/health` and from the notifications route, which meant they only ran
 * once somebody loaded a page).
 *
 * Three rules make this safe:
 *  - Node runtime only. `register()` also runs for the edge runtime, where
 *    Prisma and timers of this kind do not belong.
 *  - Never during `next build`. Collecting page data imports the app, and a
 *    build must not open database handles or schedule work.
 *  - Prisma is imported dynamically inside `register()`, so nothing pulls the
 *    client into the module graph when the guards bail out.
 */

/** First sweep runs after boot settles; migrations and the pool come first. */
const FIRST_RUN_DELAY_MS = 30_000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

interface RetentionGlobal {
  __kiriRetentionScheduled?: boolean;
}

const globalForRetention = globalThis as unknown as RetentionGlobal;

async function sweep(): Promise<void> {
  try {
    const { runRetention } = await import("@/lib/retention");
    const result = await runRetention();
    if (result.error) return;
    if (
      result.notificationsPurged ||
      result.invitesExpired ||
      result.sessionsDeleted ||
      result.verificationsDeleted ||
      result.uploadsPurged ||
      result.jobTmpDirsRemoved
    ) {
      console.log(
        `[retention] purged ${result.notificationsPurged} notifications, ` +
          `expired ${result.invitesExpired} invites, deleted ${result.sessionsDeleted} sessions, ` +
          `${result.verificationsDeleted} verifications, ${result.uploadsPurged} uploads ` +
          `and ${result.jobTmpDirsRemoved} job scratch dirs in ${result.durationMs} ms`,
      );
    }
  } catch (error) {
    console.error("[retention] scheduler failed", error);
  }
}

/**
 * Load the job handlers, then start the runner.
 *
 * Order matters: handler modules register themselves as a side effect of being
 * imported, so the import has to finish before the runner claims anything —
 * otherwise the first job would be failed as NO_HANDLER. `startJobRunner` is
 * idempotent and keeps its own `globalThis` guard, so a hot reload that
 * re-enters this is harmless.
 */
async function startJobs(): Promise<void> {
  try {
    await import("@/lib/jobs/handlers");
    const { startJobRunner } = await import("@/lib/jobs/runner");
    await startJobRunner();
  } catch (error) {
    console.error("[jobs] the job runner could not be started", error);
  }
}

/**
 * Reconcile `DATA_ROOT/plugins` with the `Plugin` table, then arm the
 * auto-sync scheduler.
 *
 * The scan reads and validates descriptors only — it never executes plugin
 * code, so a hostile or broken plugin cannot stop the server from booting. It
 * runs before the scheduler so the first sweep already knows which plugins are
 * BROKEN (and which series are therefore parked on NEEDS_PLUGIN).
 */
async function startPlugins(): Promise<void> {
  try {
    const { scanPlugins } = await import("@/lib/plugins/registry");
    const result = await scanPlugins();
    if (result.ok || result.invalid || result.missing) {
      console.log(
        `[plugins] ${result.ok} installed (${result.added} new, ${result.updated} updated), ` +
          `${result.invalid} unreadable, ${result.missing} missing`,
      );
    }
  } catch (error) {
    console.error("[plugins] the boot scan failed", error);
  }

  try {
    const { startAutoSyncScheduler } = await import("@/lib/plugins/auto-sync");
    startAutoSyncScheduler();
  } catch (error) {
    console.error("[auto-sync] the scheduler could not be started", error);
  }
}

export function registerNode(): void {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  // Dev hot reload re-runs this module; the guard lives on globalThis so the
  // interval is not stacked up on every edit.
  if (globalForRetention.__kiriRetentionScheduled) return;
  globalForRetention.__kiriRetentionScheduled = true;

  const first = setTimeout(() => void sweep(), FIRST_RUN_DELAY_MS);
  const repeat = setInterval(() => void sweep(), INTERVAL_MS);
  // Housekeeping must never be the reason the process stays alive.
  first.unref?.();
  repeat.unref?.();

  void startJobs();
  void startPlugins();
}
