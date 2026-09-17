/**
 * Job queue: everything that reads or writes a `Job` row from outside the
 * runner — enqueue, cancel, list, and the runner-health summary the admin
 * dashboard polls.
 *
 * Two rules shape this module:
 *
 *  - **One active job per subject.** V1 refused to queue a second rip for a
 *    series that already had one; the same holds here, keyed per kind by the
 *    thing the job acts on (series, source, plugin, or the instance itself for
 *    V1_IMPORT). A wedged RUNNING job whose lease has expired is reclaimed
 *    first, so a dead worker can never block a series forever.
 *  - **Cancel is two-sided.** A QUEUED job flips to CANCELLED in the database
 *    and never runs. A RUNNING job gets a `cancelRequestedAt` marker inside
 *    `configJson` (no schema change) *and* an in-process `AbortController`
 *    abort; whichever the worker sees first wins, and the marker is what makes
 *    cancellation work across a dev-mode module duplicate or a restart.
 */
import { Prisma } from "@/generated/prisma/client";
import type { Job, JobKind } from "@/generated/prisma/client";
import { conflict, forbidden, notFound } from "@/lib/api";
import { isAdmin, type SessionUser } from "@/lib/auth/types";
import { visibleSeriesWhere } from "@/lib/authz";
import type { JobRunnerStatus, JobsPage, JobsQuery, JobView } from "@/lib/contracts/content";
import { getEnv } from "@/lib/env";
import {
  decodeJobCursor,
  encodeJobCursor,
  jobInclude,
  toJobConfig,
  toJobView,
  type JobRow,
} from "@/lib/jobs/serialize";
import {
  abortRunningJob,
  activeJobCount,
  isRunnerRunning,
  STALE_LEASE_MS,
} from "@/lib/jobs/runner";
import { prisma } from "@/lib/prisma";

const ACTIVE_STATUSES = ["QUEUED", "RUNNING"] as const;

export interface EnqueueJobInput {
  kind: JobKind;
  seriesId?: string | null;
  sourceId?: string | null;
  pluginId?: string | null;
  requestedById?: string | null;
  /** Handler-specific configuration; stored verbatim as `Job.configJson`. */
  config?: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Enqueue                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The subject that may only have one active job of a given kind at a time.
 * PLUGIN_INSTALL is keyed by plugin, V1_IMPORT is instance-wide, everything
 * else is keyed by its source when it has one and by its series otherwise.
 */
function dedupeWhere(input: EnqueueJobInput): Prisma.JobWhereInput {
  const base: Prisma.JobWhereInput = { kind: input.kind, status: { in: [...ACTIVE_STATUSES] } };
  if (input.kind === "V1_IMPORT") return base;
  if (input.kind === "PLUGIN_INSTALL") return { ...base, pluginId: input.pluginId ?? null };
  if (input.sourceId) return { ...base, sourceId: input.sourceId };
  if (input.seriesId) return { ...base, seriesId: input.seriesId };
  return base;
}

function describeSubject(input: EnqueueJobInput): string {
  if (input.kind === "V1_IMPORT") return "this instance";
  if (input.kind === "PLUGIN_INSTALL") return "that plugin";
  if (input.sourceId || input.seriesId) return "this series";
  return "this instance";
}

/**
 * Create a QUEUED job, or throw 409 when one of the same kind is already
 * active for the same subject. The caller triggers processing; enqueue itself
 * stays a pure database write so it is safe inside a transaction-less route.
 */
export async function enqueueJob(input: EnqueueJobInput): Promise<Job> {
  const existing = await prisma.job.findFirst({
    where: dedupeWhere(input),
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, heartbeatAt: true, startedAt: true, createdAt: true },
  });

