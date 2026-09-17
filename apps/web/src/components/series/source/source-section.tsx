"use client";

/**
 * Content-source section of the series page. Replaces the Phase-4 stub.
 * Drives the whole series ↔ plugin lifecycle: UNCONFIGURED → connect a URL,
 * NEEDS_PLUGIN → explain + point at Admin → Plugins, PENDING/RUNNING →
 * inline job progress, READY → sync/verify/auto-sync/cookie management,
 * FAILED → error + (when `lastErrorCode === "NEEDS_CREDENTIAL"`) the cookie
 * paste/extension card. Members (`canEdit: false`) get a one-line read-only
 * status.
 */
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Cookie, Link2, RefreshCw, ShieldCheck } from "lucide-react";
import { AppLink } from "@/components/shell/app-link";
import { JobStatusStrip } from "@/components/jobs/job-status-strip";
import { Badge, Button, Card, Skeleton, useToast } from "@/components/ui";
import { ConfirmDialog } from "@/components/series/confirm-dialog";
import { useSeriesJobs } from "@/hooks/use-jobs";
import { useProfile } from "@/hooks/use-profile";
import {
  useClearSourceCredential,
  useRequestSync,
  useSource,
  useUnbindSource,
  useUpdateSource,
} from "@/hooks/use-source";
import { contentQueryKeys } from "@/lib/content-query-keys";
import type { AutoSyncMode, SourceView } from "@/lib/contracts/plugins";
import { formatRelativeTime } from "@/lib/format";
import { AutoSyncSelect } from "./auto-sync-select";
import { ConfigureSourceDialog } from "./configure-source-dialog";
import { CredentialDialog } from "./credential-dialog";

export interface SourceSectionProps {
  seriesId: string;
  canEdit: boolean;
}

function readOnlyStatusLine(data: SourceView): string {
  switch (data.status) {
    case "UNCONFIGURED":
      return "No source connected.";
    case "NEEDS_PLUGIN":
      return "Needs a plugin that isn't installed on this instance.";
    case "PENDING":
      return "Sync queued…";
    case "RUNNING":
      return "Syncing…";
    case "READY":
      return data.lastSyncedAt ? `Synced ${formatRelativeTime(data.lastSyncedAt)}.` : "Connected.";
    case "FAILED":
      return data.lastError ?? "The last sync failed.";
    default:
      return "";
  }
}

