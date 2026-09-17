/**
 * Job runner contract. Handlers are registered per JobKind and executed by
 * src/lib/jobs/runner.ts. This file is the seam between the runner and the
 * feature modules that implement handlers (manual upload, PDF import,
 * optimizer, plugin sync, V1 import), so it stays dependency-free.
 */
import type { JobKind } from "@/generated/prisma/client";
import type { JobProgress } from "@/lib/contracts/content";

export interface JobRecord {
  id: string;
  kind: JobKind;
  seriesId: string | null;
  sourceId: string | null;
  pluginId: string | null;
  requestedById: string | null;
  attempt: number;
  /** Parsed `Job.configJson`. Each kind documents its own shape. */
  config: Record<string, unknown>;
}

export interface JobContext {
  job: JobRecord;
  /** Aborted on cancel or timeout. Handlers must check it between steps. */
  signal: AbortSignal;
  /** Append a line to the job's output log (capped, tail-kept). */
  log(line: string): void;
  /** Persist progress for the UI. Throttled by the runner. */
  progress(update: JobProgress): Promise<void>;
  /** Extend the stale-job lease during long silent work (called by progress()). */
  heartbeat(): Promise<void>;
  /** Per-job scratch directory under DATA_ROOT/tmp; removed when the job ends. */
  tmpDir: string;
}

/** Return value becomes `Job.resultJson` (must be JSON-serialisable). */
export type JobHandler = (ctx: JobContext) => Promise<unknown>;

export interface JobHandlerOptions {
  /** Override the default JOB_TIMEOUT_MS for this kind. */
  timeoutMs?: number;
  /** Max automatic re-queues after a crash or stale lease (default 2). */
  maxAttempts?: number;
}

export class JobFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = "JobFailure";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

type Registry = Map<JobKind, { handler: JobHandler; options: JobHandlerOptions }>;

/**
 * The registry lives on globalThis: Next.js bundles this module separately
 * into instrumentation and into each route, so a module-local Map filled at
 * boot would be empty in the copy a route's `triggerJobProcessing()` uses
 * (observed in dev as "No handler is registered for MANUAL_UPLOAD").
 */
const REGISTRY_KEY = Symbol.for("kiri.jobs.handlerRegistry");
const registry: Registry = ((globalThis as unknown as Record<symbol, Registry | undefined>)[
  REGISTRY_KEY
] ??= new Map());

export function registerJobHandler(
  kind: JobKind,
  handler: JobHandler,
  options: JobHandlerOptions = {},
): void {
  registry.set(kind, { handler, options });
}

export function getJobHandler(
  kind: JobKind,
): { handler: JobHandler; options: JobHandlerOptions } | undefined {
  return registry.get(kind);
}

export function registeredJobKinds(): JobKind[] {
  return Array.from(registry.keys());
}
