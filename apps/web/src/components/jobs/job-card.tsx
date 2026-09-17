"use client";

import { AppLink } from "@/components/shell/app-link";
import { Badge, Button } from "@/components/ui";
import { useCancelJob } from "@/hooks/use-jobs";
import type { JobView } from "@/lib/contracts/content";
import { formatRelativeTime } from "@/lib/format";
import { JOB_KIND_LABELS, JOB_STATUS_LABELS, JOB_STATUS_TONE } from "./job-labels";

export interface JobCardProps {
  job: JobView;
}

/** One job row for the admin jobs list: kind/status, series link, requester, progress, error, timestamps, cancel. */
export function JobCard({ job }: JobCardProps) {
  const cancelJob = useCancelJob();
  const isActive = job.status === "QUEUED" || job.status === "RUNNING";
  const { current, total, message, phase } = job.progress;
  const percent =
    total && total > 0 ? Math.min(100, Math.round(((current ?? 0) / total) * 100)) : null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-card-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{JOB_KIND_LABELS[job.kind]}</span>
          <Badge tone={JOB_STATUS_TONE[job.status]}>{JOB_STATUS_LABELS[job.status]}</Badge>
        </div>
        {isActive ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => cancelJob.mutate(job.id)}
            loading={cancelJob.isPending && cancelJob.variables === job.id}
          >
            Cancel
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {job.seriesId ? (
          <AppLink href={`/series/${job.seriesId}`} className="text-primary hover:underline">
            View series
          </AppLink>
        ) : null}
        {job.requestedBy ? <span>Requested by {job.requestedBy.displayName}</span> : null}
        <span>Created {formatRelativeTime(job.createdAt)}</span>
        {job.startedAt ? <span>Started {formatRelativeTime(job.startedAt)}</span> : null}
        {job.finishedAt ? <span>Finished {formatRelativeTime(job.finishedAt)}</span> : null}
        <span>Attempt {job.attempt}</span>
      </div>

      {percent !== null ? (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}
      {phase || message ? (
        <p className="text-xs text-muted">
          {phase ? `${phase} — ` : ""}
          {message}
        </p>
      ) : null}
      {job.error ? (
        <p className="rounded-md bg-danger-light px-2 py-1 text-xs text-danger">
          {job.error}
          {job.errorCode ? ` (${job.errorCode})` : ""}
        </p>
      ) : null}
    </div>
  );
}
