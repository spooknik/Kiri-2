/**
 * Offline downloads: turn a series into bytes in CacheStorage plus a catalog
 * row in IndexedDB, so the *unmodified* reader renders it with no network.
 *
 * The reader fetches exactly two URLs per chapter (see `src/hooks/use-reader.ts`):
 * `GET /api/series/:id/chapters` and `GET /api/chapters/:id`, then one
 * `/api/pages/:id/image` per page. A download therefore writes:
 *
 *   `api`            <- the real `/api/series/:id/chapters` response
 *   `reader-content` <- one `/api/chapters/:id` response per selected chapter
 *                       (the real one; a manifest-derived stand-in only if the
 *                       fetch fails)
 *   `reader-images`  <- every page image, plus the cover
 *
 * Entries are written straight through `caches.open()` rather than by warming
 * the service worker, so a download works even on the very first visit, before
 * the worker controls the page.
 *
 * Ported from Kiri v1 (`src/lib/offline-download.ts`): the 6-way worker pool,
 * the retry/backoff ladder, the "persist the catalog every 20 images" cadence
 * and the 10 % quota headroom are the same; what is new is per-chapter
 * selection, pause/resume via `AbortController`, and precise deletion driven by
 * the stored manifest snapshot.
 */
import type { ChapterDetail, ChapterListItem, ChapterRef } from "@/lib/contracts/content";
import type { OfflineManifest } from "@/lib/contracts/offline";
import {
  API_CACHE,
  chapterDetailPath,
  chapterListPath,
  offlineManifestPath,
  READER_CONTENT_CACHE,
  READER_IMAGES_CACHE,
} from "@/lib/offline/cache-names";
import {
  deleteSeriesRow,
  getManifestSnapshot,
  getSeriesRow,
  listSeriesRows,
  notifyCatalogChanged,
  putManifestSnapshot,
  putSeriesRow,
  putSeriesRowQuiet,
  type ChapterDownloadState,
  type DownloadState,
  type OfflineChapterRow,
  type OfflineSeriesRow,
} from "@/lib/offline/catalog";
import { warmShellCache } from "@/lib/offline/shell-cache";

/** Parallel image fetches. Six keeps a phone's radio busy without stalling the UI. */
export const IMAGE_CONCURRENCY = 6;
/** Attempts per image (1 initial + 3 retries) before it is counted as failed. */
export const MAX_RETRIES = 3;
/** How often the catalog row is checkpointed during a download. */
export const CATALOG_PERSIST_EVERY = 20;
/** Require this much more free space than the download's raw size. */
export const QUOTA_HEADROOM = 1.1;

const MAX_BACKOFF_MS = 8_000;

/* -------------------------------------------------------------------------- */
/* Progress store (in-memory, subscribable)                                   */
/* -------------------------------------------------------------------------- */

export interface DownloadProgress {
  seriesId: string;
  state: DownloadState;
  totalImages: number;
  downloadedImages: number;
  failedImages: number;
  totalBytes: number;
  downloadedBytes: number;
}

const progressBySeries = new Map<string, DownloadProgress>();
const progressListeners = new Set<() => void>();

/** Returns an unsubscribe function. */
export function subscribeDownloadProgress(listener: () => void): () => void {
  progressListeners.add(listener);
  return () => {
    progressListeners.delete(listener);
  };
}

/** Stable snapshot for `useSyncExternalStore`: identity only changes on update. */
export function getDownloadProgress(seriesId: string): DownloadProgress | null {
  return progressBySeries.get(seriesId) ?? null;
}

function setProgress(next: DownloadProgress): void {
  progressBySeries.set(next.seriesId, next);
  for (const listener of [...progressListeners]) {
    try {
      listener();
    } catch {
      // A broken subscriber must not abort a download.
    }
  }
}

