"use client";

/**
 * Notes data hooks: lists, threads, the series summary, and the three writes.
 *
 * Writes never call the API directly. They go through
 * `getNoteTransport().upsert(...)`, the seam the offline sync queue replaces
 * (`src/lib/notes/transport.ts`), which is why `useUpsertNote` treats a `null`
 * result as "queued, not rejected": the note is kept in the cache with
 * `pending: true` and rendered with a pending badge until a later sync answers
 * with the server's row.
 *
 * Lists always ask for `includeHidden=1`. The reader has to know a note exists
 * at a page even when its body is spoiler-gated, or the shield would have
 * nothing to hang on.
 */
import { useCallback } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useToast } from "@/components/ui";
import { api, type ApiClientError } from "@/lib/api-client";
import type {
  NotesPage,
  NotesSummary,
  NoteThread,
  NoteView,
  UpsertNoteInput,
} from "@/lib/contracts/notes";
import { notesQueryKeys, type NotesListParams } from "@/lib/notes-query-keys";
import { getNoteTransport } from "@/lib/notes/transport";

const NOTES_STALE_MS = 15_000;

/** A note in the cache, possibly one the sync queue has not confirmed yet. */
export interface LocalNoteView extends NoteView {
  /** True while the write sits in the offline queue. */
  pending?: boolean;
}

