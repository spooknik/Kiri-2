"use client";

/**
 * The reader.
 *
 * Everything is driven from the query string (`?series=&chapter=&page=`), which
 * is why `/read` can be a prerendered static route the service worker precaches:
 * there is nothing for the server to render per user. `useReader` owns the data
 * and the position; this component owns presentation — which view is mounted,
 * whether the chrome is showing, and what the keyboard does.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BookOpen } from "lucide-react";
import { Button, Spinner, useToast } from "@/components/ui";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useProgressErrors, useReader } from "@/hooks/use-reader";
import { formatChapterLabel } from "@/lib/reader/chapters";
import { buildSpreads, singleSpreads, spreadIndexForPage } from "@/lib/reader/pairing";
import {
  cycleValue,
  READER_BACKGROUND_COLORS,
  READER_FITS,
  READER_FOREGROUND_COLORS,
  READER_MODES,
} from "@/lib/reader/prefs";
import { parseReaderParams, type ReaderRouteParams } from "@/lib/reader/url";
import { useReaderNotes } from "./notes-overlay";
import { ChapterEndCard } from "./chapter-end-card";
import { ChapterPicker } from "./chapter-picker";
import { PagedView } from "./paged-view";
import { ReaderBottomBar } from "./reader-bottom-bar";
import { ReaderSettings } from "./reader-settings";
import { ReaderTopBar } from "./reader-top-bar";
import { StripView, type StripJump } from "./strip-view";

/** Idle time before the chrome slides away in the paged modes. */
const CHROME_HIDE_MS = 2500;
const MOUSE_ACTIVITY_THROTTLE_MS = 200;
/** Double-page layout only makes sense with room for two pages. */
const WIDE_QUERY = "(min-width: 1024px), (orientation: landscape) and (min-width: 640px)";

function CenteredMessage({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center">
      <BookOpen className="h-8 w-8 opacity-50" aria-hidden="true" />
      <h1 className="text-base font-semibold">{title}</h1>
      {description ? <p className="max-w-sm text-sm opacity-70">{description}</p> : null}
      {action}
    </div>
  );
}

/**
 * Reads the query string and mounts the reader for it.
 *
 * The `key` is the point: the reader treats `chapter`/`page` as seeds it then
 * owns (and rewrites with `history.replaceState`), so those changing must not
 * disturb it — but navigating to a *different series* has to start over, and a
 * remount is the honest way to say that.
 */
export function ReaderShell() {
  const searchParams = useSearchParams();
  const route = parseReaderParams(searchParams);
  return <ReaderSurface key={route.seriesId ?? "none"} route={route} />;
}

