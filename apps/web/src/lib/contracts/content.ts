/**
 * Content contract: chapters, pages, reading position, chapter read state,
 * uploads and background jobs. Shared by API routes, the reader and the
 * series page. Dates are ISO strings; byte counts are numbers.
 */
import { z } from "zod";
import type { MediaType, UserRef } from "./series";

export const CHAPTER_STATUSES = [
  "PENDING",
  "DOWNLOADING",
  "COMPLETED",
  "FAILED",
  "MISSING_FROM_SOURCE",
] as const;
export type ChapterStatus = (typeof CHAPTER_STATUSES)[number];

export const CHAPTER_ORIGINS = ["PLUGIN", "PDF", "MANUAL"] as const;
export type ChapterOrigin = (typeof CHAPTER_ORIGINS)[number];

// ---------------------------------------------------------------------------
// Chapters and pages
// ---------------------------------------------------------------------------

export interface ChapterRef {
  id: string;
  slug: string;
  title: string;
  number: number | null;
  pageCount: number;
}

/** One row of a series' chapter list. */
export interface ChapterListItem extends ChapterRef {
  volume: string | null;
  status: ChapterStatus;
  origin: ChapterOrigin;
  bytes: number;
  sourceUrl: string | null;
  releaseDate: string | null;
  downloadedAt: string | null;
  /** Materialised reading order, ascending. */
  sortIndex: number;
  /** Whether the current user has read this chapter. */
  read: boolean;
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReadingPositionView {
  chapterId: string | null;
  pageIndex: number;
  updatedAt: string;
}

/** GET /api/series/:id/chapters */
export interface ChapterListResponse {
  series: { id: string; title: string; mediaType: MediaType; canEdit: boolean };
  chapters: ChapterListItem[];
  position: ReadingPositionView | null;
  readCount: number;
  /** Chapters the reader can open (status COMPLETED with at least one page). */
  readableCount: number;
}

export interface PageView {
  id: string;
  /** 1-based, matches manifest image.index. */
  index: number;
  /** `/api/pages/:id/image` (immutable; cache by URL). */
  url: string;
  width: number | null;
  height: number | null;
  bytes: number;
  mime: string | null;
}

/** GET /api/chapters/:id */
export interface ChapterDetail extends ChapterListItem {
  seriesId: string;
  seriesTitle: string;
  pages: PageView[];
  prev: ChapterRef | null;
  next: ChapterRef | null;
}

/** PATCH /api/chapters/:id (creator or admin) */
export const updateChapterSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  number: z.number().min(0).max(100_000).nullish(),
  volume: z.string().trim().max(40).nullish(),
});
export type UpdateChapterInput = z.infer<typeof updateChapterSchema>;

/** PUT /api/chapters/:id/read */
export const setChapterReadSchema = z.object({ read: z.boolean() });

/** PUT /api/series/:id/position */
export const updatePositionSchema = z.object({
  chapterId: z.uuid().nullable(),
  pageIndex: z.number().int().min(0).max(100_000),
});
export type UpdatePositionInput = z.infer<typeof updatePositionSchema>;

/** GET /api/library/continue — recent reading positions across series. */
export interface ContinueReadingItem {
  series: { id: string; title: string; coverUrl: string | null; mediaType: MediaType };
  chapter: ChapterRef | null;
  pageIndex: number;
  updatedAt: string;
}
export interface ContinueReadingResponse {
  items: ContinueReadingItem[];
}

// ---------------------------------------------------------------------------
// Uploads (chunked, resumable enough for reverse proxies with body limits)
// ---------------------------------------------------------------------------

export const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** POST /api/uploads */
export const createUploadSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  size: z.number().int().positive().max(UPLOAD_MAX_BYTES),
  mime: z.string().trim().max(120).optional(),
});
export type CreateUploadInput = z.infer<typeof createUploadSchema>;

export interface UploadSessionView {
  id: string;
  filename: string;
  size: number;
  mime: string | null;
  chunkSize: number;
  chunkCount: number;
  /** Chunk indexes already stored (0-based). */
  receivedChunks: number[];
  complete: boolean;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Chapter import (manual upload / PDF) and optimisation → background jobs
// ---------------------------------------------------------------------------

export const IMPORT_KINDS = ["archive", "images", "pdf"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

/** POST /api/series/:id/chapters/import */
export const importChapterSchema = z.object({
  kind: z.enum(IMPORT_KINDS),
  /** One archive/pdf upload, or many image uploads in reading order. */
  uploadIds: z.array(z.uuid()).min(1).max(500),
  title: z.string().trim().min(1).max(200),
  number: z.number().min(0).max(100_000).nullish(),
  volume: z.string().trim().max(40).nullish(),
  pdf: z
    .object({
      /** Render scale relative to 72 dpi; 1.5 ≈ 108 dpi. */
      scale: z.number().min(1).max(3).default(1.5),
      maxWidth: z.number().int().min(600).max(4000).default(1600),
    })
    .optional(),
});
export type ImportChapterInput = z.infer<typeof importChapterSchema>;

/** POST /api/series/:id/optimize */
export const optimizeSeriesSchema = z.object({
  chapterIds: z.array(z.uuid()).max(500).optional(),
});

export interface EnqueuedJobResponse {
  jobId: string;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const JOB_KINDS = [
  "SOURCE_SYNC",
  "SOURCE_VERIFY",
  "OPTIMIZE",
  "PDF_IMPORT",
  "MANUAL_UPLOAD",
  "PLUGIN_INSTALL",
  "V1_IMPORT",
  "INGEST_MANIFEST",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobProgress {
  phase?: string;
  current?: number;
  total?: number;
  message?: string;
  chapterSlug?: string;
}

export interface JobView {
  id: string;
  kind: JobKind;
  status: JobStatus;
  seriesId: string | null;
  sourceId: string | null;
  pluginId: string | null;
  requestedBy: UserRef | null;
  progress: JobProgress;
  result: unknown | null;
  error: string | null;
  errorCode: string | null;
  attempt: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

/** GET /api/jobs (own + jobs on series the user can view); admins see all via /api/admin/jobs */
export const jobsQuerySchema = z.object({
  seriesId: z.uuid().optional(),
  /** "active" = QUEUED or RUNNING. */
  status: z.enum([...JOB_STATUSES, "active"]).optional(),
  kind: z.enum(JOB_KINDS).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type JobsQuery = z.infer<typeof jobsQuerySchema>;

export interface JobsPage {
  items: JobView[];
  nextCursor: string | null;
}

/** GET /api/admin/jobs/status — runner health for the admin dashboard. */
export interface JobRunnerStatus {
  running: boolean;
  activeJobs: number;
  queuedJobs: number;
  lastHeartbeatAt: string | null;
  concurrency: number;
}