export interface UseNotesOptions extends NotesListParams {
  /** Skip the request (e.g. before the reader knows its chapter). */
  enabled?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/** GET /api/series/:id/notes — top-level notes for a series, chapter or page. */
export function useNotes(
  seriesId: string | null,
  options: UseNotesOptions = {},
): UseQueryResult<NotesPage, ApiClientError> {
  const { chapterId = null, pageIndex = null, enabled = true } = options;

  return useQuery<NotesPage, ApiClientError>({
    queryKey: notesQueryKeys.list(seriesId ?? "none", { chapterId, pageIndex }),
    queryFn: () =>
      api.get<NotesPage>(`/api/series/${seriesId}/notes`, {
        query: {
          chapterId: chapterId ?? undefined,
          pageIndex: pageIndex ?? undefined,
          includeHidden: "1",
        },
      }),
    enabled: Boolean(seriesId) && enabled,
    staleTime: NOTES_STALE_MS,
  });
}

/**
 * GET /api/notes/:id — one note with its replies. `reveal` is a separate cache
 * entry on purpose: the gated and revealed answers differ, and revealing must
 * not silently rewrite the shielded copy other views are showing.
 */
export function useNoteThread(
  noteId: string | null,
  reveal = false,
  enabled = true,
): UseQueryResult<NoteThread, ApiClientError> {
  return useQuery<NoteThread, ApiClientError>({
    queryKey: notesQueryKeys.thread(noteId ?? "none", reveal),
    queryFn: () =>
      api.get<NoteThread>(`/api/notes/${noteId}`, {
        query: reveal ? { reveal: 1 } : undefined,
      }),
    enabled: Boolean(noteId) && enabled,
    staleTime: NOTES_STALE_MS,
  });
}

/** GET /api/series/:id/notes/summary — totals and per-chapter counts. */
export function useNotesSummary(
  seriesId: string | null,
): UseQueryResult<NotesSummary, ApiClientError> {
  return useQuery<NotesSummary, ApiClientError>({
    queryKey: notesQueryKeys.summary(seriesId ?? "none"),
    queryFn: () => api.get<NotesSummary>(`/api/series/${seriesId}/notes/summary`),
    enabled: Boolean(seriesId),
    staleTime: NOTES_STALE_MS,
  });
}

/* -------------------------------------------------------------------------- */
/* Cache helpers                                                              */
/* -------------------------------------------------------------------------- */

function anchorMatches(params: NotesListParams, note: NoteView): boolean {
  if (params.chapterId != null && params.chapterId !== note.chapterId) return false;
  if (params.pageIndex != null && params.pageIndex !== note.pageIndex) return false;
  return true;
}

function pageCountKey(note: NoteView): string {
  return String(note.pageIndex ?? 0);
}

function withNote(page: NotesPage, note: LocalNoteView, countDelta: number): NotesPage {
  const existing = page.items.findIndex((item) => item.id === note.id);
  const items =
    existing >= 0
      ? page.items.map((item, index) => (index === existing ? note : item))
      : [note, ...page.items];
  if (existing >= 0 || countDelta === 0) return { ...page, items };

  const key = pageCountKey(note);
  return {
    ...page,
    items,
    pageCounts: { ...page.pageCounts, [key]: (page.pageCounts[key] ?? 0) + countDelta },
  };
}

function withoutNote(page: NotesPage, noteId: string): NotesPage {
  const removed = page.items.find((item) => item.id === noteId);
  if (!removed) return page;
  const key = pageCountKey(removed);
  const current = page.pageCounts[key];
  return {
    ...page,
    items: page.items.filter((item) => item.id !== noteId),
    pageCounts:
      current === undefined
        ? page.pageCounts
        : { ...page.pageCounts, [key]: Math.max(0, current - 1) },
  };
}

/** Every cached list for the series whose anchor the note belongs to. */
function eachMatchingList(
  queryClient: QueryClient,
  seriesId: string,
  note: NoteView,
  update: (page: NotesPage) => NotesPage,
): void {
  const queries = queryClient
    .getQueryCache()
    .findAll({ queryKey: notesQueryKeys.listsForSeries(seriesId) });

  for (const query of queries) {
    const params = query.queryKey[3];
    if (typeof params !== "object" || params === null) continue;
    if (!anchorMatches(params as NotesListParams, note)) continue;
    queryClient.setQueryData<NotesPage>(query.queryKey, (page) => (page ? update(page) : page));
  }
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

export interface UpsertNoteVariables {
  /** Client-minted id (`newNoteId()`), so the write is idempotent. */
  noteId: string;
  input: UpsertNoteInput;
  /** Rendered while the write is in flight or queued offline. */
  optimistic: LocalNoteView;
}

/**
 * PUT /api/notes/:id through the note transport.
 *
 * The optimistic note is inserted into every matching cached list before the
 * request leaves, so a note appears on the page the moment it is written —
 * online or off.
 */
export function useUpsertNote(
  seriesId: string,
): UseMutationResult<NoteView | null, ApiClientError, UpsertNoteVariables> {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation<NoteView | null, ApiClientError, UpsertNoteVariables>({
    mutationFn: ({ noteId, input }) => getNoteTransport().upsert(noteId, input),
    onMutate: ({ optimistic }) => {
      if (optimistic.parentId === null) {
        eachMatchingList(queryClient, seriesId, optimistic, (page) =>
          withNote(page, optimistic, 1),
        );
      }
    },
    onSuccess: (saved) => {
      if (saved === null) return; // Queued offline; the pending copy stays.
      if (saved.parentId === null) {
        eachMatchingList(queryClient, seriesId, saved, (page) => withNote(page, saved, 0));
      }
      if (saved.parentId !== null) {
        void queryClient.invalidateQueries({
          queryKey: notesQueryKeys.thread(saved.parentId, false),
        });
        void queryClient.invalidateQueries({
          queryKey: notesQueryKeys.thread(saved.parentId, true),
        });
        eachMatchingList(queryClient, seriesId, saved, (page) => ({
          ...page,
          items: page.items.map((item) =>
            item.id === saved.parentId
              ? { ...item, replyCount: Math.max(item.replyCount, 1) }
              : item,
          ),
        }));
      }
      void queryClient.invalidateQueries({ queryKey: notesQueryKeys.summary(seriesId) });
    },
    onError: (error, { optimistic }) => {
      if (optimistic.parentId === null) {
        eachMatchingList(queryClient, seriesId, optimistic, (page) =>
          withoutNote(page, optimistic.id),
        );
      }
      toast({
        title: error.isOffline ? "Couldn't save — you're offline" : "Couldn't save your note",
        description: error.isOffline ? undefined : error.message,
        tone: "danger",
      });
    },
  });
}

export interface EditNoteVariables {
  noteId: string;
  body?: string;
  isSpoiler?: boolean;
}

/** PATCH /api/notes/:id — author-only edit. */
export function useEditNote(
  seriesId: string,
): UseMutationResult<NoteView, ApiClientError, EditNoteVariables> {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation<NoteView, ApiClientError, EditNoteVariables>({
    mutationFn: ({ noteId, ...patch }) => api.patch<NoteView>(`/api/notes/${noteId}`, patch),
    onSuccess: (saved) => {
      eachMatchingList(queryClient, seriesId, saved, (page) => withNote(page, saved, 0));
      void queryClient.invalidateQueries({ queryKey: notesQueryKeys.thread(saved.id, false) });
      void queryClient.invalidateQueries({ queryKey: notesQueryKeys.thread(saved.id, true) });
      if (saved.parentId !== null) {
        void queryClient.invalidateQueries({
          queryKey: notesQueryKeys.thread(saved.parentId, false),
        });
      }
    },
    onError: (error) => {
      toast({
        title: error.isOffline ? "Couldn't save — you're offline" : "Couldn't edit your note",
        description: error.isOffline ? undefined : error.message,
        tone: "danger",
      });
    },
  });
}

export interface DeleteNoteVariables {
  /** The note itself, so the cache knows which lists to prune. */
  note: NoteView;
}

/** DELETE /api/notes/:id — soft delete, optimistic removal from the lists. */
export function useDeleteNote(
  seriesId: string,
): UseMutationResult<void, ApiClientError, DeleteNoteVariables> {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation<void, ApiClientError, DeleteNoteVariables>({
    mutationFn: ({ note }) => getNoteTransport().remove(note.id),
    onMutate: ({ note }) => {
      if (note.parentId === null) {
        eachMatchingList(queryClient, seriesId, note, (page) => withoutNote(page, note.id));
      }
    },
    onSuccess: (_result, { note }) => {
      if (note.parentId !== null) {
        void queryClient.invalidateQueries({
          queryKey: notesQueryKeys.thread(note.parentId, false),
        });
      }
      void queryClient.invalidateQueries({ queryKey: notesQueryKeys.summary(seriesId) });
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: notesQueryKeys.listsForSeries(seriesId) });
      toast({
        title: error.isOffline ? "Couldn't delete — you're offline" : "Couldn't delete your note",
        description: error.isOffline ? undefined : error.message,
        tone: "danger",
      });
    },
  });
}

/**
 * Marks the notes caches for one series stale. Used after a reveal or when the
 * reader's chapter changes under a panel that is still open.
 */
export function useRefreshNotes(seriesId: string | null): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    if (!seriesId) return;
    void queryClient.invalidateQueries({ queryKey: notesQueryKeys.listsForSeries(seriesId) });
    void queryClient.invalidateQueries({ queryKey: notesQueryKeys.summary(seriesId) });
  }, [queryClient, seriesId]);
}
