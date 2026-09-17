"use client";

import { BookOpen, CloudOff, Library, RefreshCw, Trash2, Wifi } from "lucide-react";
import { Button, Card, EmptyState, Spinner } from "@/components/ui";
import { useOfflineCatalog, useOfflineStatus } from "@/hooks/use-offline";
import {
  downloadFraction,
  firstReadableChapterId,
  type OfflineSeriesRow,
} from "@/lib/offline/catalog";
import { deleteSeriesOffline } from "@/lib/offline/downloads";
import { buildReadHref } from "@/lib/reader-url";
import { formatBytes } from "@/lib/format";
import { StorageUsage } from "./storage-usage";

/** Secondary-button styling for the plain anchors this page uses. */
const linkButtonClass =
  "focus-ring inline-flex h-9 min-w-9 select-none items-center justify-center gap-1.5 rounded-md border border-card-border bg-surface-2 px-3 text-sm font-medium text-foreground transition-colors hover:bg-card-border/60";

/**
 * `/offline` — the one page that works with no network at all.
 *
 * Client-rendered with zero data dependencies (everything comes from
 * IndexedDB and CacheStorage) so its HTML shell can be precached and served as
 * the navigation fallback. It is also a perfectly ordinary page online, which
 * is why the bottom nav links to it: "what have I got downloaded?" is a
 * question people ask before they lose signal, not after.
 *
 * Every link out of this page is a plain `<a>`, never `next/link` or
 * `AppLink`: a client-side transition would fetch an RSC payload the service
 * worker has never cached, whereas a full navigation is served straight from
 * the precached shell (`/read`) or the `pages` cache (`/`).
 */
export function OfflineHub() {
  const { rows, loading } = useOfflineCatalog();
  const { online, pendingOps, flush } = useOfflineStatus();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-4 px-4 py-6 pb-24">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold text-foreground">Offline</h1>
        <p className="text-sm text-muted">
          Chapters you&apos;ve downloaded are readable without a connection.
        </p>
      </header>

      <div
        className={
          online
            ? "flex items-center gap-2 rounded-lg border border-success/30 bg-success-light px-3 py-2 text-sm text-success"
            : "flex items-center gap-2 rounded-lg border border-warning/30 bg-warning-light px-3 py-2 text-sm text-warning"
        }
        role="status"
      >
        {online ? (
          <Wifi className="h-4 w-4" aria-hidden="true" />
        ) : (
          <CloudOff className="h-4 w-4" aria-hidden="true" />
        )}
        <span className="flex-1">{online ? "Back online" : "You're offline"}</span>
      </div>

      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">Storage</h2>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a full
              navigation is the point: next/link would fetch an RSC payload. */}
          <a href="/" className="focus-ring rounded text-xs text-primary hover:underline">
            <span className="inline-flex items-center gap-1">
              <Library className="h-3.5 w-3.5" aria-hidden="true" /> Library
            </span>
          </a>
        </div>
        <StorageUsage />
        <div
          className="flex items-center justify-between gap-2 text-xs text-muted"
          data-testid="pending-sync"
          data-pending={pendingOps}
        >
          <span>
            {pendingOps === 0
              ? "Everything is synced"
              : `${pendingOps} change${pendingOps === 1 ? "" : "s"} waiting to sync`}
          </span>
          {pendingOps > 0 ? (
            <button
              type="button"
              onClick={flush}
              className="focus-ring inline-flex items-center gap-1 rounded text-primary hover:underline"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Sync now
            </button>
          ) : null}
        </div>
      </Card>

      {loading ? (
        <div className="flex justify-center py-10">
          <Spinner label="Loading downloads" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={CloudOff}
          title="Nothing downloaded yet"
          description="Open a series and choose Download for offline to read it without a connection."
          action={
            // eslint-disable-next-line @next/next/no-html-link-for-pages -- see above
            <a href="/" className={linkButtonClass}>
              Go to library
            </a>
          }
        />
      ) : (
        <ul className="flex flex-col gap-3" data-testid="offline-series-list">
          {rows.map((row) => (
            <OfflineSeriesCard key={row.seriesId} row={row} />
          ))}
        </ul>
      )}
    </main>
  );
}

function OfflineSeriesCard({ row }: { row: OfflineSeriesRow }) {
  const readyCount = row.chapters.filter((chapter) => chapter.state === "ready").length;
  const chapterId = firstReadableChapterId(row);
  const percent = Math.round(downloadFraction(row) * 100);

  return (
    <li>
      <Card className="flex gap-3 p-3" data-series-id={row.seriesId}>
        <div className="h-24 w-16 shrink-0 overflow-hidden rounded bg-surface-2">
          {row.coverUrl ? (
            // Plain <img>: next/image would route through the optimizer, which
            // is exactly the network round trip this page cannot make.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={row.coverUrl}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
              decoding="async"
            />
          ) : null}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="truncate text-sm font-medium text-foreground">{row.title}</p>
          <p className="text-xs text-muted">
            {readyCount} chapter{readyCount === 1 ? "" : "s"} offline ·{" "}
            {formatBytes(row.downloadedBytes)}
            {row.state === "downloading" ? ` · downloading ${percent}%` : null}
          </p>
          {row.error ? <p className="text-xs text-warning">{row.error}</p> : null}

          <div className="mt-1 flex flex-wrap gap-2">
            {chapterId ? (
              <a href={buildReadHref(row.seriesId, chapterId)} className={linkButtonClass}>
                <BookOpen className="h-4 w-4" aria-hidden="true" /> Continue reading
              </a>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void deleteSeriesOffline(row.seriesId)}
              aria-label={`Remove ${row.title} from offline storage`}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" /> Remove
            </Button>
          </div>
        </div>
      </Card>
    </li>
  );
}