function ReaderSurface({ route }: { route: ReaderRouteParams }) {
  const router = useRouter();
  const { toast } = useToast();

  const reader = useReader(route);
  const {
    seriesId,
    seriesTitle,
    chapters,
    chapter,
    chapterId,
    chapterNotFound,
    hasNoReadableChapters,
    listQuery,
    chapterQuery,
    pages,
    pageIndex,
    pageCount,
    prefs,
    prevChapter,
    nextChapter,
    goToPage,
    goToChapter,
    goToPrevChapter,
    goToNextChapter,
    markCurrentChapterRead,
  } = reader;

  // --- layout mode ---------------------------------------------------------

  const isWide = useMediaQuery(WIDE_QUERY);
  const mode = prefs.mode === "double" && !isWide ? "single" : prefs.mode;

  const spreads = useMemo(() => {
    if (mode === "strip") return [];
    return mode === "double"
      ? buildSpreads(pages, { coverFirst: prefs.coverFirst, direction: prefs.direction })
      : singleSpreads(pages);
  }, [mode, pages, prefs.coverFirst, prefs.direction]);

  const spreadIndex = useMemo(() => spreadIndexForPage(spreads, pageIndex), [spreads, pageIndex]);

  // --- notes ---------------------------------------------------------------

  const chapterLabel = chapter ? formatChapterLabel(chapter) : "";
  const currentPageNumber = pages[pageIndex]?.index ?? pageIndex + 1;

  // Markers inside each page container plus the panel; everything the feature
  // needs lives in `notes-overlay.tsx`.
  const notes = useReaderNotes({
    seriesId,
    chapterId,
    chapter: chapter
      ? {
          id: chapter.id,
          title: chapter.title,
          number: chapter.number,
          sortIndex: chapter.sortIndex,
        }
      : null,
    chapterLabel,
    pageNumber: currentPageNumber,
  });

  // --- chrome --------------------------------------------------------------

  const [chromeVisible, setChromeVisible] = useState(true);
  const [activity, setActivity] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [endCardOpen, setEndCardOpen] = useState(false);
  const dialogOpen = settingsOpen || pickerOpen || notes.open;

  const showChrome = useCallback(() => {
    setChromeVisible(true);
    setActivity((value) => value + 1);
  }, []);

  useEffect(() => {
    if (mode === "strip" || !chromeVisible || dialogOpen) return;
    const timer = setTimeout(() => setChromeVisible(false), CHROME_HIDE_MS);
    return () => clearTimeout(timer);
  }, [mode, chromeVisible, dialogOpen, activity]);

  useEffect(() => {
    let last = 0;
    const onMouseMove = () => {
      const now = Date.now();
      if (now - last < MOUSE_ACTIVITY_THROTTLE_MS) return;
      last = now;
      showChrome();
    };
    window.addEventListener("mousemove", onMouseMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMouseMove);
  }, [showChrome]);

  const toggleChrome = useCallback(() => {
    setChromeVisible((visible) => !visible);
    setActivity((value) => value + 1);
  }, []);

  // --- navigation ----------------------------------------------------------

  const jumpToken = useRef(0);
  const [jump, setJump] = useState<StripJump | null>(null);

  const jumpToPage = useCallback(
    (index: number) => {
      goToPage(index);
      jumpToken.current += 1;
      setJump({ index, token: jumpToken.current });
    },
    [goToPage],
  );

  // A chapter change has to move the strip back to the top (or to the last page
  // when arriving from "previous chapter"), which scrolling alone won't do.
  const jumpedChapterRef = useRef<string | null>(null);
  useEffect(() => {
    if (!chapterId || pages.length === 0) return;
    if (jumpedChapterRef.current === chapterId) return;
    jumpedChapterRef.current = chapterId;
    jumpToken.current += 1;
    setJump({ index: pageIndex, token: jumpToken.current });
    setEndCardOpen(false);
  }, [chapterId, pages.length, pageIndex]);

  const advance = useCallback(
    (delta: 1 | -1) => {
      if (mode === "strip") {
        const target = pageIndex + delta;
        if (target < 0) {
          if (prevChapter) goToPrevChapter();
          return;
        }
        if (pageCount > 0 && target > pageCount - 1) {
          setEndCardOpen(true);
          return;
        }
        jumpToPage(target);
        return;
      }

      const target = spreadIndex + delta;
      if (target < 0) {
        if (prevChapter) goToPrevChapter();
        return;
      }
      if (target > spreads.length - 1) {
        setEndCardOpen(true);
        return;
      }
      const spread = spreads[target];
      if (spread) goToPage(spread.firstPageIndex);
    },
    [
      mode,
      pageIndex,
      pageCount,
      spreadIndex,
      spreads,
      prevChapter,
      goToPrevChapter,
      goToPage,
      jumpToPage,
    ],
  );

  const exitToSeries = useCallback(() => {
    router.push(seriesId ? `/series/${seriesId}` : "/");
  }, [router, seriesId]);

  const markReadAndExit = useCallback(() => {
    markCurrentChapterRead();
    exitToSeries();
  }, [markCurrentChapterRead, exitToSeries]);

  // --- keyboard ------------------------------------------------------------

  const handlers = useRef({ advance, jumpToPage, goToPrevChapter, goToNextChapter, exitToSeries });
  useEffect(() => {
    handlers.current = { advance, jumpToPage, goToPrevChapter, goToNextChapter, exitToSeries };
  }, [advance, jumpToPage, goToPrevChapter, goToNextChapter, exitToSeries]);

  const keyContext = useRef({ direction: prefs.direction, pageCount, dialogOpen });
  useEffect(() => {
    keyContext.current = { direction: prefs.direction, pageCount, dialogOpen };
  }, [prefs.direction, pageCount, dialogOpen]);

  const setPrefs = reader.setPrefs;
  const prefsRef = useRef(prefs);
  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const { direction, pageCount: count, dialogOpen: hasDialog } = keyContext.current;
      // Dialogs are native <dialog>s and handle their own Escape/arrow keys.
      if (hasDialog && event.key !== "Escape") return;

      const forward: 1 | -1 = 1;
      const backward: 1 | -1 = -1;

      switch (event.key) {
        case "ArrowRight":
          event.preventDefault();
          handlers.current.advance(direction === "rtl" ? backward : forward);
          break;
        case "ArrowLeft":
          event.preventDefault();
          handlers.current.advance(direction === "rtl" ? forward : backward);
          break;
        case " ":
        case "PageDown":
          event.preventDefault();
          handlers.current.advance(event.shiftKey ? backward : forward);
          break;
        case "PageUp":
          event.preventDefault();
          handlers.current.advance(backward);
          break;
        case "Home":
          event.preventDefault();
          handlers.current.jumpToPage(0);
          break;
        case "End":
          event.preventDefault();
          if (count > 0) handlers.current.jumpToPage(count - 1);
          break;
        case "[":
          event.preventDefault();
          handlers.current.goToPrevChapter();
          break;
        case "]":
          event.preventDefault();
          handlers.current.goToNextChapter();
          break;
        case "m":
          event.preventDefault();
          setPrefs({ mode: cycleValue(READER_MODES, prefsRef.current.mode) });
          break;
        case "f":
          event.preventDefault();
          setPrefs({ fit: cycleValue(READER_FITS, prefsRef.current.fit) });
          break;
        case "Escape":
          if (hasDialog) return;
          event.preventDefault();
          handlers.current.exitToSeries();
          break;
        default:
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setPrefs]);

  // --- offline notice ------------------------------------------------------

  const offlineToastShown = useRef(false);
  useProgressErrors(
    useCallback(() => {
      if (offlineToastShown.current) return;
      offlineToastShown.current = true;
      toast({
        title: "Progress not saved",
        description: "You appear to be offline. Your place is kept here and will sync later.",
        tone: "warning",
      });
    }, [toast]),
  );

  // --- render --------------------------------------------------------------

  const background = READER_BACKGROUND_COLORS[prefs.background];
  const foreground = READER_FOREGROUND_COLORS[prefs.background];

  let content: React.ReactNode;
  if (!seriesId) {
    content = (
      <CenteredMessage
        title="No series selected"
        description="Open a chapter from a series to start reading."
        action={
          <Button href="/" variant="secondary">
            Go to library
          </Button>
        }
      />
    );
  } else if (chapterNotFound) {
    content = (
      <CenteredMessage
        title="Chapter not found"
        description="It may have been removed, or it hasn't finished downloading."
        action={
          <Button href={`/series/${seriesId}`} variant="secondary">
            Back to series
          </Button>
        }
      />
    );
  } else if (hasNoReadableChapters) {
    content = (
      <CenteredMessage
        title="Nothing to read yet"
        description="This series has no downloaded chapters."
        action={
          <Button href={`/series/${seriesId}`} variant="secondary">
            Back to series
          </Button>
        }
      />
    );
  } else if (listQuery.isError || chapterQuery.isError) {
    const error = listQuery.error ?? chapterQuery.error;
    content = (
      <CenteredMessage
        title={error?.isOffline ? "You're offline" : "Couldn't load this chapter"}
        description={
          error?.isOffline
            ? "This chapter isn't available offline yet."
            : (error?.message ?? undefined)
        }
        action={
          <Button href={`/series/${seriesId}`} variant="secondary">
            Back to series
          </Button>
        }
      />
    );
  } else if (pages.length === 0) {
    content = (
      <div className="flex h-full w-full items-center justify-center">
        <Spinner size="lg" label="Loading chapter" />
      </div>
    );
  } else if (mode === "strip") {
    content = (
      <StripView
        pages={pages}
        fit={prefs.fit}
        showPageNumbers={prefs.showPageNumbers}
        pageIndex={pageIndex}
        onPageIndexChange={goToPage}
        onScrollDirection={(direction) => setChromeVisible(direction === "up")}
        onTap={toggleChrome}
        jump={jump}
        renderPageOverlay={notes.renderPageOverlay}
        endCard={
          <ChapterEndCard
            nextChapter={nextChapter}
            onNextChapter={goToNextChapter}
            onMarkReadAndExit={markReadAndExit}
          />
        }
      />
    );
  } else {
    content = (
      <PagedView
        spreads={spreads}
        spreadIndex={spreadIndex}
        pageCount={pageCount}
        fit={prefs.fit}
        direction={prefs.direction}
        showPageNumbers={prefs.showPageNumbers}
        slotCount={mode === "double" ? 2 : 1}
        onPrev={() => advance(-1)}
        onNext={() => advance(1)}
        onToggleChrome={toggleChrome}
        renderPageOverlay={notes.renderPageOverlay}
      />
    );
  }

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{ background, color: foreground }}
      data-reader-mode={mode}
    >
      {content}

      {endCardOpen && mode !== "strip" ? (
        <ChapterEndCard
          overlay
          nextChapter={nextChapter}
          onNextChapter={() => {
            setEndCardOpen(false);
            goToNextChapter();
          }}
          onMarkReadAndExit={markReadAndExit}
          onDismiss={() => setEndCardOpen(false)}
        />
      ) : null}

      <ReaderTopBar
        visible={chromeVisible}
        seriesId={seriesId}
        seriesTitle={seriesTitle}
        chapterTitle={chapterLabel}
        pageNumber={currentPageNumber}
        pageCount={pageCount}
        onOpenSettings={() => {
          setSettingsOpen(true);
          showChrome();
        }}
        onToggleNotes={
          seriesId
            ? () => {
                notes.toggle();
                showChrome();
              }
            : undefined
        }
        notesCount={notes.currentPageCount}
        notesOpen={notes.open}
      />

      <ReaderBottomBar
        visible={chromeVisible}
        chapterLabel={chapterLabel}
        hasPrevChapter={Boolean(prevChapter)}
        hasNextChapter={Boolean(nextChapter)}
        onPrevChapter={goToPrevChapter}
        onNextChapter={goToNextChapter}
        onOpenChapters={() => {
          setPickerOpen(true);
          showChrome();
        }}
        showSlider={mode !== "strip"}
        direction={prefs.direction}
        pageIndex={pageIndex}
        pageCount={pageCount}
        onSeekPage={jumpToPage}
      />

      <ChapterPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        chapters={chapters}
        currentChapterId={chapterId}
        onSelect={(id) => goToChapter(id)}
      />

      {notes.panel}

      <ReaderSettings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        prefs={prefs}
        onChange={setPrefs}
        scope={reader.prefScope}
        onScopeChange={reader.setPrefScope}
        mediaType={reader.mediaType}
        canScopeToSeries={Boolean(seriesId)}
      />
    </div>
  );
}
