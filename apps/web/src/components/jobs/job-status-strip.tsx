"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui";
import { useCancelJob } from "@/hooks/use-jobs";
import { cn } from "@/lib/cn";
import type { JobView } from "@/lib/contracts/content";
import { JOB_KIND_LABELS } from "./job-labels";

export interface JobStatusStripProps {
  /** Usually a series' jobs from `useSeriesJobs`, already flattened. */
  jobs: JobView[];
  className?: string;
}

/**
 * Shows a series' queued/running jobs with progress + cancel, and recently
 * failed jobs with their error — dismissible locally (there's no
 * server-side "dismiss", it's purely a client-side hide) since a failed job
 * otherwise stays in the list forever.
 */
export function JobStatusStrip({ jobs, className }: JobStatusStripProps) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const cancelJob = useCancelJob();

  const visible = jobs.filter(
    (job) =>
      (job.status === "QUEUED" || job.status === "RUNNING" || job.status === "FAILED") &&
      !dismissed.has(job.id),
  );

  if (visible.length === 0) return null;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {visible.map((job) => (
        <JobStatusRow
          key={job.id}
          job={job}
          onCancel={() => cancelJob.mutate(job.id)}
          cancelling={cancelJob.isPending && cancelJob.variables === job.id}
          onDismiss={() => setDismissed((prev) => new Set(prev).add(job.id))}
        />
      ))}
    </div>
  );
}

function JobStatusRow({
  job,
  onCancel,
  cancelling,
  onDismiss,
}: {
  job: JobView;
  onCancel: () => void;
  cancelling: boolean;
  onDismiss: () => void;
}) {
  if (job.status === "FAILED") {
    return (
      <div className="flex items-start justify-between gap-3 rounded-md border border-danger/30 bg-danger-light px-3 py-2 text-xs text-danger">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-medium">{JOB_KIND_LABELS[job.kind]} failed</p>
            <p>{job.error ?? "Something went wrong."}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="focus-ring -m-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-md opacity-70 hover:opacity-100"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    );
  }

  const { current, total, message } = job.progress;
  const percent =
    total && total > 0 ? Math.min(100, Math.round(((current ?? 0) / total) * 100)) : null;

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-card-border bg-surface-2 px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-medium text-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          {JOB_KIND_LABELS[job.kind]}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} loading={cancelling}>
          Cancel
        </Button>
      </div>
      {percent !== null ? (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-card-border">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}
      {message ? <p className="text-muted">{message}</p> : null}
    </div>
  );
}
