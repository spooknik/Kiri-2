/**
 * Startup reconciliation: the catalog says what *should* be offline, the
 * caches say what actually is. A browser can evict CacheStorage at any time
 * (iOS does it aggressively, and quota pressure does it everywhere) without
 * telling the app, so a row claiming `ready` is a claim, not a fact.
 *
 * `reconcileCatalog()` runs once from `OfflineBootstrap` and downgrades rows
 * whose bytes are gone, so the hub never offers "continue reading" on a chapter
 * that would render a blank page.
 *
 * Verification is sampled, not exhaustive: a chapter counts as present when its
 * `/api/chapters/:id` payload is cached *and* its first and last page images
 * are. Checking every image of a 4 000-page library on every cold start would
 * cost more than it is worth, and eviction is all-or-nothing per cache in
 * practice.
 */
import {
  chapterDetailPath,
  READER_CONTENT_CACHE,
  READER_IMAGES_CACHE,
} from "@/lib/offline/cache-names";
import { isDownloading } from "@/lib/offline/downloads";
import {
  getManifestSnapshot,
  listSeriesRows,
  putSeriesRow,
  type ChapterDownloadState,
  type DownloadState,
  type OfflineSeriesRow,
} from "@/lib/offline/catalog";

/** What the cache probe found for one chapter. */
export interface ChapterPresence {
  chapterId: string;
  hasContent: boolean;
  /** False when a sampled page image is missing. True when there is nothing to sample. */
  hasImages: boolean;
}

/**
 * Pure: fold cache-presence findings into an updated row.
 *
 * - a chapter with content and images stays/becomes `ready`;
 * - a chapter missing either becomes `partial`;
 * - the series is `ready` only when every chapter is, `error` when none is,
 *   and `partial` in between. A row still `downloading`/`paused` when the tab
 *   was closed is treated the same way: whatever is verifiably there is what it
 *   has.
 */
export function reconcileRow(
  row: OfflineSeriesRow,
  presence: readonly ChapterPresence[],
): OfflineSeriesRow {
  const byId = new Map(presence.map((entry) => [entry.chapterId, entry]));

  const chapters = row.chapters.map((chapter) => {
    const found = byId.get(chapter.id);
    const state: ChapterDownloadState =
      found && found.hasContent && found.hasImages ? "ready" : "partial";
    return chapter.state === state ? chapter : { ...chapter, state };
  });

  const readyCount = chapters.filter((chapter) => chapter.state === "ready").length;
  let state: DownloadState;
  if (chapters.length === 0) {
    state = "error";
  } else if (readyCount === chapters.length) {
    state = "ready";
  } else if (readyCount === 0) {
    state = "error";
  } else {
    state = "partial";
  }

  const error =
    state === "ready"
      ? null
      : state === "error"
        ? "The downloaded files were removed by the browser. Download again to read offline."
        : "Some chapters were removed by the browser. Download again to restore them.";

  return { ...row, chapters, state, error };
}

/** True when this row's state changed in a way worth persisting. */
export function rowChanged(before: OfflineSeriesRow, after: OfflineSeriesRow): boolean {
  if (before.state !== after.state) return true;
  return before.chapters.some((chapter, index) => chapter.state !== after.chapters[index]?.state);
}

async function probeSeries(row: OfflineSeriesRow): Promise<ChapterPresence[]> {
  const [contentCache, imageCache, snapshot] = await Promise.all([
    caches.open(READER_CONTENT_CACHE),
    caches.open(READER_IMAGES_CACHE),
    getManifestSnapshot(row.seriesId),
  ]);
  const pagesByChapter = new Map(
    (snapshot?.chapters ?? []).map((chapter) => [chapter.id, chapter.pages] as const),
  );

  return Promise.all(
    row.chapters.map(async (chapter) => {
      const hasContent = Boolean(
        await contentCache.match(chapterDetailPath(chapter.id), { ignoreVary: true }),
      );
      const pages = pagesByChapter.get(chapter.id) ?? [];
      const sampled = [pages[0], pages[pages.length - 1]].filter(
        (page): page is NonNullable<(typeof pages)[number]> => Boolean(page),
      );
      const found = await Promise.all(
        sampled.map((page) => imageCache.match(page.url, { ignoreVary: true })),
      );
      return {
        chapterId: chapter.id,
        hasContent,
        hasImages: found.every(Boolean),
      };
    }),
  );
}

/**
 * Verify every catalog row against CacheStorage, persisting the ones that
 * moved. Never throws: reconciliation is a nicety, not a precondition.
 */
export async function reconcileCatalog(): Promise<OfflineSeriesRow[]> {
  if (typeof caches === "undefined") return [];
  try {
    const rows = await listSeriesRows();
    const reconciled: OfflineSeriesRow[] = [];
    for (const row of rows) {
      // Only a download running in *this tab* owns its row. Checking the live
      // AbortController registry rather than the stored state matters: a tab
      // closed mid-download leaves a row stuck on `downloading`, and treating
      // that as untouchable would strand it forever.
      if (isDownloading(row.seriesId)) {
        reconciled.push(row);
        continue;
      }
      const next = reconcileRow(row, await probeSeries(row));
      if (rowChanged(row, next)) {
        await putSeriesRow(next);
      }
      reconciled.push(next);
    }
    return reconciled;
  } catch {
    return [];
  }
}
