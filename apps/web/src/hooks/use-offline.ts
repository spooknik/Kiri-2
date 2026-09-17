"use client";

/**
 * React bindings for offline mode.
 *
 * Everything below reads from the modules in `src/lib/offline`, which are the
 * source of truth and work without React (the bootstrap, the downloader and the
 * sync queue all run outside the tree). These hooks only subscribe.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { listSeriesRows, subscribeCatalog, type OfflineSeriesRow } from "@/lib/offline/catalog";
import {
  estimateUsage,
  getDownloadProgress,
  subscribeDownloadProgress,
  type DownloadProgress,
  type StorageUsage,
} from "@/lib/offline/downloads";
import { flushSyncQueue, syncQueue } from "@/lib/offline/sync-queue";
import { useOnlineStatus } from "@/hooks/use-online-status";

export interface OfflineStatus {
  online: boolean;
  /** Operations waiting to reach the server. */
  pendingOps: number;
  /** Try to send them now (the "Retry" affordance in the hub). */
  flush: () => void;
}

export function useOfflineStatus(): OfflineStatus {
  const online = useOnlineStatus();
  const pendingOps = useSyncExternalStore(
    (listener) => syncQueue.subscribe(listener),
    () => syncQueue.cachedCount(),
    () => 0,
  );

  // Seed the cached count on mount; afterwards the queue keeps it current.
  useEffect(() => {
    void syncQueue.count();
  }, []);

  const flush = useCallback(() => {
    void flushSyncQueue();
  }, []);

  return { online, pendingOps, flush };
}

export interface OfflineCatalog {
  rows: OfflineSeriesRow[];
  loading: boolean;
  refresh: () => void;
}

/** Every downloaded series, newest first. Re-reads on any catalog write. */
export function useOfflineCatalog(): OfflineCatalog {
  const [rows, setRows] = useState<OfflineSeriesRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    void listSeriesRows().then((next) => {
      setRows(next);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    refresh();
    return subscribeCatalog(refresh);
  }, [refresh]);

  return { rows, loading, refresh };
}

export interface SeriesOfflineState {
  row: OfflineSeriesRow | null;
  progress: DownloadProgress | null;
  loading: boolean;
  refresh: () => void;
}

/** The catalog row and live progress for one series. */
export function useSeriesOffline(seriesId: string): SeriesOfflineState {
  const { rows, loading, refresh } = useOfflineCatalog();
  const progress = useSyncExternalStore(
    subscribeDownloadProgress,
    () => getDownloadProgress(seriesId),
    () => null,
  );
  return {
    row: rows.find((row) => row.seriesId === seriesId) ?? null,
    progress,
    loading,
    refresh,
  };
}

/** `navigator.storage.estimate()`, refreshed whenever the catalog changes. */
export function useStorageUsage(): StorageUsage & { refresh: () => void } {
  const [usage, setUsage] = useState<StorageUsage>({
    usage: null,
    quota: null,
    available: null,
    persisted: false,
  });

  const refresh = useCallback(() => {
    void estimateUsage().then(setUsage);
  }, []);

  useEffect(() => {
    refresh();
    return subscribeCatalog(refresh);
  }, [refresh]);

  return { ...usage, refresh };
}
