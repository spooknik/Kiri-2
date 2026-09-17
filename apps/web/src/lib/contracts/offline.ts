/**
 * Offline contract: the manifest the downloader uses to fetch a series for
 * offline reading, and the sync-queue operations replayed when back online.
 */
import { z } from "zod";
import type { MediaType } from "./series";

/** GET /api/series/:id/offline-manifest */
export interface OfflineManifest {
  series: { id: string; title: string; mediaType: MediaType; coverUrl: string | null };
  generatedAt: string;
  chapters: {
    id: string;
    slug: string;
    title: string;
    number: number | null;
    sortIndex: number;
    pageCount: number;
    bytes: number;
    pages: {
      id: string;
      index: number;
      url: string;
      width: number | null;
      height: number | null;
      bytes: number;
    }[];
  }[];
  totalBytes: number;
}

/** POST /api/sync — batched replay of offline operations (idempotent by op id). */
export const syncOpSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("position"),
    id: z.uuid(),
    seriesId: z.uuid(),
    chapterId: z.uuid().nullable(),
    pageIndex: z.number().int().min(0),
    at: z.string(),
  }),
  z.object({
    type: z.literal("chapterRead"),
    id: z.uuid(),
    chapterId: z.uuid(),
    read: z.boolean(),
    at: z.string(),
  }),
  z.object({
    type: z.literal("note"),
    id: z.uuid(),
    noteId: z.uuid(),
    at: z.string(),
    /** Same shape as upsertNoteSchema; validated by the notes module. */
    note: z.record(z.string(), z.unknown()),
  }),
]);
export type SyncOp = z.infer<typeof syncOpSchema>;

export const syncBatchSchema = z.object({
  ops: z.array(syncOpSchema).min(1).max(200),
});

export interface SyncBatchResult {
  results: { id: string; ok: boolean; error?: string }[];
}
