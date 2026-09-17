/**
 * GET /api/library — the dashboard list. All filtering, searching, sorting and
 * pagination happen server-side; visibility and adult filtering are always
 * applied from the session (see src/lib/authz.ts).
 */
import { z } from "zod";
import { MEDIA_TYPES, READING_STATUSES, type ReadingStatus, type SeriesSummary } from "./series";

export const LIBRARY_SORTS = ["updated", "title", "added", "lastChapter", "progress"] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];

export const libraryQuerySchema = z.object({
  /** Full-text search over title, original title, tags and synopsis. */
  q: z.string().trim().max(200).optional(),
  /** Filter by the current user's entry status. */
  status: z.enum(READING_STATUSES).optional(),
  mediaType: z.enum(MEDIA_TYPES).optional(),
  tag: z.string().trim().max(40).optional(),
  bookClub: z.enum(["1"]).optional(),
  /** tracked = has my entry (default); created = I created it; all = everything visible. */
  scope: z.enum(["tracked", "created", "all"]).default("tracked"),
  /** Only meaningful for users with showAdult; the server never shows adult content otherwise. */
  adult: z.enum(["include", "exclude", "only"]).default("include"),
  favorite: z.enum(["1"]).optional(),
  sort: z.enum(LIBRARY_SORTS).default("updated"),
  order: z.enum(["asc", "desc"]).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});
export type LibraryQuery = z.infer<typeof libraryQuerySchema>;

export interface LibraryPage {
  items: SeriesSummary[];
  nextCursor: string | null;
  /** Total matching rows for the current filters (ignores pagination). */
  total: number;
  /** Counts of the current user's entries by status, unfiltered. */
  statusCounts: Record<ReadingStatus, number>;
}