export function SourceSection({ seriesId, canEdit }: SourceSectionProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const profile = useProfile();
  const { data, isPending, isError, error } = useSource(seriesId);
  const seriesJobs = useSeriesJobs(seriesId);
  const updateSource = useUpdateSource(seriesId);
  const requestSync = useRequestSync(seriesId);
  const unbindSource = useUnbindSource(seriesId);
  const clearCredential = useClearSourceCredential(seriesId);

  const [configureOpen, setConfigureOpen] = useState(false);
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  // Once a sync/verify job that was active finishes, the chapter list it
  // just wrote to is stale — refresh it. `useSource` itself only owns the
  // `source` cache; `contentQueryKeys.chapters` belongs to the content
  // phase's `useChapters`.
  const wasActive = useRef(false);
  useEffect(() => {
    if (!data) return;
    const active = data.status === "PENDING" || data.status === "RUNNING";
    if (wasActive.current && !active) {
      void queryClient.invalidateQueries({ queryKey: contentQueryKeys.chapters(seriesId) });
    }
    wasActive.current = active;
  }, [data, queryClient, seriesId]);

  if (isPending) {
    return (
      <Card className="flex flex-col gap-3 p-4">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-9 w-full" />
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card className="p-4">
        <p className="text-sm text-danger">Couldn&apos;t load the source. {error?.message}</p>
      </Card>
    );
  }

  if (!canEdit) {
    return (
      <Card className="p-4">
        <h2 className="text-sm font-semibold text-foreground">Source</h2>
        <p className="mt-1 text-xs text-muted">{readOnlyStatusLine(data)}</p>
      </Card>
    );
  }

  const jobs = (seriesJobs.data?.pages.flatMap((page) => page.items) ?? []).filter(
    (job) => job.kind === "SOURCE_SYNC" || job.kind === "SOURCE_VERIFY",
  );
  const jobActive = jobs.some((job) => job.status === "QUEUED" || job.status === "RUNNING");
  const isAdmin = profile.data?.role === "admin";

  function handleSync(kind: "sync" | "verify") {
    requestSync.mutate(
      { kind },
      {
        onError: (err) =>
          toast({ title: "Couldn't start sync", description: err.message, tone: "danger" }),
      },
    );
  }

  function handleAutoSyncChange(mode: AutoSyncMode, intervalMinutes: number | null) {
    updateSource.mutate(
      { autoSyncMode: mode, autoSyncIntervalMinutes: intervalMinutes },
      {
        onError: (err) =>
          toast({ title: "Couldn't update auto-sync", description: err.message, tone: "danger" }),
      },
    );
  }

  function handleDisconnect() {
    unbindSource.mutate(undefined, {
      onSuccess: () => {
        toast({ title: "Source disconnected", tone: "success" });
        setDisconnectOpen(false);
      },
      onError: (err) => {
        toast({ title: "Couldn't disconnect source", description: err.message, tone: "danger" });
        setDisconnectOpen(false);
      },
    });
  }

  function handleRemoveCredentialQuick() {
    clearCredential.mutate(undefined, {
      onSuccess: () => toast({ title: "Cookie removed", tone: "success" }),
      onError: (err) =>
        toast({ title: "Couldn't remove cookie", description: err.message, tone: "danger" }),
    });
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">Source</h2>
        {data.status !== "UNCONFIGURED" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-danger"
            onClick={() => setDisconnectOpen(true)}
          >
            Disconnect
          </Button>
        ) : null}
      </div>

      {data.status === "UNCONFIGURED" ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted">This series has no content source connected.</p>
          <Button
            type="button"
            size="sm"
            className="self-start"
            onClick={() => setConfigureOpen(true)}
          >
            <Link2 className="h-4 w-4" aria-hidden="true" /> Connect a source
          </Button>
        </div>
      ) : null}

      {data.status === "NEEDS_PLUGIN" ? (
        <div className="rounded-md border border-warning/30 bg-warning-light p-3 text-sm text-warning">
          <p>
            {data.v1Site
              ? `This series came from Kiri 1.x's "${data.v1Site}" site, which needs a plugin installed to keep syncing.`
              : "This series needs a plugin that isn't installed on this instance."}
          </p>
          <p className="mt-1 text-xs">
            {isAdmin ? (
              <>
                Install it under{" "}
                <AppLink href="/admin/plugins" className="underline">
                  Admin → Plugins
                </AppLink>
                .
              </>
            ) : (
              "Ask an admin to install it under Admin → Plugins."
            )}
          </p>
        </div>
      ) : null}

      {data.status === "PENDING" || data.status === "RUNNING" ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted">
            {data.status === "PENDING" ? "Sync queued…" : "Syncing…"}
          </p>
          <JobStatusStrip jobs={jobs} />
        </div>
      ) : null}

      {data.status === "READY" ? (
        <div className="flex flex-col gap-3">
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <ShieldCheck className="h-3.5 w-3.5 text-success" aria-hidden="true" />
            {data.plugin ? `${data.plugin.name} · ` : ""}
            Synced {data.lastSyncedAt ? formatRelativeTime(data.lastSyncedAt) : "never"}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => handleSync("sync")}
              disabled={jobActive}
              loading={requestSync.isPending && requestSync.variables?.kind === "sync"}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Sync now
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => handleSync("verify")}
              disabled={jobActive}
              loading={requestSync.isPending && requestSync.variables?.kind === "verify"}
            >
              Verify
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-foreground">Auto-sync</span>
            <AutoSyncSelect
              mode={data.autoSyncMode}
              intervalMinutes={data.autoSyncIntervalMinutes}
              disabled={updateSource.isPending}
              onChange={handleAutoSyncChange}
            />
          </div>
          {data.plugin?.needsCookie ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">
              <span className="flex items-center gap-1.5">
                <Cookie className="h-3.5 w-3.5" aria-hidden="true" />
                {data.hasSeriesCookie ? (
                  <>
                    Series cookie set
                    {data.cookieUpdatedAt ? ` (${formatRelativeTime(data.cookieUpdatedAt)})` : ""}
                  </>
                ) : data.hasPluginCredential ? (
                  "Using the extension's shared cookie for this site"
                ) : (
                  "No cookie set"
                )}
              </span>
              <span className="flex items-center gap-2">
                {data.hasSeriesCookie ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleRemoveCredentialQuick}
                    loading={clearCredential.isPending}
                  >
                    Remove cookie
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setCredentialOpen(true)}
                >
                  {data.hasSeriesCookie ? "Update cookie" : "Paste cookie"}
                </Button>
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {data.status === "FAILED" ? (
        <div className="flex flex-col gap-3">
          <p className="flex items-start gap-1.5 rounded-md bg-danger-light p-3 text-sm text-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {data.lastError ?? "The last sync failed."}
            {data.lastErrorCode ? (
              <Badge tone="danger" className="ml-1">
                {data.lastErrorCode}
              </Badge>
            ) : null}
          </p>
          {data.lastErrorCode === "NEEDS_CREDENTIAL" ? (
            <div className="rounded-md border border-warning/30 bg-warning-light p-3 text-sm">
              <p className="flex items-center gap-1.5 font-medium text-warning">
                <Cookie className="h-4 w-4" aria-hidden="true" /> This site needs a browser cookie
              </p>
              <p className="mt-1 text-xs text-warning">
                Paste a cookie captured after solving the site&apos;s challenge in your browser, or
                use the Kiri Cookie Bridge extension.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={() => setCredentialOpen(true)}>
                  Paste cookie
                </Button>
                {isAdmin ? (
                  <Button href="/admin/plugins" variant="secondary" size="sm">
                    Use the Cookie Bridge extension
                  </Button>
                ) : (
                  <span className="flex items-center text-xs text-warning">
                    Ask an admin to set up the Cookie Bridge extension.
                  </span>
                )}
              </div>
            </div>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={() => handleSync("sync")}
            loading={requestSync.isPending}
            disabled={jobActive}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Retry sync
          </Button>
        </div>
      ) : null}

      <ConfigureSourceDialog
        open={configureOpen}
        onClose={() => setConfigureOpen(false)}
        seriesId={seriesId}
      />
      <CredentialDialog
        open={credentialOpen}
        onClose={() => setCredentialOpen(false)}
        seriesId={seriesId}
        hasSeriesCookie={data.hasSeriesCookie}
      />
      <ConfirmDialog
        open={disconnectOpen}
        onClose={() => setDisconnectOpen(false)}
        onConfirm={handleDisconnect}
        title="Disconnect source?"
        description="Chapters already downloaded stay in the library. You can reconnect a source later."
        confirmLabel="Disconnect"
        loading={unbindSource.isPending}
      />
    </Card>
  );
}
