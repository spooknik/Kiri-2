/**
 * The job runner.
 *
 * Replaces V1's `rip-queue.ts`. One PostgreSQL-backed queue, claimed with a
 * conditional `updateMany` (`status: QUEUED` in the WHERE clause is the lock),
 * `JOB_CONCURRENCY` jobs in flight, and a heartbeat column so a job whose
 * process died is reclaimed by the next sweep instead of blocking its series
 * until someone restarts the container — V1 only recovered at boot.
 *
 * Everything that has to survive Next.js loading this module more than once in
 * the same process (dev hot reload, one copy per route bundle) lives on a
 * `globalThis` registry keyed by a symbol, exactly like V1's `queueState`.
 *
 * Lifecycle of a job, all in `executeJob`:
 *   claim -> JobContext (abort signal, log buffer, throttled progress, tmp dir)
 *   -> handler -> SUCCEEDED / FAILED / CANCELLED / back to QUEUED for a retry.
 *
 * `attempt` is incremented at claim time, so a job that has run once is at
 * attempt 1. Retry and stale reclaim therefore compare `attempt < maxAttempts`
 * and re-queue without touching the counter; the next claim raises it.
 */
import { Prisma } from "@/generated/prisma/client";
import type { JobKind, JobStatus } from "@/generated/prisma/client";
import { ensureDir, removeDirSafe } from "@/lib/content/store";
import type { JobProgress } from "@/lib/contracts/content";
import { getEnv } from "@/lib/env";
import { JobLogBuffer } from "@/lib/jobs/log";
import { jobTmpDir } from "@/lib/jobs/tmp";
// Side-effect import: every module instance that can run jobs must have the
// handlers registered, not only the copy loaded by instrumentation.ts.
import "@/lib/jobs/handlers";
import { toJobConfig } from "@/lib/jobs/serialize";
import {
  getJobHandler,
  JobFailure,
  type JobContext,
  type JobHandlerOptions,
  type JobRecord,
} from "@/lib/jobs/types";
import { prisma } from "@/lib/prisma";

/** A RUNNING job whose heartbeat is older than this has lost its process. */
export const STALE_LEASE_MS = 2 * 60 * 1000;
/** Background heartbeat for handlers that work silently. */
const HEARTBEAT_INTERVAL_MS = 15 * 1000;
/** Output log flush interval. */
const LOG_FLUSH_INTERVAL_MS = 2 * 1000;
/** At most one progress row-write per job per this window. */
const PROGRESS_INTERVAL_MS = 500;
/** Periodic re-trigger, so jobs enqueued elsewhere never sit forever. */
const SWEEP_INTERVAL_MS = 60 * 1000;
/** Default automatic re-queues after a crash, stale lease or retryable failure. */
const DEFAULT_MAX_ATTEMPTS = 2;
/** Bound on claim retries when another worker wins the race. */
const CLAIM_ATTEMPTS = 5;

const TERMINAL_ERROR_MESSAGE = "The job failed unexpectedly. See the job log for details.";

type AbortReason = "cancel" | "timeout";

interface ActiveJob {
  controller: AbortController;
  /** Why we aborted, so the outcome is CANCELLED rather than FAILED. */
  reason: AbortReason | null;
  /** Resolves when the job has been finalised in the database. */
  promise: Promise<void>;
}

interface RunnerState {
  started: boolean;
  draining: boolean;
  /** Set while draining to ask for one more pass once this one finishes. */
  wanted: boolean;
  active: Map<string, ActiveJob>;
  sweep: NodeJS.Timeout | null;
  bootedAt: number;
}

// Next.js can evaluate this module once per route bundle inside one process;
// globalThis is the only scope they share. A symbol key keeps it collision-free.
const RUNNER_KEY = Symbol.for("kiri.jobs.runner.state");

function state(): RunnerState {
  const holder = globalThis as unknown as Record<symbol, RunnerState | undefined>;
  const existing = holder[RUNNER_KEY];
  if (existing) return existing;
  const fresh: RunnerState = {
    started: false,
    draining: false,
    wanted: false,
    active: new Map(),
    sweep: null,
    bootedAt: Date.now(),
  };
  holder[RUNNER_KEY] = fresh;
  return fresh;
}

