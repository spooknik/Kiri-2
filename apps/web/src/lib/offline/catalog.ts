/**
 * The offline catalog: what the user has downloaded, and enough of the
 * manifest to resume, verify and delete it precisely.
 *
 * One row per series in IndexedDB (`db.ts`), plus a stored copy of the exact
 * manifest subset that was downloaded. The manifest snapshot matters because
 * page URLs are `/api/pages/:id/image` — they carry no series id, so without it
 * there is no way to find "this series' images" in CacheStorage again.
 *
 * Subscribers (`subscribeCatalog`) are notified on every write so the hub and
 * the download button re-render without polling.
 */
import type { OfflineManifest } from "@/lib/contracts/offline";
import {
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
  STORE_CATALOG,
  STORE_MANIFESTS,
} from "@/lib/offline/db";

/** Series-level download state. `partial` = some chapters/images are missing. */
export type DownloadState = "downloading" | "paused" | "ready" | "partial" | "error";

/** Per-chapter state; `partial` means the chapter's bytes were evicted or never finished. */
export type ChapterDownloadState = "pending" | "ready" | "partial" | "error";

export interface OfflineChapterRow {
  id: string;
  title: string;
  number: number | null;
  pageCount: number;
  bytes: number;
  state: ChapterDownloadState;
}

export interface OfflineSeriesRow {
  seriesId: string;
  title: string;
  coverUrl: string | null;
  chapters: OfflineChapterRow[];
  totalBytes: number;
  downloadedBytes: number;
  state: DownloadState;
  /** Epoch ms of the last catalog write. */
  updatedAt: number;
  error?: string | null;
}

/** The downloaded manifest subset, keyed by series id. */
export interface OfflineManifestRow {
  seriesId: string;
  manifest: OfflineManifest;
  savedAt: number;
}

/* -------------------------------------------------------------------------- */
/* Change notifications                                                       */
/* -------------------------------------------------------------------------- */

type Listener = () => void;
const listeners = new Set<Listener>();

/** Returns an unsubscribe function; safe to call during SSR (no-op). */
export function subscribeCatalog(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyCatalogChanged(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A broken subscriber must never break a download.
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

export function getSeriesRow(seriesId: string): Promise<OfflineSeriesRow | null> {
  return idbGet<OfflineSeriesRow>(STORE_CATALOG, seriesId);
}

export async function listSeriesRows(): Promise<OfflineSeriesRow[]> {
  const rows = await idbGetAll<OfflineSeriesRow>(STORE_CATALOG);
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function putSeriesRow(row: OfflineSeriesRow): Promise<void> {
  await idbPut(STORE_CATALOG, { ...row, updatedAt: Date.now() });
  notifyCatalogChanged();
}

/** Silent variant for the download loop's periodic checkpoints. */
export async function putSeriesRowQuiet(row: OfflineSeriesRow): Promise<void> {
  await idbPut(STORE_CATALOG, { ...row, updatedAt: Date.now() });
}

export async function deleteSeriesRow(seriesId: string): Promise<void> {
  await idbDelete(STORE_CATALOG, seriesId);
  await idbDelete(STORE_MANIFESTS, seriesId);
  notifyCatalogChanged();
}

/* -------------------------------------------------------------------------- */
/* Manifest snapshots                                                         */
/* -------------------------------------------------------------------------- */

export async function putManifestSnapshot(
  seriesId: string,
  manifest: OfflineManifest,
): Promise<void> {
  await idbPut(STORE_MANIFESTS, {
    seriesId,
    manifest,
    savedAt: Date.now(),
  } satisfies OfflineManifestRow);
}

export async function getManifestSnapshot(seriesId: string): Promise<OfflineManifest | null> {
  const row = await idbGet<OfflineManifestRow>(STORE_MANIFESTS, seriesId);
  return row?.manifest ?? null;
}

/* -------------------------------------------------------------------------- */
/* Derived helpers (pure)                                                     */
/* -------------------------------------------------------------------------- */

/** Chapters whose bytes are believed to be present. */
export function readyChapters(row: OfflineSeriesRow): OfflineChapterRow[] {
  return row.chapters.filter((chapter) => chapter.state === "ready");
}

/** Where "continue reading" should land for a downloaded series, or null. */
export function firstReadableChapterId(row: OfflineSeriesRow): string | null {
  const ready = readyChapters(row);
  return ready[0]?.id ?? row.chapters[0]?.id ?? null;
}

/** 0..1, for the progress bar. Returns 1 for an empty (zero-byte) download. */
export function downloadFraction(row: { totalBytes: number; downloadedBytes: number }): number {
  if (row.totalBytes <= 0) return 1;
  return Math.min(1, Math.max(0, row.downloadedBytes / row.totalBytes));
}
