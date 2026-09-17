/**
 * Job queue against the database: the one-active-job-per-subject rule, who may
 * see and cancel what, cursor pagination and the runner status summary.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createTestUser, resetDatabase } from "../../../test/factories";
import type { SessionUser } from "@/lib/auth/types";
import type { JobsQuery } from "@/lib/contracts/content";
import {
  cancelJob,
  enqueueJob,
  getJob,
  getRunnerStatus,
  listAllJobs,
  listJobs,
} from "@/lib/jobs/queue";
import { prisma } from "@/lib/prisma";

function query(overrides: Partial<JobsQuery> = {}): JobsQuery {
  return { limit: 20, ...overrides };
}

async function seedSeries(
  user: SessionUser,
  overrides: { title?: string; visibility?: "SHARED" | "PRIVATE"; isAdult?: boolean } = {},
): Promise<string> {
  const title = overrides.title ?? `Series ${Math.random().toString(36).slice(2, 8)}`;
  const series = await prisma.series.create({
    data: {
      title,
      sortTitle: title.toLowerCase(),
      createdById: user.id,
      visibility: overrides.visibility ?? "SHARED",
      isAdult: overrides.isAdult ?? false,
    },
  });
  return series.id;
}

beforeEach(async () => {
  await resetDatabase();
});

describe("enqueueJob", () => {
  it("creates a QUEUED job carrying its config", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);

    const job = await enqueueJob({
      kind: "MANUAL_UPLOAD",
      seriesId,
      requestedById: user.id,
      config: { seriesId, uploadIds: ["u1"], kind: "archive" },
    });

    expect(job.status).toBe("QUEUED");
    expect(job.attempt).toBe(0);
    expect(job.configJson).toMatchObject({ kind: "archive" });
  });

  it("refuses a second active job of the same kind for the same series", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    await enqueueJob({ kind: "MANUAL_UPLOAD", seriesId, requestedById: user.id });

    await expect(
      enqueueJob({ kind: "MANUAL_UPLOAD", seriesId, requestedById: user.id }),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
  });

  it("allows a different kind on the same series, and the same kind elsewhere", async () => {
    const user = await createTestUser();
    const a = await seedSeries(user);
    const b = await seedSeries(user);
    await enqueueJob({ kind: "MANUAL_UPLOAD", seriesId: a, requestedById: user.id });

    await expect(
      enqueueJob({ kind: "OPTIMIZE", seriesId: a, requestedById: user.id }),
    ).resolves.toMatchObject({ status: "QUEUED" });
    await expect(
      enqueueJob({ kind: "MANUAL_UPLOAD", seriesId: b, requestedById: user.id }),
    ).resolves.toMatchObject({ status: "QUEUED" });
  });

  it("does not dedupe against a finished job", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    const first = await enqueueJob({ kind: "OPTIMIZE", seriesId, requestedById: user.id });
    await prisma.job.update({
      where: { id: first.id },
      data: { status: "SUCCEEDED", finishedAt: new Date() },
    });

    await expect(
      enqueueJob({ kind: "OPTIMIZE", seriesId, requestedById: user.id }),
    ).resolves.toMatchObject({ status: "QUEUED" });
  });

  it("keys PLUGIN_INSTALL by plugin, not by series", async () => {
    const user = await createTestUser();
    await enqueueJob({ kind: "PLUGIN_INSTALL", pluginId: "mangadex", requestedById: user.id });

    await expect(
      enqueueJob({ kind: "PLUGIN_INSTALL", pluginId: "mangadex", requestedById: user.id }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      enqueueJob({ kind: "PLUGIN_INSTALL", pluginId: "other", requestedById: user.id }),
    ).resolves.toMatchObject({ status: "QUEUED" });
  });

  it("allows only one V1_IMPORT for the whole instance", async () => {
    const user = await createTestUser();
    await enqueueJob({ kind: "V1_IMPORT", requestedById: user.id });

    await expect(enqueueJob({ kind: "V1_IMPORT", requestedById: user.id })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("reclaims a RUNNING job whose lease expired instead of blocking forever", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    const wedged = await enqueueJob({ kind: "OPTIMIZE", seriesId, requestedById: user.id });
    await prisma.job.update({
      where: { id: wedged.id },
      data: {
        status: "RUNNING",
        startedAt: new Date(Date.now() - 60 * 60 * 1000),
        heartbeatAt: new Date(Date.now() - 60 * 60 * 1000),
        pid: 999_999,
      },
    });

    const replacement = await enqueueJob({ kind: "OPTIMIZE", seriesId, requestedById: user.id });

    expect(replacement.status).toBe("QUEUED");
    const reclaimed = await prisma.job.findUniqueOrThrow({ where: { id: wedged.id } });
    expect(reclaimed.status).toBe("FAILED");
    expect(reclaimed.errorCode).toBe("STALE");
  });
});

describe("listJobs", () => {
  it("shows a user their own jobs and jobs on series they can see", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const shared = await seedSeries(owner, { visibility: "SHARED" });
    const secret = await seedSeries(owner, { visibility: "PRIVATE" });
    const onShared = await enqueueJob({
      kind: "OPTIMIZE",
      seriesId: shared,
      requestedById: owner.id,
    });
    const onSecret = await enqueueJob({
      kind: "OPTIMIZE",
      seriesId: secret,
      requestedById: owner.id,
    });
    const theirOwn = await enqueueJob({ kind: "V1_IMPORT", requestedById: other.id });

    const mine = await listJobs(owner, query());
    const theirs = await listJobs(other, query());

    // The owner sees both of their series' jobs, not the other user's
    // series-less V1_IMPORT.
    expect(mine.items.map((job) => job.id).sort()).toEqual([onShared.id, onSecret.id].sort());
    // A bystander sees their own job and the one on the shared series, but the
    // private series' job does not exist as far as they are concerned.
    expect(theirs.items.map((job) => job.id).sort()).toEqual([theirOwn.id, onShared.id].sort());
    expect(theirs.items.map((job) => job.id)).not.toContain(onSecret.id);
  });

  it("hides jobs on an adult series from a user who opted out", async () => {
    const owner = await createTestUser();
    const prude = await createTestUser({ showAdult: false });
    const adult = await seedSeries(owner, { isAdult: true });
    await enqueueJob({ kind: "OPTIMIZE", seriesId: adult, requestedById: owner.id });

    expect((await listJobs(prude, query())).items).toHaveLength(0);
    const curious = await createTestUser({ showAdult: true });
    expect((await listJobs(curious, query())).items).toHaveLength(1);
  });

  it("filters by series, kind and active status", async () => {
    const user = await createTestUser();
    const a = await seedSeries(user);
    const b = await seedSeries(user);
    await enqueueJob({ kind: "OPTIMIZE", seriesId: a, requestedById: user.id });
    const done = await enqueueJob({ kind: "MANUAL_UPLOAD", seriesId: b, requestedById: user.id });
    await prisma.job.update({ where: { id: done.id }, data: { status: "SUCCEEDED" } });

    expect((await listJobs(user, query({ seriesId: a }))).items).toHaveLength(1);
    expect((await listJobs(user, query({ kind: "MANUAL_UPLOAD" }))).items).toHaveLength(1);
    expect((await listJobs(user, query({ status: "active" }))).items).toHaveLength(1);
    expect((await listJobs(user, query({ status: "SUCCEEDED" }))).items).toHaveLength(1);
  });

  it("pages with a cursor and never repeats a row", async () => {
    const user = await createTestUser();
    for (let i = 0; i < 5; i += 1) {
      const seriesId = await seedSeries(user, { title: `Paged ${i}` });
      await enqueueJob({ kind: "OPTIMIZE", seriesId, requestedById: user.id });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const page: Awaited<ReturnType<typeof listJobs>> = await listJobs(
        user,
        query({ limit: 2, ...(cursor ? { cursor } : {}) }),
      );
      seen.push(...page.items.map((job) => job.id));
      cursor = page.nextCursor;
      guard += 1;
    } while (cursor && guard < 10);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("listAllJobs ignores visibility", async () => {
    const owner = await createTestUser();
    const admin = await createTestUser({ role: "admin" });
    const secret = await seedSeries(owner, { visibility: "PRIVATE" });
    await enqueueJob({ kind: "OPTIMIZE", seriesId: secret, requestedById: owner.id });

    expect((await listAllJobs(query())).items).toHaveLength(1);
    // Even an admin does not see it through the member-facing list.
    expect((await listJobs(admin, query())).items).toHaveLength(0);
  });
});

describe("getJob", () => {
  it("is a 404, not a 403, for a job the caller may not see", async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const secret = await seedSeries(owner, { visibility: "PRIVATE" });
    const job = await enqueueJob({ kind: "OPTIMIZE", seriesId: secret, requestedById: owner.id });

    await expect(getJob(stranger, job.id)).rejects.toMatchObject({ status: 404 });
    await expect(getJob(owner, job.id)).resolves.toMatchObject({ id: job.id });
  });
});

describe("cancelJob", () => {
  it("cancels a QUEUED job outright", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    const job = await enqueueJob({ kind: "OPTIMIZE", seriesId, requestedById: user.id });

    const cancelled = await cancelJob(user, job.id);

    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.errorCode).toBe("CANCELLED");
    expect(cancelled.finishedAt).not.toBeNull();
  });

  it("is idempotent", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    const job = await enqueueJob({ kind: "OPTIMIZE", seriesId, requestedById: user.id });
    await cancelJob(user, job.id);

    await expect(cancelJob(user, job.id)).resolves.toMatchObject({ status: "CANCELLED" });
  });

  it("marks a RUNNING job for cancellation without waiting for the worker", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    const job = await enqueueJob({ kind: "OPTIMIZE", seriesId, requestedById: user.id });
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "RUNNING", startedAt: new Date(), heartbeatAt: new Date() },
    });

    const view = await cancelJob(user, job.id);

    expect(view.status).toBe("RUNNING");
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.configJson).toMatchObject({ cancelRequestedAt: expect.any(String) });
  });

  it("lets the series creator and an admin cancel, but not a bystander", async () => {
    const creator = await createTestUser();
    const requester = await createTestUser();
    const admin = await createTestUser({ role: "admin" });
    const bystander = await createTestUser();
    const seriesId = await seedSeries(creator);

    const byCreator = await enqueueJob({ kind: "OPTIMIZE", seriesId, requestedById: requester.id });
    await expect(cancelJob(creator, byCreator.id)).resolves.toMatchObject({ status: "CANCELLED" });

    const forAdmin = await enqueueJob({ kind: "OPTIMIZE", seriesId, requestedById: requester.id });
    await expect(cancelJob(admin, forAdmin.id)).resolves.toMatchObject({ status: "CANCELLED" });

    const forBystander = await enqueueJob({
      kind: "OPTIMIZE",
      seriesId,
      requestedById: requester.id,
    });
    await expect(cancelJob(bystander, forBystander.id)).rejects.toMatchObject({ status: 403 });
  });

  it("refuses to cancel a job that already succeeded", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    const job = await enqueueJob({ kind: "OPTIMIZE", seriesId, requestedById: user.id });
    await prisma.job.update({ where: { id: job.id }, data: { status: "SUCCEEDED" } });

    await expect(cancelJob(user, job.id)).rejects.toMatchObject({ status: 409 });
  });
});

describe("getRunnerStatus", () => {
  it("counts the queue and reports the newest heartbeat", async () => {
    const user = await createTestUser();
    const a = await seedSeries(user);
    const b = await seedSeries(user);
    await enqueueJob({ kind: "OPTIMIZE", seriesId: a, requestedById: user.id });
    const running = await enqueueJob({ kind: "OPTIMIZE", seriesId: b, requestedById: user.id });
    const beat = new Date("2026-02-02T00:00:00.000Z");
    await prisma.job.update({
      where: { id: running.id },
      data: { status: "RUNNING", startedAt: beat, heartbeatAt: beat },
    });

    const status = await getRunnerStatus();

    expect(status.queuedJobs).toBe(1);
    expect(status.activeJobs).toBe(1);
    expect(status.lastHeartbeatAt).toBe(beat.toISOString());
    expect(status.concurrency).toBeGreaterThanOrEqual(1);
  });
});
