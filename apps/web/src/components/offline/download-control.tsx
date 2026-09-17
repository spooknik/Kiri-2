"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, CloudDownload, ListChecks, Pause, Play, Trash2, TriangleAlert } from "lucide-react";
import { Button, Checkbox, Dialog, Spinner, useToast } from "@/components/ui";
import { useSeriesOffline } from "@/hooks/use-offline";
import type { OfflineManifest } from "@/lib/contracts/offline";
import { downloadFraction } from "@/lib/offline/catalog";
import {
  deleteSeriesOffline,
  downloadSeries,
  fetchOfflineManifest,
  pauseDownload,
  resumeDownload,
} from "@/lib/offline/downloads";
import { formatBytes } from "@/lib/format";

export interface DownloadControlProps {
  seriesId: string;
}

/**
 * "Download for offline" for one series: one primary button that downloads
 * everything, a secondary button for per-chapter selection, and — once
 * something is downloaded — pause/resume plus remove.
 *
 * Mounted by `ChaptersSection` for *every* viewer, not just editors: reading a
 * series offline is a reader's affordance, not a maintainer's.
 */
export function DownloadControl({ seriesId }: DownloadControlProps) {
  const { row, progress } = useSeriesOffline(seriesId);
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const start = useCallback(
    async (chapterIds?: string[]) => {
      setBusy(true);
      try {
        const result = await downloadSeries(seriesId, chapterIds ? { chapterIds } : {});
        if (result.state === "partial") {
          toast({
            title: "Downloaded with gaps",
            description: result.error ?? undefined,
            tone: "warning",
          });
        } else if (result.state === "ready") {
          toast({ title: "Available offline", tone: "success" });
        }
      } catch (error) {
        toast({
          title: "Download failed",
          description: error instanceof Error ? error.message : undefined,
          tone: "danger",
        });
      } finally {
        setBusy(false);
      }
    },
    [seriesId, toast],
  );

  const resume = useCallback(async () => {
    setBusy(true);
    try {
      await resumeDownload(seriesId);
    } catch (error) {
      toast({
        title: "Couldn't resume the download",
        description: error instanceof Error ? error.message : undefined,
        tone: "danger",
      });
    } finally {
      setBusy(false);
    }
  }, [seriesId, toast]);

  const remove = useCallback(async () => {
    await deleteSeriesOffline(seriesId);
    toast({ title: "Removed from offline storage", tone: "neutral" });
  }, [seriesId, toast]);

  const downloading = row?.state === "downloading" || (busy && !row);
  const fraction = progress
    ? downloadFraction({
        totalBytes: progress.totalBytes,
        downloadedBytes: progress.downloadedBytes,
      })
    : row
      ? downloadFraction(row)
      : 0;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="download-control">
      {downloading ? (
        <>
          <div
            className="flex min-w-40 flex-1 flex-col gap-1"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fraction * 100)}
            aria-label="Download progress"
          >
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${Math.round(fraction * 100)}%` }}
              />
            </div>
            <p className="text-xs text-muted">
              {progress
                ? `${progress.downloadedImages} / ${progress.totalImages} pages · ${formatBytes(progress.downloadedBytes)}`
                : "Starting…"}
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => pauseDownload(seriesId)}
          >
            <Pause className="h-4 w-4" aria-hidden="true" /> Pause
          </Button>
        </>
      ) : null}

      {!downloading && row && (row.state === "paused" || row.state === "partial") ? (
        <>
          <span className="inline-flex items-center gap-1.5 text-xs text-warning">
            <TriangleAlert className="h-4 w-4" aria-hidden="true" />
            {row.state === "paused" ? "Paused" : "Partly downloaded"}
          </span>
          <Button type="button" variant="secondary" size="sm" loading={busy} onClick={resume}>
            <Play className="h-4 w-4" aria-hidden="true" /> Resume download
          </Button>
        </>
      ) : null}

      {!downloading && row?.state === "ready" ? (
        <span className="inline-flex items-center gap-1.5 text-xs text-success">
          <Check className="h-4 w-4" aria-hidden="true" />
          Available offline · {formatBytes(row.downloadedBytes)}
        </span>
      ) : null}

      {!downloading && (!row || row.state === "error") ? (
        <>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={busy}
            onClick={() => void start()}
          >
            <CloudDownload className="h-4 w-4" aria-hidden="true" /> Download for offline
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setPickerOpen(true)}
            aria-label="Choose chapters to download"
          >
            <ListChecks className="h-4 w-4" aria-hidden="true" /> Choose chapters
          </Button>
        </>
      ) : null}

      {row ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void remove()}
          aria-label="Remove downloaded chapters"
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" /> Remove
        </Button>
      ) : null}

      <ChapterPickerDialog
        seriesId={seriesId}
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onConfirm={(ids) => {
          setPickerOpen(false);
          void start(ids);
        }}
      />
    </div>
  );
}

interface ChapterPickerDialogProps {
  seriesId: string;
  open: boolean;
  onClose: () => void;
  onConfirm: (chapterIds: string[]) => void;
}

/**
 * The dialog frame. The body is mounted only while `open`, so re-opening it
 * gets fresh state from the mount instead of an effect that resets it — which
 * would be a synchronous setState inside an effect, and a cascading render.
 */
function ChapterPickerDialog({ seriesId, open, onClose, onConfirm }: ChapterPickerDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title="Download chapters">
      {open ? <ChapterPicker seriesId={seriesId} onCancel={onClose} onConfirm={onConfirm} /> : null}
    </Dialog>
  );
}

interface ChapterPickerProps {
  seriesId: string;
  onCancel: () => void;
  onConfirm: (chapterIds: string[]) => void;
}

/** Checkbox list of downloadable chapters; everything is selected by default. */
function ChapterPicker({ seriesId, onCancel, onConfirm }: ChapterPickerProps) {
  const [manifest, setManifest] = useState<OfflineManifest | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchOfflineManifest(seriesId)
      .then((loaded) => {
        if (cancelled) return;
        setManifest(loaded);
        setSelected(new Set(loaded.chapters.map((chapter) => chapter.id)));
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Could not load the chapter list");
      });
    return () => {
      cancelled = true;
    };
  }, [seriesId]);

  const selectedBytes =
    manifest?.chapters
      .filter((chapter) => selected.has(chapter.id))
      .reduce((total, chapter) => total + chapter.bytes, 0) ?? 0;

  return (
    <>
      {error ? <p className="px-4 pb-4 text-sm text-danger">{error}</p> : null}

      {!manifest && !error ? (
        <div className="flex justify-center px-4 pb-6">
          <Spinner label="Loading chapters" />
        </div>
      ) : null}

      {manifest ? (
        <>
          <div className="max-h-72 overflow-y-auto px-4">
            <ul className="flex flex-col">
              {manifest.chapters.map((chapter) => (
                <li key={chapter.id} className="flex items-center justify-between gap-3">
                  <Checkbox
                    checked={selected.has(chapter.id)}
                    label={chapter.title}
                    onChange={(event) => {
                      setSelected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(chapter.id);
                        else next.delete(chapter.id);
                        return next;
                      });
                    }}
                  />
                  <span className="shrink-0 text-xs text-muted">
                    {chapter.pageCount} pages · {formatBytes(chapter.bytes)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex items-center justify-between gap-2 px-4 py-4">
            <p className="text-xs text-muted">
              {selected.size} of {manifest.chapters.length} · {formatBytes(selectedBytes)}
            </p>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={selected.size === 0}
                onClick={() => onConfirm([...selected])}
              >
                Download
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
