/**
 * TanStack Query keys owned by the reader.
 *
 * Deliberately kept out of `src/lib/query-keys.ts` (shared, owned by the app
 * shell) so the reader can evolve its cache shape without touching a file the
 * rest of the app invalidates against. All keys start with `"reader"`, so
 * `queryClient.invalidateQueries({ queryKey: readerKeys.all })` clears exactly
 * the reader's caches and nothing else.
 */
export const readerKeys = {
  all: ["reader"] as const,
  /** GET /api/series/:id/chapters — chapter list + reading position. */
  chapters: (seriesId: string) => ["reader", "chapters", seriesId] as const,
  /** GET /api/chapters/:id — pages + prev/next. */
  chapter: (chapterId: string) => ["reader", "chapter", chapterId] as const,
} as const;
