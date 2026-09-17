/**
 * The runner end to end against the database: claim, progress, log, cancel,
 * timeout, retry and stale-lease recovery.
 *
 * Handlers are registered inside the tests (never `@/lib/jobs/handlers`), so
 * this file exercises the runner and nothing else. Each test registers the
 * kind it uses, so the registry can be re-used across cases without leaking
 * options between them.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestUser, resetDatabase } from "../../../test/factories";
import type { JobKind } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/types";
import { resetEnvCache } from "@/lib/env";
import { cancelJob, enqueueJob } from "@/lib/jobs/queue";
import {
  activeJobCount,
  isRunnerRunning,
  processJobsUntilIdle,
  recoverStaleJobs,
  startJobRunner,
  stopJobRunner,
} from "@/lib/jobs/runner";
import {
  JobFailure,
  registerJobHandler,
  type JobContext,
  type JobHandler,
  type JobHandlerOptions,
} from "@/lib/jobs/types";
import { prisma } from "@/lib/prisma";

let dataRoot: string;

beforeAll(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "kiri-runner-"));
  process.env.DATA_ROOT = dataRoot;
  resetEnvCache();
});

afterAll(() => {
  stopJobRunner();
  rmSync(dataRoot, { recursive: true, force: true });
  resetEnvCache();
});

beforeEach(async () => {
  await resetDatabase();
});

function useHandler(kind: JobKind, handler: JobHandler, options: JobHandlerOptions = {}): void {
  registerJobHandler(kind, handler, options);
}

/**
 * Run `fn` with `kind` temporarily missing from the handler registry.
 *
 * Every JobKind has a real handler now (src/lib/jobs/handlers/index.ts), so
 * "nobody registered this kind" can only be staged by reaching into the same
 * globalThis map `registerJobHandler` writes to, and putting it back after.
 */
async function withoutHandler(kind: JobKind, fn: () => Promise<void>): Promise<void> {
  const registry = (globalThis as unknown as Record<symbol, Map<JobKind, unknown> | undefined>)[
    Symbol.for("kiri.jobs.handlerRegistry")
  ];
  const saved = registry?.get(kind);
  registry?.delete(kind);
  try {
    await fn();
  } finally {
    if (registry && saved !== undefined) registry.set(kind, saved);
  }
}

async function seedSeries(user: SessionUser): Promise<string> {
  const title = `Runner ${Math.random().toString(36).slice(2, 8)}`;
  const series = await prisma.series.create({
    data: { title, sortTitle: title.toLowerCase(), createdById: user.id },
  });
  return series.id;
}