/* -------------------------------------------------------------------------- */
/* Public surface                                                             */
/* -------------------------------------------------------------------------- */

/** True once {@link startJobRunner} has run in this process. */
export function isRunnerRunning(): boolean {
  return state().started;
}

/** Jobs executing in this process right now. */
export function activeJobCount(): number {
  return state().active.size;
}

/**
 * Abort a job running in this process. Returns false when the job is not ours
 * (another process, or a stale id) — the caller then relies on the
 * `cancelRequestedAt` marker, which the heartbeat picks up within 15 s.
 */
export function abortRunningJob(id: string, reason: AbortReason = "cancel"): boolean {
  const entry = state().active.get(id);
  if (!entry) return false;
  entry.reason ??= reason;
  entry.controller.abort();
  return true;
}

/**
 * Start the runner: recover jobs a previous process left RUNNING, arm the
 * periodic sweep, and drain whatever is queued. Idempotent — safe to call from
 * `instrumentation.ts` on every hot reload.
 */
export async function startJobRunner(): Promise<void> {
  const s = state();
  if (s.started) return;
  s.started = true;
  s.bootedAt = Date.now();

  try {
    const recovered = await recoverStaleJobs({ includeForeignPids: true });
    if (recovered.requeued || recovered.failed) {
      console.log(
        `[jobs] recovered ${recovered.requeued} orphaned job(s), failed ${recovered.failed} ` +
          "that had run out of attempts",
      );
    }
  } catch (error) {
    console.error("[jobs] orphan recovery failed", error);
  }

  const sweep = setInterval(() => {
    void (async () => {
      try {
        await recoverStaleJobs({ includeForeignPids: false });
      } catch (error) {
        console.error("[jobs] stale sweep failed", error);
      }
      triggerJobProcessing();
    })();
  }, SWEEP_INTERVAL_MS);
  sweep.unref?.();
  s.sweep = sweep;

  triggerJobProcessing();
}

/** Stop the periodic sweep (tests, graceful shutdown). Running jobs continue. */
export function stopJobRunner(): void {
  const s = state();
  if (s.sweep) clearInterval(s.sweep);
  s.sweep = null;
  s.started = false;
}

/**
 * Ask the runner to fill its free slots. Fire-and-forget and re-entrant: a
 * call while a drain is in flight schedules one more pass instead of starting
 * a second loop (V1's `triggerRipQueueProcessing`, with slots).
 */
export function triggerJobProcessing(): void {
  const s = state();
  s.wanted = true;
  if (s.draining) return;
  s.draining = true;
  void (async () => {
    try {
      while (s.wanted) {
        s.wanted = false;
        await drainOnce();
      }
    } catch (error) {
      // A transient failure (DB blip) must not silently abandon the queue, and
      // must not spin either: the next trigger or the 60 s sweep retries.
      console.error("[jobs] error while draining the queue", error);
    } finally {
      s.draining = false;
    }
  })();
}

/**
 * Drain the queue and wait until nothing is queued or running in this process.
 * For tests and CLI entry points; the server uses {@link triggerJobProcessing}.
 */
export async function processJobsUntilIdle(options: { timeoutMs?: number } = {}): Promise<void> {
  const { timeoutMs = 60_000 } = options;
  const deadline = Date.now() + timeoutMs;
  const s = state();
  for (;;) {
    await drainOnce();
    const pending = [...s.active.values()].map((entry) => entry.promise);
    if (pending.length > 0) {
      await Promise.race(pending);
      continue;
    }
    // Nothing runs in this runner instance; wait for the database to agree.
    // A job may be RUNNING under another instance (a route's fire-and-forget
    // trigger in a duplicated module graph, or a previous test file's drain),
    // so idle means no QUEUED *and* no RUNNING rows, not just an empty local
    // active map.
    const [queued, running] = await Promise.all([
      prisma.job.count({ where: { status: "QUEUED" } }),
      prisma.job.count({ where: { status: "RUNNING" } }),
    ]);
    if (queued === 0 && running === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `processJobsUntilIdle timed out with ${queued} queued and ${running} running job(s)`,
      );
    }
    await delay(running > 0 ? 50 : 10);
  }
}

