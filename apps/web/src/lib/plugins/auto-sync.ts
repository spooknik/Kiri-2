/**
 * The auto-sync scheduler.
 *
 * A sweep every five minutes asks "which sources are due?" and queues a
 * SOURCE_SYNC for each. V1 ran this from a request handler, so it only fired
 * when somebody happened to load a page; here it is started from
 * `instrumentation-node.ts` alongside the job runner.
 *
 * Due-ness follows V1 exactly: the clock starts at the **later** of the last
 * successful sync and the last time the scheduler asked, so a permanently
 * failing series is retried once per interval rather than on every sweep.
 * `createdAt` is the third term, so a brand-new source syncs on the next sweep
 * instead of waiting a whole interval.
 *
 * Modes: `INHERIT` follows the instance interval (and is off entirely while
 * `AppSetting.autoSyncEnabled` is false), `CUSTOM` uses its own, `DISABLED`
 * never runs.
 */
import type { AutoSyncMode } from "@/lib/contracts/plugins";
import { enqueueAutoSync } from "@/lib/plugins/source";
import { effectiveIntervalMinutes } from "@/lib/plugins/serialize";
import { triggerJobProcessing } from "@/lib/jobs/runner";
import { prisma } from "@/lib/prisma";
import { readGlobalPluginSettings } from "@/lib/plugins/app-settings";

/** Let migrations, the pool and the job runner settle first. */
export const FIRST_SWEEP_DELAY_MS = 30_000;
/** How often the scheduler looks for due sources (V1 used the same). */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface DueInput {
  lastSyncedAt: Date | null;
  autoSyncRequestedAt: Date | null;
  createdAt: Date;
  autoSyncMode: AutoSyncMode;
  autoSyncIntervalMinutes: number | null;
}

/**
 * Is this source due for an automatic sync? Pure, so the rule is testable
 * without a database or a clock.
 */
export function isDue(
  source: DueInput,
  globalIntervalMinutes: number,
  globalEnabled: boolean,
  now: Date = new Date(),
): boolean {
  const interval = effectiveIntervalMinutes(
    source.autoSyncMode,
    source.autoSyncIntervalMinutes,
    globalIntervalMinutes,
    globalEnabled,
  );
  if (interval === null) return false;

  const last = Math.max(
    source.lastSyncedAt?.getTime() ?? 0,
    source.autoSyncRequestedAt?.getTime() ?? 0,
    source.createdAt.getTime(),
  );
  return now.getTime() - last >= interval * 60 * 1000;
}

/**
 * One sweep. Returns how many syncs were queued. Never throws — it runs from a
 * timer, and a database blip must not take the interval down with it.
 */
export async function runAutoSyncSweep(now: Date = new Date()): Promise<number> {
  const settings = await readGlobalPluginSettings();
  if (!settings.autoSyncEnabled) return 0;

  const candidates = await prisma.source.findMany({
    where: {
      pluginId: { not: null },
      status: { not: "NEEDS_PLUGIN" },
      autoSyncMode: { not: "DISABLED" },
      plugin: { is: { status: "ENABLED" } },
      // A source with a job in flight is busy; the next sweep will find it.
      series: {
        is: {
          jobs: {
            none: {
              kind: { in: ["SOURCE_SYNC", "SOURCE_VERIFY"] },
              status: { in: ["QUEUED", "RUNNING"] },
            },
          },
        },
      },
    },
    select: {
      id: true,
      seriesId: true,
      pluginId: true,
      lastSyncedAt: true,
      autoSyncRequestedAt: true,
      autoSyncMode: true,
      autoSyncIntervalMinutes: true,
      createdAt: true,
      normalizedUrl: true,
    },
  });

  let queued = 0;
  for (const source of candidates) {
    if (!source.pluginId || !source.normalizedUrl) continue;
    if (!isDue(source, settings.autoSyncIntervalMinutes, settings.autoSyncEnabled, now)) continue;

    // Stamp first: if the enqueue throws (a race with a manual sync), the
    // source still waits a full interval instead of being retried every sweep.
    await prisma.source.update({
      where: { id: source.id },
      data: { autoSyncRequestedAt: now },
    });
    try {
      await enqueueAutoSync(source.seriesId, source.id, source.pluginId);
      queued += 1;
    } catch {
      // 409 from the queue: something else got there first. Nothing to do.
    }
  }

  if (queued > 0) {
    console.log(`[auto-sync] queued ${queued} update check(s)`);
    triggerJobProcessing();
  }
  return queued;
}

/* -------------------------------------------------------------------------- */
/* Scheduler                                                                  */
/* -------------------------------------------------------------------------- */

interface SchedulerState {
  first: NodeJS.Timeout | null;
  repeat: NodeJS.Timeout | null;
}

// Same reasoning as the job runner: Next can evaluate this module once per
// route bundle inside a single process, and globalThis is the shared scope.
const STATE_KEY = Symbol.for("kiri.plugins.autoSync.state");

function state(): SchedulerState {
  const holder = globalThis as unknown as Record<symbol, SchedulerState | undefined>;
  return (holder[STATE_KEY] ??= { first: null, repeat: null });
}

async function sweep(): Promise<void> {
  try {
    await runAutoSyncSweep();
  } catch (error) {
    console.error("[auto-sync] sweep failed", error);
  }
}

/** Idempotent; safe to call on every hot reload. Timers are unref'd. */
export function startAutoSyncScheduler(): void {
  const current = state();
  if (current.repeat) return;

  const first = setTimeout(() => void sweep(), FIRST_SWEEP_DELAY_MS);
  const repeat = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  first.unref?.();
  repeat.unref?.();
  current.first = first;
  current.repeat = repeat;
}

/** Stop the scheduler (tests, graceful shutdown). */
export function stopAutoSyncScheduler(): void {
  const current = state();
  if (current.first) clearTimeout(current.first);
  if (current.repeat) clearInterval(current.repeat);
  current.first = null;
  current.repeat = null;
}

export function isAutoSyncSchedulerRunning(): boolean {
  return state().repeat !== null;
}
