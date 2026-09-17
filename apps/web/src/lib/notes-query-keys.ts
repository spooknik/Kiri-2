/**
 * TanStack Query keys owned by the notes feature.
 *
 * Kept out of `src/lib/query-keys.ts` and `src/lib/content-query-keys.ts` for
 * the reason those files give: each feature owns its cache shape so parallel
 * work never collides on one file. Every key starts with `"notes"`, so
 * `invalidateQueries({ queryKey: notesQueryKeys.all })` clears exactly this
 * feature.
 *
 * `list` keys carry their anchor as the last segment, which is what lets an
 * optimistic insert find the lists a new note belongs in
 * (`src/hooks/use-notes.ts`).
 */

/** The anchor a notes list was fetched for. */
export interface NotesListParams {
  chapterId?: string | null;
  pageIndex?: number | null;
}

export const notesQueryKeys = {
  all: ["notes"] as const,
  /** Every list query for one series, whatever its anchor. */
  listsForSeries: (seriesId: string) => ["notes", "list", seriesId] as const,
  list: (seriesId: string, params: NotesListParams) =>
    [
      "notes",
      "list",
      seriesId,
      { chapterId: params.chapterId ?? null, pageIndex: params.pageIndex ?? null },
    ] as const,
  thread: (noteId: string, reveal: boolean) => ["notes", "thread", noteId, reveal] as const,
  summary: (seriesId: string) => ["notes", "summary", seriesId] as const,
} as const;
