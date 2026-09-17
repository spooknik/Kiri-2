/**
 * Kiri 1.x import contract: the admin request that starts a V1_IMPORT job and
 * the report the job produces (also printed by the CLI).
 */
import { z } from "zod";

export const V1_IMPORT_MODES = ["copy", "link"] as const;
export type V1ImportMode = (typeof V1_IMPORT_MODES)[number];

/** POST /api/admin/import-v1 */
export const v1ImportRequestSchema = z.object({
  /** V1 PostgreSQL connection string. Encrypted before it is stored on the job. */
  databaseUrl: z.string().trim().min(1).max(2000),
  /** V1 data directory containing `rips/` and `covers/`. */
  dataDir: z.string().trim().min(1).max(4000),
  /** copy = duplicate files into DATA_ROOT (default); link = symlink the V1 directories. */
  mode: z.enum(V1_IMPORT_MODES).default("copy"),
  dryRun: z.boolean().default(false),
  /** Which V1 user becomes admin when the instance has none yet. */
  adminEmail: z.email().optional(),
  /** Import finished rip jobs as history rows (without logs). */
  importJobs: z.enum(["skip", "history"]).default("skip"),
});
export type V1ImportRequest = z.infer<typeof v1ImportRequestSchema>;

export interface V1ImportCounts {
  read: number;
  created: number;
  reused: number;
  updated: number;
  skipped: number;
}

export const V1_IMPORT_TABLES = [
  "users",
  "series",
  "libraryEntries",
  "sources",
  "chapters",
  "pages",
  "positions",
  "notifications",
  "credentials",
  "settings",
  "jobs",
] as const;
export type V1ImportTable = (typeof V1_IMPORT_TABLES)[number];

export interface V1ImportWarning {
  code: string;
  message: string;
  v1Table?: string;
  v1Id?: string;
  seriesId?: string;
}

export interface V1ImportReport {
  runId: string;
  dryRun: boolean;
  mode: V1ImportMode;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  counts: Record<V1ImportTable, V1ImportCounts>;
  content: {
    sources: number;
    copied: number;
    linked: number;
    failed: number;
    bytes: number;
    manifestsMissing: number;
  };
  /** Sites whose plugin is not installed; their sources wait as NEEDS_PLUGIN. */
  needsPlugin: { site: string; seriesCount: number }[];
  /** One invite per imported user without a password (shown once). */
  invites: { email: string; displayName: string; url: string; expiresAt: string }[];
  warnings: V1ImportWarning[];
}

/** GET /api/admin/import-v1/preflight?… is not exposed; preflight runs inside the job. */
export interface V1ImportEnqueued {
  jobId: string;
}
