"use client";

/**
 * The reader's single orchestration hook: queries, derived navigation state,
 * preferences and progress persistence.
 *
 * It owns two queries -- the chapter list (cheap, 30 s stale, also carrying the
 * saved reading position and the series' media type) and the current chapter's
 * detail (pages + prev/next, 5 min stale because page URLs are immutable) --
 * and exactly one piece of mutable state the URL only mirrors: which chapter is
 * open and which page you're on.
 *
 * The current page is *derived*, not stored: it is the page you last moved to,
 * falling back to the saved reading position, clamped to the chapter. That is
 * what lets the position resolve asynchronously (the list arrives after the
 * first paint) without an effect that writes state back into React.
 *
 * Components below this hook stay presentational; everything that has to know
 * about the API, the debounce or localStorage lives here.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { api, type ApiClientError } from "@/lib/api-client";
import type {
  ChapterDetail,
  ChapterListItem,
  ChapterListResponse,
  ChapterRef,
  PageView,
} from "@/lib/contracts/content";
import type { MediaType } from "@/lib/contracts/series";
import {
  isReadableChapter,
  readableChapters,
  resolveInitialChapterId,
} from "@/lib/reader/chapters";
import { nextPageUrls, preloadImages } from "@/lib/reader/preload";
import { applyPrefPatch, resolvePrefs, type PrefScope, type ReaderPrefs } from "@/lib/reader/prefs";
import {
  getReaderPrefsServerSnapshot,
  getReaderPrefsSnapshot,
  subscribeReaderPrefs,
  updateReaderPrefs,
} from "@/lib/reader/prefs-store";
import {
  flushProgress,
  installProgressFlushHandlers,
  markChapterRead,
  saveProgress,
  subscribeProgressErrors,
} from "@/lib/reader/progress";
import { readerKeys } from "@/lib/reader/query-keys";
import { buildReaderSearch } from "@/lib/reader/url";

const CHAPTER_LIST_STALE_MS = 30 * 1000;
const CHAPTER_DETAIL_STALE_MS = 5 * 60 * 1000;
/** Keeps `history.replaceState` off the hot path while a strip is scrolling. */
const URL_SYNC_DEBOUNCE_MS = 250;
/** Sentinel meaning "the last page of whatever chapter this turns out to be". */
const LAST_PAGE = Number.MAX_SAFE_INTEGER;

export interface UseReaderParams {
  seriesId: string | null;
  /** Chapter from the URL; null means "resume, or start at the beginning". */
  chapterId: string | null;
  /** 1-based page from the URL, or null to resume from the saved position. */
  page: number | null;
}

export interface GoToChapterOptions {
  /** Open at the last page instead of the first (used by "previous chapter"). */
  atEnd?: boolean;
}

export interface ReaderApi {
  seriesId: string | null;
  seriesTitle: string;
  mediaType: MediaType;

  chapters: ChapterListItem[];
  readable: ChapterListItem[];
  list: ChapterListResponse | undefined;
  listQuery: UseQueryResult<ChapterListResponse, ApiClientError>;

  chapter: ChapterDetail | undefined;
  chapterQuery: UseQueryResult<ChapterDetail, ApiClientError>;
  chapterId: string | null;
  /** True when the chapter list loaded but holds nothing readable. */
  hasNoReadableChapters: boolean;
  /** True when the chapter in the URL doesn't exist (or can't be opened). */
  chapterNotFound: boolean;

  pages: PageView[];
  pageIndex: number;
  pageCount: number;
  prevChapter: ChapterRef | null;
  nextChapter: ChapterRef | null;

  prefs: ReaderPrefs;
  prefScope: PrefScope;
  setPrefScope: (scope: PrefScope) => void;
  setPrefs: (patch: Partial<ReaderPrefs>) => void;

  goToPage: (index: number) => void;
  goToChapter: (id: string, options?: GoToChapterOptions) => void;
  goToPrevChapter: () => void;
  goToNextChapter: () => void;
  markCurrentChapterRead: () => void;
}