/** A promise plus the function that settles it, for handler/test rendezvous. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("running a job", () => {
  it("claims it, runs it and stores the result", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    useHandler("INGEST_MANIFEST", async (ctx: JobContext) => {
      ctx.log("doing the thing");
      return { chapters: 3, jobId: ctx.job.id };
    });
    const job = await enqueueJob({ kind: "INGEST_MANIFEST", seriesId, requestedById: user.id });

    await processJobsUntilIdle();

    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("SUCCEEDED");
    expect(row.attempt).toBe(1);
    expect(row.pid).toBeNull();
    expect(row.startedAt).not.toBeNull();
    expect(row.finishedAt).not.toBeNull();
    expect(row.resultJson).toEqual({ chapters: 3, jobId: job.id });
    expect(row.outputLog ?? "").toContain("doing the thing");
    expect(row.error).toBeNull();
  });

  it("hands the handler the job's config, attempt and a scratch directory", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    let seen: { config: unknown; attempt: number; tmpDir: string } | null = null;
    useHandler("INGEST_MANIFEST", async (ctx: JobContext) => {
      seen = { config: ctx.job.config, attempt: ctx.job.attempt, tmpDir: ctx.tmpDir };
      expect(existsSync(ctx.tmpDir)).toBe(true);
      return null;
    });
    await enqueueJob({
      kind: "INGEST_MANIFEST",
      seriesId,
      requestedById: user.id,
      config: { hello: "world" },
    });

    await processJobsUntilIdle();

    expect(seen).not.toBeNull();
    const captured = seen as unknown as { config: unknown; attempt: number; tmpDir: string };
    expect(captured.config).toEqual({ hello: "world" });
    expect(captured.attempt).toBe(1);
    // The scratch directory is removed once the job ends.
    expect(existsSync(captured.tmpDir)).toBe(false);
  });

  it("persists progress the handler reports", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    useHandler("INGEST_MANIFEST", async (ctx: JobContext) => {
      await ctx.progress({ phase: "store", current: 1, total: 4, message: "001.jpg" });
      return null;
    });
    const job = await enqueueJob({ kind: "INGEST_MANIFEST", seriesId, requestedById: user.id });

    await processJobsUntilIdle();

    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.progressJson).toEqual({
      phase: "store",
      current: 1,
      total: 4,
      message: "001.jpg",
    });
  });

  it("fails a kind nobody registered instead of leaving it queued", async () => {
    const user = await createTestUser();
    await withoutHandler("PLUGIN_INSTALL", async () => {
      const job = await enqueueJob({
        kind: "PLUGIN_INSTALL",
        pluginId: "ghost",
        requestedById: user.id,
      });

      await processJobsUntilIdle();

      const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      expect(row.status).toBe("FAILED");
      expect(row.errorCode).toBe("NO_HANDLER");
    });
  });

  it("masks an unexpected error but keeps the stack in the log", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    useHandler("INGEST_MANIFEST", async () => {
      throw new Error("secret internal detail");
    });
    const job = await enqueueJob({ kind: "INGEST_MANIFEST", seriesId, requestedById: user.id });

    await processJobsUntilIdle();

    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("FAILED");
    expect(row.errorCode).toBe("INTERNAL");
    expect(row.error).not.toContain("secret internal detail");
    expect(row.outputLog ?? "").toContain("secret internal detail");
  });
});

describe("failure handling", () => {
  it("reports a JobFailure verbatim", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    useHandler("INGEST_MANIFEST", async () => {
      throw new JobFailure("NO_IMAGES", "No readable images were found");
    });
    const job = await enqueueJob({ kind: "INGEST_MANIFEST", seriesId, requestedById: user.id });

    await processJobsUntilIdle();

    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("FAILED");
    expect(row.errorCode).toBe("NO_IMAGES");
    expect(row.error).toBe("No readable images were found");
  });

  it("re-queues a retryable failure and gives up at maxAttempts", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    let calls = 0;
    useHandler(
      "SOURCE_VERIFY",
      async () => {
        calls += 1;
        throw new JobFailure("NETWORK", "the site hung up", { retryable: true });
      },
      { maxAttempts: 2 },
    );
    const job = await enqueueJob({ kind: "SOURCE_VERIFY", seriesId, requestedById: user.id });

    await processJobsUntilIdle();

    expect(calls).toBe(2);
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("FAILED");
    expect(row.attempt).toBe(2);
    expect(row.errorCode).toBe("NETWORK");
  });

  it("does not retry a plain failure", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    let calls = 0;
    useHandler(
      "SOURCE_VERIFY",
      async () => {
        calls += 1;
        throw new JobFailure("INVALID_ARCHIVE", "not a zip");
      },
      { maxAttempts: 3 },
    );
    await enqueueJob({ kind: "SOURCE_VERIFY", seriesId, requestedById: user.id });

    await processJobsUntilIdle();

    expect(calls).toBe(1);
  });
});

describe("cancellation and timeouts", () => {
  it("cancels a RUNNING job through the abort signal", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    const started = deferred();
    useHandler("SOURCE_SYNC", async (ctx: JobContext) => {
      started.resolve();
      await new Promise<never>((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return null;
    });
    const job = await enqueueJob({ kind: "SOURCE_SYNC", seriesId, requestedById: user.id });

    const draining = processJobsUntilIdle({ timeoutMs: 15_000 });
    await started.promise;
    await cancelJob(user, job.id);
    await draining;

    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("CANCELLED");
    expect(row.errorCode).toBe("CANCELLED");
    expect(row.finishedAt).not.toBeNull();
  });

  it("fails a job that outstays its handler timeout", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    useHandler(
      "SOURCE_SYNC",
      async () =>
        // Deliberately ignores the signal: the runner must still finalise it.
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 10_000);
          timer.unref?.();
        }),
      { timeoutMs: 100, maxAttempts: 1 },
    );
    const job = await enqueueJob({ kind: "SOURCE_SYNC", seriesId, requestedById: user.id });

    await processJobsUntilIdle({ timeoutMs: 15_000 });

    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("FAILED");
    expect(row.errorCode).toBe("TIMEOUT");
  });
});

describe("stale-lease recovery", () => {
  it("re-queues a job whose worker vanished and fails one out of attempts", async () => {
    const user = await createTestUser();
    const seriesA = await seedSeries(user);
    const seriesB = await seedSeries(user);
    const long = new Date(Date.now() - 60 * 60 * 1000);

    const retryable = await enqueueJob({
      kind: "INGEST_MANIFEST",
      seriesId: seriesA,
      requestedById: user.id,
    });
    const exhausted = await enqueueJob({
      kind: "INGEST_MANIFEST",
      seriesId: seriesB,
      requestedById: user.id,
    });
    await prisma.job.updateMany({
      where: { id: retryable.id },
      data: { status: "RUNNING", startedAt: long, heartbeatAt: long, pid: 999_999, attempt: 1 },
    });
    await prisma.job.updateMany({
      where: { id: exhausted.id },
      data: { status: "RUNNING", startedAt: long, heartbeatAt: long, pid: 999_999, attempt: 2 },
    });

    const result = await recoverStaleJobs({ includeForeignPids: true });

    expect(result).toEqual({ requeued: 1, failed: 1 });
    const dead = await prisma.job.findUniqueOrThrow({ where: { id: exhausted.id } });
    expect(dead.status).toBe("FAILED");
    expect(dead.errorCode).toBe("STALE");
    expect(dead.finishedAt).not.toBeNull();
  });

  it("leaves a job with a fresh heartbeat alone", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    const alive = await enqueueJob({
      kind: "INGEST_MANIFEST",
      seriesId,
      requestedById: user.id,
    });
    await prisma.job.updateMany({
      where: { id: alive.id },
      data: {
        status: "RUNNING",
        startedAt: new Date(),
        heartbeatAt: new Date(),
        pid: process.pid,
      },
    });

    expect(await recoverStaleJobs({ includeForeignPids: true })).toEqual({
      requeued: 0,
      failed: 0,
    });
  });

  it("only reclaims foreign pids at boot, not on the periodic sweep", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    const other = await enqueueJob({
      kind: "INGEST_MANIFEST",
      seriesId,
      requestedById: user.id,
    });
    await prisma.job.updateMany({
      where: { id: other.id },
      data: {
        status: "RUNNING",
        startedAt: new Date(),
        heartbeatAt: new Date(),
        pid: 999_999,
      },
    });

    expect(await recoverStaleJobs()).toEqual({ requeued: 0, failed: 0 });
    expect(await recoverStaleJobs({ includeForeignPids: true })).toEqual({
      requeued: 1,
      failed: 0,
    });
  });
});

describe("startJobRunner", () => {
  it("is idempotent and recovers orphans on the way up", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    useHandler("INGEST_MANIFEST", async () => ({ ok: true }));
    const orphan = await enqueueJob({
      kind: "INGEST_MANIFEST",
      seriesId,
      requestedById: user.id,
    });
    const long = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.job.updateMany({
      where: { id: orphan.id },
      data: { status: "RUNNING", startedAt: long, heartbeatAt: long, pid: 999_999, attempt: 1 },
    });

    try {
      await startJobRunner();
      expect(isRunnerRunning()).toBe(true);
      // A second call must not arm a second sweep or re-run recovery.
      await startJobRunner();
      await processJobsUntilIdle({ timeoutMs: 15_000 });
    } finally {
      stopJobRunner();
    }

    const row = await prisma.job.findUniqueOrThrow({ where: { id: orphan.id } });
    expect(row.status).toBe("SUCCEEDED");
    expect(row.attempt).toBe(2);
    expect(activeJobCount()).toBe(0);
    expect(isRunnerRunning()).toBe(false);
  });
});