function clearProgress(seriesId: string): void {
  progressBySeries.delete(seriesId);
  for (const listener of [...progressListeners]) {
    try {
      listener();
    } catch {
      /* see above */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Storage estimation and quota (pure where it matters)                       */
/* -------------------------------------------------------------------------- */

export interface QuotaCheck {
  ok: boolean;
  /** Bytes the download needs, before headroom. */
  required: number;
  /** null when the browser does not expose an estimate — then `ok` is true. */
  available: number | null;
  quota: number | null;
  usage: number | null;
}

/**
 * Pure quota math, so the "is there room?" rule is testable without a browser.
 * An unknown estimate is treated as "go ahead": refusing a download because a
 * browser withholds numbers would be worse than running out of space, which the
 * per-image failure path already handles by marking the series `partial`.
 */
export function evaluateQuota(
  requiredBytes: number,
  estimate: { quota?: number; usage?: number } | null,
): QuotaCheck {
  const quota = typeof estimate?.quota === "number" ? estimate.quota : null;
  const usage = typeof estimate?.usage === "number" ? estimate.usage : null;
  if (quota === null || usage === null) {
    return { ok: true, required: requiredBytes, available: null, quota: null, usage: null };
  }
  const available = quota - usage;
  return {
    ok: available >= requiredBytes * QUOTA_HEADROOM,
    required: requiredBytes,
    available,
    quota,
    usage,
  };
}

export interface StorageUsage {
  usage: number | null;
  quota: number | null;
  available: number | null;
  persisted: boolean;
}

export async function estimateUsage(): Promise<StorageUsage> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
    return { usage: null, quota: null, available: null, persisted: false };
  }
  try {
    const [{ quota, usage }, persisted] = await Promise.all([
      navigator.storage.estimate(),
      navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(false),
    ]);
    const known = typeof quota === "number" && typeof usage === "number";
    return {
      usage: usage ?? null,
      quota: quota ?? null,
      available: known ? quota - usage : null,
      persisted,
    };
  } catch {
    return { usage: null, quota: null, available: null, persisted: false };
  }
}

/** Ask the browser to make storage durable. Best effort; iOS often says no. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
    if (navigator.storage.persisted && (await navigator.storage.persisted())) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Manifest                                                                   */
/* -------------------------------------------------------------------------- */

export class OfflineDownloadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OfflineDownloadError";
    this.code = code;
  }
}

export async function fetchOfflineManifest(
  seriesId: string,
  signal?: AbortSignal,
): Promise<OfflineManifest> {
  const response = await fetch(offlineManifestPath(seriesId), {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new OfflineDownloadError(
      `HTTP_${response.status}`,
      response.status === 401
        ? "Sign in again to download this series"
        : "Could not load the offline manifest",
    );
  }
  return (await response.json()) as OfflineManifest;
}

/**
 * Narrow a manifest to the chapters the user picked (all of them by default),
 * recomputing `totalBytes` so the quota check and the progress bar agree.
 * Pure — the selection dialog and the tests use it directly.
 */
export function selectChapters(
  manifest: OfflineManifest,
  chapterIds?: readonly string[],
): OfflineManifest {
  if (!chapterIds) return manifest;
  const wanted = new Set(chapterIds);
  const chapters = manifest.chapters.filter((chapter) => wanted.has(chapter.id));
  return {
    ...manifest,
    chapters,
    totalBytes: chapters.reduce((total, chapter) => total + chapter.bytes, 0),
  };
}

/**
 * A `ChapterDetail` built from the manifest, used only when the real
 * `/api/chapters/:id` response could not be fetched at download time. `prev`
 * and `next` point inside the downloaded subset, which is the honest answer
 * offline. Pure.
 */
export function synthesizeChapterDetail(
  manifest: OfflineManifest,
  index: number,
): ChapterDetail | null {
  const chapter = manifest.chapters[index];
  if (!chapter) return null;

  const toRef = (position: number): ChapterRef | null => {
    const neighbour = manifest.chapters[position];
    if (!neighbour) return null;
    return {
      id: neighbour.id,
      slug: neighbour.slug,
      title: neighbour.title,
      number: neighbour.number,
      pageCount: neighbour.pageCount,
    };
  };

  const listItem: ChapterListItem = {
    id: chapter.id,
    slug: chapter.slug,
    title: chapter.title,
    number: chapter.number,
    pageCount: chapter.pageCount,
    volume: null,
    status: "COMPLETED",
    origin: "PLUGIN",
    bytes: chapter.bytes,
    sourceUrl: null,
    releaseDate: null,
    downloadedAt: manifest.generatedAt,
    sortIndex: chapter.sortIndex,
    // Read state is per-user and lives on the server; offline the reader
    // re-derives it from the chapter list response, which is cached separately.
    read: false,
    readAt: null,
    createdAt: manifest.generatedAt,
    updatedAt: manifest.generatedAt,
  };

  return {
    ...listItem,
    seriesId: manifest.series.id,
    seriesTitle: manifest.series.title,
    pages: chapter.pages.map((page) => ({
      id: page.id,
      index: page.index,
      url: page.url,
      width: page.width,
      height: page.height,
      bytes: page.bytes,
      mime: null,
    })),
    prev: toRef(index - 1),
    next: toRef(index + 1),
  };
}

/* -------------------------------------------------------------------------- */
/* Fetch helpers                                                              */
/* -------------------------------------------------------------------------- */

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Retries 5xx/429 and network errors with exponential backoff; 4xx gives up. */
async function fetchWithRetry(url: string, signal?: AbortSignal): Promise<Response | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const response = await fetch(url, { signal, credentials: "same-origin" });
      if (response.ok) return response;
      if (response.status >= 500 || response.status === 429) {
        if (attempt === MAX_RETRIES) return null;
        await delay(Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt), signal);
        continue;
      }
      return null;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (attempt === MAX_RETRIES) return null;
      await delay(Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt), signal);
    }
  }
  return null;
}