/* -------------------------------------------------------------------------- */
/* Stale-job recovery                                                         */
/* -------------------------------------------------------------------------- */

export interface RecoveryResult {
  requeued: number;
  failed: number;
}

/**
 * Re-queue RUNNING jobs that lost their worker. A job qualifies when its
 * heartbeat is older than {@link STALE_LEASE_MS} or — at boot only — when its
 * pid is not this process. Jobs out of attempts are failed with `STALE` so
 * they stop blocking their series.
 */
export async function recoverStaleJobs(
  options: { includeForeignPids?: boolean } = {},
): Promise<RecoveryResult> {
  const cutoff = new Date(Date.now() - STALE_LEASE_MS);
  const staleLease: Prisma.JobWhereInput[] = [
    { heartbeatAt: null },
    { heartbeatAt: { lt: cutoff } },
  ];
  if (options.includeForeignPids) {
    // At boot nothing of ours is running yet, so any pid that is not this
    // process belongs to a container that is gone.
    staleLease.push({ pid: null }, { NOT: { pid: process.pid } });
  }

  const candidates = await prisma.job.findMany({
    where: { status: "RUNNING", OR: staleLease },
    select: { id: true, kind: true, attempt: true },
  });

  const result: RecoveryResult = { requeued: 0, failed: 0 };
  const mine = state().active;
  for (const candidate of candidates) {
    // Never touch a job this process is actually executing: its heartbeat may
    // just be late under load.
    if (mine.has(candidate.id)) continue;
    const maxAttempts = handlerOptions(candidate.kind).maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (candidate.attempt < maxAttempts) {
      const updated = await prisma.job.updateMany({
        where: { id: candidate.id, status: "RUNNING" },
        data: {
          status: "QUEUED",
          startedAt: null,
          heartbeatAt: null,
          pid: null,
          errorCode: "STALE",
          error: "The worker running this job disappeared; it was re-queued.",
        },
      });
      result.requeued += updated.count;
    } else {
      const updated = await prisma.job.updateMany({
        where: { id: candidate.id, status: "RUNNING" },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          pid: null,
          errorCode: "STALE",
          error: "The worker running this job disappeared and it ran out of attempts.",
        },
      });
      result.failed += updated.count;
    }
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Claiming                                                                   */
/* -------------------------------------------------------------------------- */

function handlerOptions(kind: JobKind): JobHandlerOptions {
  return getJobHandler(kind)?.options ?? {};
}

/**
 * Take the oldest QUEUED job. The claim is a conditional `updateMany` on
 * `status: QUEUED`: whoever's UPDATE reports a row won, everyone else loops.
 */
async function claimNextJob(): Promise<JobRecord | null> {
  const s = state();
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const candidate = await prisma.job.findFirst({
      where: {
        status: "QUEUED",
        ...(s.active.size > 0 ? { id: { notIn: [...s.active.keys()] } } : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    if (!candidate) return null;

    const now = new Date();
    const claimed = await prisma.job.updateMany({
      where: { id: candidate.id, status: "QUEUED" },
      data: {
        status: "RUNNING",
        startedAt: now,
        heartbeatAt: now,
        finishedAt: null,
        pid: process.pid,
        attempt: { increment: 1 },
        error: null,
        errorCode: null,
      },
    });
    if (claimed.count === 0) continue;

    const row = await prisma.job.findUnique({
      where: { id: candidate.id },
      select: {
        id: true,
        kind: true,
        seriesId: true,
        sourceId: true,
        pluginId: true,
        requestedById: true,
        attempt: true,
        configJson: true,
      },
    });
    // Deleted between the claim and the read (series cascade): move on.
    if (!row) continue;
    return {
      id: row.id,
      kind: row.kind,
      seriesId: row.seriesId,
      sourceId: row.sourceId,
      pluginId: row.pluginId,
      requestedById: row.requestedById,
      attempt: row.attempt,
      config: toJobConfig(row.configJson),
    };
  }
  return null;
}

/** Fill every free slot. Returns true when at least one job was started. */
async function drainOnce(): Promise<boolean> {
  const s = state();
  const concurrency = getEnv().JOB_CONCURRENCY;
  let started = false;
  while (s.active.size < concurrency) {
    const job = await claimNextJob();
    if (!job) break;
    started = true;
    const controller = new AbortController();
    const entry: ActiveJob = { controller, reason: null, promise: Promise.resolve() };
    // Register before starting so the slot is taken even if executeJob yields
    // on its first await.
    s.active.set(job.id, entry);
    entry.promise = executeJob(job, entry)
      .catch((error: unknown) => {
        console.error(`[jobs] ${job.kind} ${job.id} finaliser failed`, error);
      })
      .finally(() => {
        s.active.delete(job.id);
        // A slot just freed; pick up whatever is waiting.
        triggerJobProcessing();
      });
  }
  return started;
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                  */
/* -------------------------------------------------------------------------- */

interface Outcome {
  status: Extract<JobStatus, "SUCCEEDED" | "FAILED" | "CANCELLED" | "QUEUED">;
  result?: unknown;
  error?: string;
  errorCode?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

class AbortedError extends Error {
  constructor() {
    super("Job aborted");
    this.name = "AbortedError";
  }
}

/** Rejects as soon as `signal` aborts; never resolves. */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new AbortedError());
      return;
    }
    signal.addEventListener("abort", () => reject(new AbortedError()), { once: true });
  });
}

/** JSON-safe copy of a handler's return value; unserialisable input becomes null. */
function toResultJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === undefined || value === null) return Prisma.DbNull;
  try {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  } catch {
    return Prisma.DbNull;
  }
}

