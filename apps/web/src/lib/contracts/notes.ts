/**
 * Notes contract: annotations anchored to a series, chapter or page (with an
 * optional pin), threaded replies, spoiler gating.
 */
import { z } from "zod";
import type { UserRef } from "./series";

/** PUT /api/notes/:id — idempotent upsert; the client mints the uuid. */
export const upsertNoteSchema = z.object({
  seriesId: z.uuid(),
  chapterId: z.uuid().nullable(),
  /** 1-based page index inside the chapter; null = chapter-level note. */
  pageIndex: z.number().int().min(1).max(100_000).nullable(),
  /** Normalised 0..1 pin on the page image; both or neither. */
  pinX: z.number().min(0).max(1).nullable(),
  pinY: z.number().min(0).max(1).nullable(),
  body: z.string().trim().min(1).max(5000),
  parentId: z.uuid().nullable(),
  isSpoiler: z.boolean().default(false),
});
export type UpsertNoteInput = z.infer<typeof upsertNoteSchema>;

/** PATCH /api/notes/:id — author edits body/spoiler only. */
export const editNoteSchema = z.object({
  body: z.string().trim().min(1).max(5000).optional(),
  isSpoiler: z.boolean().optional(),
});

/** GET /api/series/:id/notes?chapterId=&pageIndex= */
export const notesQuerySchema = z.object({
  chapterId: z.uuid().optional(),
  pageIndex: z.coerce.number().int().min(1).optional(),
  /** Include notes on pages beyond the viewer's progress (they still arrive `hidden`). */
  includeHidden: z.enum(["1"]).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type NotesQuery = z.infer<typeof notesQuerySchema>;

export interface NoteView {
  id: string;
  seriesId: string;
  chapterId: string | null;
  chapter: { id: string; title: string; number: number | null; sortIndex: number } | null;
  pageIndex: number | null;
  pinX: number | null;
  pinY: number | null;
  /** Empty string when `hidden` (spoiler-gated). */
  body: string;
  author: UserRef;
  parentId: string | null;
  isSpoiler: boolean;
  /**
   * True when the note sits beyond the viewer's furthest read position (or is
   * marked spoiler) and the viewer has not enabled showSpoilers: the body is
   * withheld until the client asks for it with reveal=1.
   */
  hidden: boolean;
  replyCount: number;
  canEdit: boolean;
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotesPage {
  items: NoteView[];
  nextCursor: string | null;
  /** Per-page counts for the reader's markers: { [pageIndex]: count } (chapter scope only). */
  pageCounts: Record<string, number>;
}

/** GET /api/notes/:id?reveal=1 — one note with its thread. */
export interface NoteThread {
  note: NoteView;
  replies: NoteView[];
}

/** GET /api/series/:id/notes/summary — per-chapter counts for the series page. */
export interface NotesSummary {
  total: number;
  byChapter: { chapterId: string; count: number }[];
  seriesLevel: number;
}
