/**
 * Series + library-entry contract shared by API routes and client code.
 * Request bodies are zod schemas (validated by withAuth); responses are plain
 * TypeScript types that routes must satisfy and clients may rely on.
 */
import { z } from "zod";

export const MEDIA_TYPES = [
  "MANGA",
  "MANHWA",
  "MANHUA",
  "COMIC",
  "LIGHT_NOVEL",
  "NOVEL",
  "BOOK",
  "OTHER",
] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const READING_STATUSES = [
  "READING",
  "COMPLETED",
  "ON_HOLD",
  "DROPPED",
  "PLAN_TO_READ",
] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];

export const VISIBILITIES = ["SHARED", "PRIVATE"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const MEDIA_TYPE_LABELS: Record<MediaType, string> = {
  MANGA: "Manga",
  MANHWA: "Manhwa",
  MANHUA: "Manhua",
  COMIC: "Comic",
  LIGHT_NOVEL: "Light novel",
  NOVEL: "Novel",
  BOOK: "Book",
  OTHER: "Other",
};

export const READING_STATUS_LABELS: Record<ReadingStatus, string> = {
  READING: "Reading",
  COMPLETED: "Completed",
  ON_HOLD: "On hold",
  DROPPED: "Dropped",
  PLAN_TO_READ: "Plan to read",
};

const optionalText = (max: number) => z.string().trim().max(max).nullish();

/**
 * `z.url()` on its own accepts every scheme: `file:`, `javascript:`, and git's
 * `ext::sh -c …` transport, which executes a command. Every URL Kiri will
 * fetch, clone or hand to a plugin therefore goes through this instead.
 * (`src/lib/net/safe-fetch.ts` enforces the same rule at the socket, plus the
 * address ranges; this is the half that produces a 400 with a clear message.)
 */
export const HTTP_URL_MESSAGE = "Only http(s) URLs are supported";

export function isHttpProtocolUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** `z.url()` restricted to http(s). */
export const httpUrl = (max = 2000) => z.url().max(max).refine(isHttpProtocolUrl, HTTP_URL_MESSAGE);

/** POST /api/series */
export const createSeriesSchema = z.object({
  title: z.string().trim().min(1).max(300),
  originalTitle: optionalText(300),
  synopsis: optionalText(10_000),
  mediaType: z.enum(MEDIA_TYPES).default("MANGA"),
  visibility: z.enum(VISIBILITIES).default("SHARED"),
  isAdult: z.boolean().default(false),
  publicationYear: z.number().int().min(1800).max(2100).nullish(),
  totalChapters: z.number().int().min(0).max(100_000).nullish(),
  totalVolumes: z.number().int().min(0).max(10_000).nullish(),
  tags: z.array(z.string()).max(30).default([]),
  sourceUrl: httpUrl().nullish(),
  /** Remote cover image to fetch and store locally. */
  coverUrl: httpUrl().nullish(),
  malId: z.number().int().positive().nullish(),
  /**
   * Book-club pick from the start. Mutually exclusive with visibility
   * PRIVATE. V1 could only flip this on an existing series, which is why
   * `createSeries` also runs the enrollment helper.
   */
  isBookClub: z.boolean().default(false),
  /** Initial library entry for the creator. */
  status: z.enum(READING_STATUSES).default("PLAN_TO_READ"),
  currentChapter: z.number().min(0).max(100_000).default(0),
});
export type CreateSeriesInput = z.infer<typeof createSeriesSchema>;

/** PATCH /api/series/:id (creator or admin) */
export const updateSeriesSchema = createSeriesSchema
  .omit({ status: true, currentChapter: true })
  .partial()
  .extend({
    /** Admin/creator only; mutually exclusive with visibility PRIVATE. */
    isBookClub: z.boolean().optional(),
    /** Set true to delete the stored cover without providing a new one. */
    removeCover: z.boolean().optional(),
  });
export type UpdateSeriesInput = z.infer<typeof updateSeriesSchema>;

/** PUT /api/series/:id/entry (creates the entry when missing) */
export const updateEntrySchema = z.object({
  status: z.enum(READING_STATUSES).optional(),
  currentChapter: z.number().min(0).max(100_000).optional(),
  rating: z.number().int().min(1).max(10).nullish(),
  notes: z.string().trim().max(5000).nullish(),
  favorite: z.boolean().optional(),
});
export type UpdateEntryInput = z.infer<typeof updateEntrySchema>;

/** PATCH /api/series/bulk */
export const bulkSeriesSchema = z.object({
  ids: z.array(z.uuid()).min(1).max(100),
  action: z.discriminatedUnion("type", [
    z.object({ type: z.literal("setStatus"), status: z.enum(READING_STATUSES) }),
    z.object({ type: z.literal("setBookClub"), isBookClub: z.boolean() }),
    z.object({ type: z.literal("untrack") }),
    z.object({ type: z.literal("delete") }),
  ]),
});
export type BulkSeriesInput = z.infer<typeof bulkSeriesSchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface UserRef {
  id: string;
  displayName: string;
}

export interface LibraryEntryView {
  status: ReadingStatus;
  currentChapter: number;
  rating: number | null;
  notes: string | null;
  favorite: boolean;
  joinedAt: string;
  updatedAt: string;
}

/** One row of the library list. */
export interface SeriesSummary {
  id: string;
  title: string;
  originalTitle: string | null;
  mediaType: MediaType;
  visibility: Visibility;
  isAdult: boolean;
  isBookClub: boolean;
  /** `/api/series/:id/cover?v=...` or null when no cover is stored. */
  coverUrl: string | null;
  tags: string[];
  chapterCount: number;
  lastChapterAt: string | null;
  totalChapters: number | null;
  createdBy: UserRef;
  createdAt: string;
  updatedAt: string;
  /** The current user's entry, null when not tracking. */
  entry: LibraryEntryView | null;
  /** Number of users tracking this series (1 for private series). */
  readerCount: number;
  /** True when the current user may edit/delete (creator or admin). */
  canEdit: boolean;
}

/** Another member's progress on a shared series (book-club side-by-side). */
export interface MemberProgress {
  user: UserRef;
  status: ReadingStatus;
  currentChapter: number;
  rating: number | null;
  updatedAt: string;
}

export interface SeriesDetail extends SeriesSummary {
  synopsis: string | null;
  publicationYear: number | null;
  totalVolumes: number | null;
  sourceUrl: string | null;
  malId: number | null;
  externalIds: Record<string, unknown>;
  /** All tracking members incl. the current user; empty for private series. */
  members: MemberProgress[];
}

export interface BulkSeriesResult {
  affected: number;
  skipped: { id: string; reason: string }[];
}