function absoluteUrl(path: string): string {
  return new URL(path, location.origin).toString();
}

/* -------------------------------------------------------------------------- */
/* Download                                                                   */
/* -------------------------------------------------------------------------- */

export interface DownloadOptions {
  /** Subset of chapter ids; omitted means every chapter in the manifest. */
  chapterIds?: readonly string[];
  onProgress?: (progress: DownloadProgress) => void;
}

const controllers = new Map<string, AbortController>();

/** True while a download for this series is running (and can be paused). */
export function isDownloading(seriesId: string): boolean {
  return controllers.has(seriesId);
}

/** Stops an in-flight download; the catalog row is left in the `paused` state. */
export function pauseDownload(seriesId: string): void {
  controllers.get(seriesId)?.abort();
}

/**
 * Restarts a paused or partial download from the stored manifest snapshot.
 * Images already in `reader-images` are skipped, so this is cheap.
 */
export async function resumeDownload(
  seriesId: string,
  options: DownloadOptions = {},
): Promise<OfflineSeriesRow> {
  const snapshot = await getManifestSnapshot(seriesId);
  if (!snapshot) {
    // Nothing stored (cleared storage, upgraded browser): start from scratch.
    return downloadSeries(seriesId, options);
  }
  return runDownload(seriesId, snapshot, options);
}

/** Fetches the manifest, checks quota, then downloads. */
export async function downloadSeries(
  seriesId: string,
  options: DownloadOptions = {},
): Promise<OfflineSeriesRow> {
  await requestPersistentStorage();
  // Downloading is the strongest signal that this session will want to read
  // offline, and the user is definitely signed in right now — the one moment
  // the reader shell is guaranteed to be fetchable.
  void warmShellCache();

  const controller = new AbortController();
  const full = await fetchOfflineManifest(seriesId, controller.signal);
  const manifest = selectChapters(full, options.chapterIds);
  if (manifest.chapters.length === 0) {
    throw new OfflineDownloadError("EMPTY", "This series has no downloadable chapters yet");
  }

  const estimate =
    typeof navigator !== "undefined" && navigator.storage?.estimate
      ? await navigator.storage.estimate().catch(() => null)
      : null;
  const quota = evaluateQuota(manifest.totalBytes, estimate);
  if (!quota.ok) {
    throw new OfflineDownloadError(
      "QUOTA",
      "Not enough free storage for this series. Remove a downloaded series and try again.",
    );
  }

  return runDownload(seriesId, manifest, options);
}