  if (existing) {
    const leaseAt = existing.heartbeatAt ?? existing.startedAt ?? existing.createdAt;
    const leaseExpired =
      existing.status === "RUNNING" && Date.now() - leaseAt.getTime() > STALE_LEASE_MS;
    if (!leaseExpired) {
      throw conflict(
        `A ${input.kind} job is already queued or running for ${describeSubject(input)}.`,
      );
    }
    // Wedged: its worker is gone. Fail it here rather than making the user wait
    // for the next sweep (V1 did the same inside enqueueRipJob).
    await prisma.job.updateMany({
      where: { id: existing.id, status: "RUNNING" },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        pid: null,
        errorCode: "STALE",
        error: "The worker running this job disappeared; it was reclaimed as stale.",
      },
    });
  }

  return prisma.job.create({
    data: {
      kind: input.kind,
      status: "QUEUED",
      seriesId: input.seriesId ?? null,
      sourceId: input.sourceId ?? null,
      pluginId: input.pluginId ?? null,
      requestedById: input.requestedById ?? null,
      configJson: (input.config ?? {}) as Prisma.InputJsonValue,
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Jobs a user may see: the ones they asked for, plus every job attached to a
 * series they can view. A job with neither (a plugin install someone else
 * started) stays admin-only.
 */
function visibleJobsWhere(user: SessionUser): Prisma.JobWhereInput {
  return {
    OR: [{ requestedById: user.id }, { series: { is: visibleSeriesWhere(user) } }],
  };
}

function filtersFrom(query: JobsQuery): Prisma.JobWhereInput[] {
  const filters: Prisma.JobWhereInput[] = [];
  if (query.seriesId) filters.push({ seriesId: query.seriesId });
  if (query.kind) filters.push({ kind: query.kind });
  if (query.status === "active") {
    filters.push({ status: { in: [...ACTIVE_STATUSES] } });
  } else if (query.status) {
    filters.push({ status: query.status });
  }
  const cursor = query.cursor ? decodeJobCursor(query.cursor) : null;
  if (cursor) {
    // Keyset on (createdAt desc, id desc): strictly older, or same instant with
    // a smaller id.
    const at = new Date(cursor.createdAt);
    filters.push({
      OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }],
    });
  }
  return filters;
}

async function selectPage(where: Prisma.JobWhereInput, limit: number): Promise<JobsPage> {
  const rows = (await prisma.job.findMany({
    where,
    include: jobInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  })) as JobRow[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    items: page.map(toJobView),
    nextCursor:
      hasMore && last
        ? encodeJobCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
  };
}

/** GET /api/jobs — own jobs plus jobs on series the user can view. */
export async function listJobs(user: SessionUser, query: JobsQuery): Promise<JobsPage> {
  return selectPage({ AND: [visibleJobsWhere(user), ...filtersFrom(query)] }, query.limit);
}

/** GET /api/admin/jobs — every job on the instance. */
export async function listAllJobs(query: JobsQuery): Promise<JobsPage> {
  const filters = filtersFrom(query);
  return selectPage(filters.length > 0 ? { AND: filters } : {}, query.limit);
}

async function loadJobFor(user: SessionUser, id: string): Promise<JobRow> {
  const row = (await prisma.job.findFirst({
    where: { id, ...(isAdmin(user) ? {} : visibleJobsWhere(user)) },
    include: jobInclude,
  })) as JobRow | null;
  if (!row) throw notFound("Job");
  return row;
}

/** GET /api/jobs/:id. 404 for a job the user may not see, never 403. */
export async function getJob(user: SessionUser, id: string): Promise<JobView> {
  return toJobView(await loadJobFor(user, id));
}

/* -------------------------------------------------------------------------- */
/* Cancel                                                                     */
/* -------------------------------------------------------------------------- */

async function assertCanCancel(user: SessionUser, row: JobRow): Promise<void> {
  if (isAdmin(user)) return;
  if (row.requestedById === user.id) return;
  if (row.seriesId) {
    const series = await prisma.series.findUnique({
      where: { id: row.seriesId },
      select: { createdById: true },
    });
    if (series?.createdById === user.id) return;
  }
  throw forbidden(
    "Only the person who started this job, the series creator or an admin can cancel it",
  );
}

/**
 * Cancel a job. QUEUED jobs never run; a RUNNING job is asked to stop through
 * both channels (marker + AbortController) and finalises itself as CANCELLED.
 * Cancelling an already-cancelled job is a no-op, not an error.
 */
export async function cancelJob(user: SessionUser, id: string): Promise<JobView> {
  const row = await loadJobFor(user, id);
  await assertCanCancel(user, row);

  if (row.status === "CANCELLED") return toJobView(row);
  if (row.status === "SUCCEEDED" || row.status === "FAILED") {
    throw conflict(`This job already finished (${row.status.toLowerCase()}).`);
  }

  if (row.status === "QUEUED") {
    const stopped = await prisma.job.updateMany({
      where: { id, status: "QUEUED" },
      data: {
        status: "CANCELLED",
        finishedAt: new Date(),
        errorCode: "CANCELLED",
        error: "Cancelled before it started.",
      },
    });
    if (stopped.count > 0) return getJob(user, id);
    // Lost the race — it started while we were deciding. Fall through.
  }

  // RUNNING: leave a marker the worker sees on its next heartbeat even if it
  // lives in another module copy or another process, then abort in-process.
  await prisma.job.updateMany({
    where: { id, status: "RUNNING" },
    data: {
      configJson: {
        ...toJobConfig(row.configJson),
        cancelRequestedAt: new Date().toISOString(),
      } as Prisma.InputJsonValue,
    },
  });
  abortRunningJob(id, "cancel");
  return getJob(user, id);
}

/* -------------------------------------------------------------------------- */
/* Runner status                                                              */
/* -------------------------------------------------------------------------- */

/** GET /api/admin/jobs/status — is the worker alive and how deep is the queue. */
export async function getRunnerStatus(): Promise<JobRunnerStatus> {
  const [running, queued, newest] = await Promise.all([
    prisma.job.count({ where: { status: "RUNNING" } }),
    prisma.job.count({ where: { status: "QUEUED" } }),
    prisma.job.findFirst({
      where: { status: "RUNNING", heartbeatAt: { not: null } },
      orderBy: { heartbeatAt: "desc" },
      select: { heartbeatAt: true },
    }),
  ]);
  return {
    running: isRunnerRunning(),
    activeJobs: Math.max(running, activeJobCount()),
    queuedJobs: queued,
    lastHeartbeatAt: newest?.heartbeatAt?.toISOString() ?? null,
    concurrency: getEnv().JOB_CONCURRENCY,
  };
}
