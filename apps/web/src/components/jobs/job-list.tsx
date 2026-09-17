"use client";

import { AlertTriangle, ListChecks } from "lucide-react";
import { Button, EmptyState, Spinner } from "@/components/ui";
import type { JobView } from "@/lib/contracts/content";
import { JobCard } from "./job-card";

export interface JobListProps {
  jobs: JobView[];
  isLoading: boolean;
  isError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}

export function JobList({
  jobs,
  isLoading,
  isError,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: JobListProps) {
  if (isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Spinner label="Loading jobs" />
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn't load jobs"
        description="Try refreshing the page."
      />
    );
  }

  if (jobs.length === 0) {
    return (
      <EmptyState
        icon={ListChecks}
        title="No jobs"
        description="Background jobs will show up here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {jobs.map((job) => (
        <JobCard key={job.id} job={job} />
      ))}
      {hasNextPage ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onLoadMore}
          loading={isFetchingNextPage}
        >
          Load more
        </Button>
      ) : null}
    </div>
  );
}
