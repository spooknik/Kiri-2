"use client";

import { AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, Spinner } from "@/components/ui";
import { useRunnerStatus } from "@/hooks/use-jobs";
import { formatRelativeTime } from "@/lib/format";

export function RunnerStatusCard() {
  const { data, isLoading, isError } = useRunnerStatus();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Job runner</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Spinner label="Loading runner status" />
        ) : isError || !data ? (
          <p className="flex items-center gap-1.5 text-sm text-danger">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" /> Couldn&apos;t load runner
            status.
          </p>
        ) : (
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted">Status</dt>
              <dd className={data.running ? "font-medium text-success" : "font-medium text-danger"}>
                {data.running ? "Running" : "Stopped"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Active</dt>
              <dd className="font-medium text-foreground">{data.activeJobs}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Queued</dt>
              <dd className="font-medium text-foreground">{data.queuedJobs}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Concurrency</dt>
              <dd className="font-medium text-foreground">{data.concurrency}</dd>
            </div>
            <div className="col-span-2 sm:col-span-4">
              <dt className="text-xs text-muted">Last heartbeat</dt>
              <dd className="font-medium text-foreground">
                {data.lastHeartbeatAt ? formatRelativeTime(data.lastHeartbeatAt) : "Never"}
              </dd>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