async function runDownload(
  seriesId: string,
  manifest: OfflineManifest,
  options: DownloadOptions,
): Promise<OfflineSeriesRow> {
  const existing = controllers.get(seriesId);
  if (existing) existing.abort();

  const controller = new AbortController();
  controllers.set(seriesId, controller);
  const { signal } = controller;

  await putManifestSnapshot(seriesId, manifest);

  const chapterRows: OfflineChapterRow[] = manifest.chapters.map((chapter) => ({
    id: chapter.id,
    title: chapter.title,
    number: chapter.number,
    pageCount: chapter.pageCount,
    bytes: chapter.bytes,
    state: "pending" as ChapterDownloadState,
  }));

  const row: OfflineSeriesRow = {
    seriesId,
    title: manifest.series.title,
    coverUrl: manifest.series.coverUrl,
    chapters: chapterRows,
    totalBytes: manifest.totalBytes,
    downloadedBytes: 0,
    state: "downloading",
    updatedAt: Date.now(),
    error: null,
  };
  await putSeriesRow(row);

  const images = manifest.chapters.flatMap((chapter) =>
    chapter.pages.map((page) => ({ chapterId: chapter.id, url: page.url, bytes: page.bytes })),
  );

  let downloadedImages = 0;
  let downloadedBytes = 0;
  let failedImages = 0;
  const failedByChapter = new Map<string, number>();

  const emit = (state: DownloadState) => {
    const progress: DownloadProgress = {
      seriesId,
      state,
      totalImages: images.length,
      downloadedImages,
      failedImages,
      totalBytes: manifest.totalBytes,
      downloadedBytes,
    };
    setProgress(progress);
    options.onProgress?.(progress);
  };
  emit("downloading");

  try {
    const [imageCache, contentCache, apiCache] = await Promise.all([
      caches.open(READER_IMAGES_CACHE),
      caches.open(READER_CONTENT_CACHE),
      caches.open(API_CACHE),
    ]);

    // 1. The chapter list the reader opens with, and the cover the hub shows.
    await cacheThrough(apiCache, chapterListPath(seriesId), signal);
    if (manifest.series.coverUrl) {
      await cacheThrough(imageCache, manifest.series.coverUrl, signal);
    }

    // 2. One chapter-detail response per chapter: the real one when it can be
    //    fetched, a manifest-derived stand-in otherwise.
    for (const [index, chapter] of manifest.chapters.entries()) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const url = chapterDetailPath(chapter.id);
      const cached = await cacheThrough(contentCache, url, signal);
      if (!cached) {
        const detail = synthesizeChapterDetail(manifest, index);
        if (detail) {
          await contentCache.put(
            absoluteUrl(url),
            new Response(JSON.stringify(detail), {
              status: 200,
              headers: { "Content-Type": "application/json; charset=utf-8" },
            }),
          );
        }
      }
    }

    // 3. Page images, six at a time.
    let next = 0;
    let sinceCheckpoint = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        const current = next;
        next += 1;
        const image = images[current];
        if (!image) return;

        const already = await imageCache.match(image.url, { ignoreVary: true });
        if (already) {
          downloadedImages += 1;
          downloadedBytes += image.bytes;
        } else {
          const response = await fetchWithRetry(image.url, signal);
          if (response) {
            const bytes = await response
              .clone()
              .arrayBuffer()
              .then((buffer) => buffer.byteLength)
              .catch(() => image.bytes);
            await imageCache.put(absoluteUrl(image.url), response);
            downloadedImages += 1;
            downloadedBytes += bytes;
          } else {
            failedImages += 1;
            failedByChapter.set(image.chapterId, (failedByChapter.get(image.chapterId) ?? 0) + 1);
          }
        }

        emit("downloading");
        sinceCheckpoint += 1;
        if (sinceCheckpoint >= CATALOG_PERSIST_EVERY) {
          sinceCheckpoint = 0;
          await putSeriesRowQuiet({ ...row, downloadedBytes, state: "downloading" });
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(IMAGE_CONCURRENCY, Math.max(images.length, 1)) }, worker),
    );

    const finalChapters = chapterRows.map((chapter) => ({
      ...chapter,
      state: (failedByChapter.get(chapter.id) ? "partial" : "ready") as ChapterDownloadState,
    }));
    const finalRow: OfflineSeriesRow = {
      ...row,
      chapters: finalChapters,
      downloadedBytes,
      state: failedImages > 0 ? "partial" : "ready",
      error: failedImages > 0 ? `${failedImages} image(s) could not be downloaded` : null,
      updatedAt: Date.now(),
    };
    await putSeriesRow(finalRow);
    emit(finalRow.state);
    return finalRow;
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === "AbortError";
    const pausedRow: OfflineSeriesRow = {
      ...row,
      downloadedBytes,
      state: aborted ? "paused" : "error",
      error: aborted ? null : error instanceof Error ? error.message : "Download failed",
      updatedAt: Date.now(),
    };
    await putSeriesRow(pausedRow);
    emit(pausedRow.state);
    if (!aborted) throw error;
    return pausedRow;
  } finally {
    if (controllers.get(seriesId) === controller) controllers.delete(seriesId);
  }
}