async function executeJob(job: JobRecord, entry: ActiveJob): Promise<void> {
  const registration = getJobHandler(job.kind);
  const log = new JobLogBuffer();
  const scratch = jobTmpDir(job.id);

  if (!registration) {
    await finalise(job, entry, log, {
      status: "FAILED",
      errorCode: "NO_HANDLER",
      error: `No handler is registered for ${job.kind} jobs.`,
    });
    return;
  }

  const timeoutMs = registration.options.timeoutMs ?? getEnv().JOB_TIMEOUT_MS;
  const maxAttempts = registration.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  let progress: JobProgress = {};
  let progressDirty = false;
  let lastProgressWrite = 0;

  async function writeProgress(): Promise<void> {
    progressDirty = false;
    lastProgressWrite = Date.now();
    try {
      await prisma.job.updateMany({
        where: { id: job.id, status: "RUNNING" },
        data: {
          progressJson: progress as unknown as Prisma.InputJsonValue,
          heartbeatAt: new Date(),
        },
      });
    } catch (error) {
      console.error(`[jobs] ${job.id} progress write failed`, error);
    }
  }

  async function beat(): Promise<void> {
    try {
      await prisma.job.updateMany({
        where: { id: job.id, status: "RUNNING" },
        data: { heartbeatAt: new Date() },
      });
    } catch (error) {
      console.error(`[jobs] ${job.id} heartbeat failed`, error);
    }
  }

  async function flushLog(): Promise<void> {
    const text = log.take();
    if (text === null) return;
    try {
      await prisma.job.updateMany({ where: { id: job.id }, data: { outputLog: text } });
    } catch (error) {
      console.error(`[jobs] ${job.id} log flush failed`, error);
    }
  }

  const ctx: JobContext = {
    job,
    signal: entry.controller.signal,
    log: (line) => log.append(line),
    progress: async (update) => {
      progress = { ...progress, ...update };
      if (Date.now() - lastProgressWrite < PROGRESS_INTERVAL_MS) {
        progressDirty = true;
        return;
      }
      await writeProgress();
    },
    heartbeat: beat,
    tmpDir: scratch,
  };

  const logTimer = setInterval(() => {
    void flushLog();
    if (progressDirty) void writeProgress();
  }, LOG_FLUSH_INTERVAL_MS);
  logTimer.unref?.();

  // Silent handlers still have to keep their lease, and this is also where a
  // cancel raised through another copy of this module (dev hot reload) or by
  // another process is noticed.
  const heartbeatTimer = setInterval(() => {
    void (async () => {
      await beat();
      const row = await prisma.job
        .findUnique({ where: { id: job.id }, select: { configJson: true, status: true } })
        .catch(() => null);
      if (!row) return;
      if (row.status !== "RUNNING" || toJobConfig(row.configJson).cancelRequestedAt) {
        abortRunningJob(job.id, "cancel");
      }
    })();
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  const timeoutTimer = setTimeout(() => {
    entry.reason ??= "timeout";
    entry.controller.abort();
  }, timeoutMs);
  timeoutTimer.unref?.();

  let outcome: Outcome;
  try {
    await ensureDir(scratch);
    log.append(`${job.kind} started (attempt ${job.attempt})`);
    // Race the abort so a handler that ignores its signal cannot keep the row
    // RUNNING forever. Such a handler is leaked, deliberately: a wedged job
    // that still holds its slot is worse than an orphaned promise.
    const value = await Promise.race([registration.handler(ctx), rejectOnAbort(ctx.signal)]);
    outcome = { status: "SUCCEEDED", result: value };
    log.append("Finished successfully");
  } catch (error) {
    outcome = classifyFailure(error, entry, job, log, timeoutMs, maxAttempts);
  } finally {
    clearTimeout(timeoutTimer);
    clearInterval(logTimer);
    clearInterval(heartbeatTimer);
  }

  await finalise(job, entry, log, outcome, progress);
  try {
    await removeDirSafe(scratch);
  } catch (error) {
    console.error(`[jobs] ${job.id} could not remove its scratch directory`, error);
  }
}

function classifyFailure(
  error: unknown,
  entry: ActiveJob,
  job: JobRecord,
  log: JobLogBuffer,
  timeoutMs: number,
  maxAttempts: number,
): Outcome {
  if (entry.controller.signal.aborted && entry.reason === "timeout") {
    log.append(`Aborted: exceeded the ${timeoutMs} ms time limit`);
    return {
      status: "FAILED",
      errorCode: "TIMEOUT",
      error: `The job exceeded its ${Math.round(timeoutMs / 1000)} s time limit.`,
    };
  }
  if (entry.controller.signal.aborted) {
    log.append("Cancelled");
    return { status: "CANCELLED", errorCode: "CANCELLED", error: "Cancelled." };
  }
  if (error instanceof JobFailure) {
    log.append(`Failed: ${error.code}: ${error.message}`);
    if (error.retryable && job.attempt < maxAttempts) {
      log.append(`Retryable, re-queueing (attempt ${job.attempt} of ${maxAttempts})`);
      return { status: "QUEUED", errorCode: error.code, error: error.message };
    }
    return { status: "FAILED", errorCode: error.code, error: error.message };
  }
  const stack = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[jobs] ${job.kind} ${job.id} threw`, error);
  for (const line of stack.split("\n")) log.append(line);
  return { status: "FAILED", errorCode: "INTERNAL", error: TERMINAL_ERROR_MESSAGE };
}

/**
 * Write the terminal row. `updateMany` rather than `update` so a job whose
 * series was deleted mid-flight is a no-op instead of a P2025.
 */
async function finalise(
  job: JobRecord,
  entry: ActiveJob,
  log: JobLogBuffer,
  outcome: Outcome,
  progress: JobProgress = {},
): Promise<void> {
  const requeue = outcome.status === "QUEUED";
  const data: Prisma.JobUpdateManyMutationInput = {
    status: outcome.status,
    error: outcome.error ?? null,
    errorCode: outcome.errorCode ?? null,
    outputLog: log.value === "" ? null : log.value,
    pid: null,
    progressJson: progress as unknown as Prisma.InputJsonValue,
    ...(requeue
      ? { startedAt: null, heartbeatAt: null, finishedAt: null }
      : { finishedAt: new Date(), resultJson: toResultJson(outcome.result) }),
  };
  try {
    await prisma.job.updateMany({ where: { id: job.id, status: "RUNNING" }, data });
  } catch (error) {
    console.error(`[jobs] ${job.id} could not be finalised`, error);
  }
  log.take();
  entry.reason = null;
}
