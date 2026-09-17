/**
 * Prisma `Job` rows -> the `JobView` wire shape, plus the opaque cursor the
 * job lists page with.
 *
 * Same rule as `src/lib/series/serialize.ts`: dates become ISO strings here
 * and nowhere else, so `src/lib/contracts/content.ts` is the only description
 * of the wire format the client needs.
 */
import type { Job, Prisma } from "@/generated/prisma/client";
import type { JobKind, JobProgress, JobStatus, JobView } from "@/lib/contracts/content";

/** `include` that fills `JobView.requestedBy` in one query. */
export const jobInclude = {
  requestedBy: { select: { id: true, displayName: true } },
} satisfies Prisma.JobInclude;

/** A job row loaded with {@link jobInclude}. */
export interface JobRow extends Job {
  requestedBy: { id: string; displayName: string } | null;
}

/** Progress JSON is written by us, but a hand-edited row must not crash a list. */
export function toJobProgress(value: Prisma.JsonValue | null | undefined): JobProgress {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const progress: JobProgress = {};
  if (typeof raw.phase === "string") progress.phase = raw.phase;
  if (typeof raw.current === "number") progress.current = raw.current;
  if (typeof raw.total === "number") progress.total = raw.total;
  if (typeof raw.message === "string") progress.message = raw.message;
  if (typeof raw.chapterSlug === "string") progress.chapterSlug = raw.chapterSlug;
  return progress;
}

/** `Job.configJson` as a plain object; anything else reads as empty. */
export function toJobConfig(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

export function toJobView(row: JobRow): JobView {
  return {
    id: row.id,
    kind: row.kind as JobKind,
    status: row.status as JobStatus,
    seriesId: row.seriesId,
    sourceId: row.sourceId,
    pluginId: row.pluginId,
    requestedBy: row.requestedBy
      ? { id: row.requestedBy.id, displayName: row.requestedBy.displayName }
      : null,
    progress: toJobProgress(row.progressJson),
    result: row.resultJson ?? null,
    error: row.error,
    errorCode: row.errorCode,
    attempt: row.attempt,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Cursor                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Keyset cursor over `(createdAt desc, id desc)` — the job list's only sort.
 * base64url JSON, opaque on purpose, same encoding as the library cursor.
 */
export interface JobCursor {
  /** `createdAt` of the last row of the previous page, ISO. */
  createdAt: string;
  /** Its id, the stable tie-break for jobs enqueued in the same millisecond. */
  id: string;
}

export function encodeJobCursor(cursor: JobCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Returns null for anything this module did not produce. */
export function decodeJobCursor(raw: string): JobCursor | null {
  if (raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { createdAt, id } = parsed as { createdAt?: unknown; id?: unknown };
  if (typeof createdAt !== "string" || typeof id !== "string" || id === "") return null;
  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime())) return null;
  return { createdAt, id };
}