/**
 * Fetch `path` and store the response under its absolute URL. Returns false
 * when the fetch failed, so callers can fall back.
 */
async function cacheThrough(cache: Cache, path: string, signal: AbortSignal): Promise<boolean> {
  const response = await fetchWithRetry(path, signal);
  if (!response) return false;
  try {
    await cache.put(absoluteUrl(path), response);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Removal                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Remove one series' offline data. Page image URLs carry no series id, so the
 * stored manifest snapshot is what makes this precise; if it is gone we can
 * still drop the chapter-detail and chapter-list entries recorded in the row.
 */
export async function deleteSeriesOffline(seriesId: string): Promise<void> {
  pauseDownload(seriesId);
  const [snapshot, row] = await Promise.all([
    getManifestSnapshot(seriesId),
    getSeriesRow(seriesId),
  ]);

  const imageUrls = new Set<string>();
  const contentUrls = new Set<string>();

  if (snapshot) {
    for (const chapter of snapshot.chapters) {
      contentUrls.add(chapterDetailPath(chapter.id));
      for (const page of chapter.pages) imageUrls.add(page.url);
    }
    if (snapshot.series.coverUrl) imageUrls.add(snapshot.series.coverUrl);
  }
  if (row) {
    for (const chapter of row.chapters) contentUrls.add(chapterDetailPath(chapter.id));
    if (row.coverUrl) imageUrls.add(row.coverUrl);
  }

  await Promise.all([
    deleteFromCache(READER_IMAGES_CACHE, [...imageUrls]),
    deleteFromCache(READER_CONTENT_CACHE, [...contentUrls]),
    deleteFromCache(API_CACHE, [chapterListPath(seriesId), offlineManifestPath(seriesId)]),
  ]);

  clearProgress(seriesId);
  await deleteSeriesRow(seriesId);
}

async function deleteFromCache(cacheName: string, urls: string[]): Promise<void> {
  if (urls.length === 0 || typeof caches === "undefined") return;
  try {
    const cache = await caches.open(cacheName);
    await Promise.all(urls.map((url) => cache.delete(url, { ignoreVary: true })));
  } catch {
    // Best effort: a stale cache entry costs space, not correctness.
  }
}

/** Drop every offline cache and catalog row (profile "clear downloads"). */
export async function clearAllOffline(): Promise<void> {
  const rows = await listSeriesRows();
  await Promise.all(rows.map((row) => deleteSeriesOffline(row.seriesId)));
  notifyCatalogChanged();
}