export function useReader(params: UseReaderParams): ReaderApi {
  const queryClient = useQueryClient();
  const { seriesId, chapterId: chapterParam, page: pageParam } = params;

  // --- queries -------------------------------------------------------------

  const listQuery = useQuery<ChapterListResponse, ApiClientError>({
    queryKey: readerKeys.chapters(seriesId ?? "none"),
    queryFn: () => api.get<ChapterListResponse>(`/api/series/${seriesId}/chapters`),
    enabled: Boolean(seriesId),
    staleTime: CHAPTER_LIST_STALE_MS,
  });

  const chapters = useMemo(() => listQuery.data?.chapters ?? [], [listQuery.data]);
  const readable = useMemo(() => readableChapters(chapters), [chapters]);

  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(chapterParam);
  const resolvedChapterId = useMemo(
    () => resolveInitialChapterId(chapters, listQuery.data?.position),
    [chapters, listQuery.data],
  );
  const chapterId = selectedChapterId ?? resolvedChapterId;

  const chapterQuery = useQuery<ChapterDetail, ApiClientError>({
    queryKey: readerKeys.chapter(chapterId ?? "none"),
    queryFn: () => api.get<ChapterDetail>(`/api/chapters/${chapterId}`),
    enabled: Boolean(chapterId),
    staleTime: CHAPTER_DETAIL_STALE_MS,
    retry: (failureCount, error) => error.status !== 404 && failureCount < 1,
  });

  const pages = useMemo(() => chapterQuery.data?.pages ?? [], [chapterQuery.data]);
  const pageCount = pages.length;

  // --- current page (derived) ---------------------------------------------

  const [movedToPage, setMovedToPage] = useState<number | null>(
    pageParam === null ? null : Math.max(0, pageParam - 1),
  );

  const position = listQuery.data?.position ?? null;
  const resumePageIndex =
    position && position.chapterId === chapterId ? Math.max(0, position.pageIndex) : 0;
  const wantedPageIndex = movedToPage ?? resumePageIndex;
  const pageIndex = pageCount > 0 ? Math.min(Math.max(wantedPageIndex, 0), pageCount - 1) : 0;

  const goToPage = useCallback((index: number) => {
    setMovedToPage(Math.max(0, Math.floor(index)));
  }, []);

  // --- chapter navigation --------------------------------------------------

  const goToChapter = useCallback((id: string, options: GoToChapterOptions = {}) => {
    setSelectedChapterId(id);
    setMovedToPage(options.atEnd ? LAST_PAGE : 0);
  }, []);

  const prevChapter = chapterQuery.data?.prev ?? null;
  const nextChapter = chapterQuery.data?.next ?? null;

  const goToPrevChapter = useCallback(() => {
    if (prevChapter) goToChapter(prevChapter.id, { atEnd: true });
  }, [prevChapter, goToChapter]);

  const goToNextChapter = useCallback(() => {
    if (nextChapter) goToChapter(nextChapter.id);
  }, [nextChapter, goToChapter]);

  // --- preferences ---------------------------------------------------------

  const stored = useSyncExternalStore(
    subscribeReaderPrefs,
    getReaderPrefsSnapshot,
    getReaderPrefsServerSnapshot,
  );
  const [prefScope, setPrefScope] = useState<PrefScope>("media");

  const mediaType: MediaType = listQuery.data?.series.mediaType ?? "MANGA";
  const prefs = useMemo(
    () => resolvePrefs(stored, mediaType, seriesId),
    [stored, mediaType, seriesId],
  );

  const setPrefs = useCallback(
    (patch: Partial<ReaderPrefs>) => {
      updateReaderPrefs((current) =>
        applyPrefPatch(current, { mediaType, seriesId, scope: prefScope }, patch),
      );
    },
    [mediaType, seriesId, prefScope],
  );

  // --- progress ------------------------------------------------------------

  useEffect(() => installProgressFlushHandlers(), []);

  // Flush before switching chapters so the outgoing chapter's last page sticks.
  const lastChapterIdRef = useRef<string | null>(chapterId);
  useEffect(() => {
    if (lastChapterIdRef.current !== chapterId) {
      lastChapterIdRef.current = chapterId;
      flushProgress();
    }
  }, [chapterId]);

  useEffect(() => {
    if (!seriesId || !chapterId || pageCount === 0) return;
    saveProgress({ seriesId, chapterId, pageIndex });
  }, [seriesId, chapterId, pageIndex, pageCount]);

  // --- read state ----------------------------------------------------------

  const markedReadRef = useRef(new Set<string>());

  const patchChapterRead = useCallback(
    (id: string) => {
      if (!seriesId) return;
      queryClient.setQueryData<ChapterListResponse>(readerKeys.chapters(seriesId), (current) => {
        if (!current) return current;
        let changed = false;
        const next = current.chapters.map((entry) => {
          if (entry.id !== id || entry.read) return entry;
          changed = true;
          return { ...entry, read: true, readAt: new Date().toISOString() };
        });
        if (!changed) return current;
        return { ...current, chapters: next, readCount: current.readCount + 1 };
      });
    },
    [queryClient, seriesId],
  );

  const markChapterReadOnce = useCallback(
    (id: string) => {
      if (markedReadRef.current.has(id)) return;
      markedReadRef.current.add(id);
      patchChapterRead(id);
      void markChapterRead(id, true).then((ok) => {
        // Allow a retry (next page turn, or the end card) after a failed write.
        if (!ok) markedReadRef.current.delete(id);
      });
    },
    [patchChapterRead],
  );

  const markCurrentChapterRead = useCallback(() => {
    if (chapterId) markChapterReadOnce(chapterId);
  }, [chapterId, markChapterReadOnce]);

  // Reaching the last page marks the chapter read.
  useEffect(() => {
    if (!chapterId || pageCount === 0) return;
    if (pageIndex === pageCount - 1) markChapterReadOnce(chapterId);
  }, [chapterId, pageIndex, pageCount, markChapterReadOnce]);

  // --- preload -------------------------------------------------------------

  useEffect(() => {
    if (pages.length === 0) return;
    preloadImages(nextPageUrls(pages, pageIndex));
  }, [pages, pageIndex]);

  // --- URL sync ------------------------------------------------------------

  useEffect(() => {
    if (typeof window === "undefined" || !seriesId) return;
    const search = buildReaderSearch({ seriesId, chapterId, pageIndex });
    if (window.location.search === search) return;
    const timer = setTimeout(() => {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}`);
    }, URL_SYNC_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [seriesId, chapterId, pageIndex]);

  // --- derived flags -------------------------------------------------------

  const hasNoReadableChapters = Boolean(listQuery.data) && readable.length === 0;
  const chapterNotFound =
    chapterQuery.error?.status === 404 ||
    (Boolean(listQuery.data) &&
      Boolean(chapterId) &&
      chapters.length > 0 &&
      !chapters.some((entry) => entry.id === chapterId && isReadableChapter(entry)));

  return {
    seriesId,
    seriesTitle: listQuery.data?.series.title ?? chapterQuery.data?.seriesTitle ?? "",
    mediaType,

    chapters,
    readable,
    list: listQuery.data,
    listQuery,

    chapter: chapterQuery.data,
    chapterQuery,
    chapterId,
    hasNoReadableChapters,
    chapterNotFound,

    pages,
    pageIndex,
    pageCount,
    prevChapter,
    nextChapter,

    prefs,
    prefScope,
    setPrefScope,
    setPrefs,

    goToPage,
    goToChapter,
    goToPrevChapter,
    goToNextChapter,
    markCurrentChapterRead,
  };
}

/** Subscribes to progress-save failures; see `ReaderShell` for the toast. */
export function useProgressErrors(onError: () => void): void {
  const handler = useRef(onError);
  useEffect(() => {
    handler.current = onError;
  }, [onError]);
  useEffect(() => subscribeProgressErrors(() => handler.current()), []);
}
