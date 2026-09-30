"use client";

import { JobStatusStrip } from "@/components/jobs/job-status-strip";
import { DownloadControl } from "@/components/offline/download-control";
import { Card, Skeleton } from "@/components/ui";
import { useChapters } from "@/hooks/use-chapters";
import { useSeriesJobs } from "@/hooks/use-jobs";
import { ChapterList } from "./chapter-list";
import { ContentActions } from "./content-actions";

export interface ChaptersSectionProps {
  seriesId: string;
}

/** Chapters card for the series page: header/counts, upload/import/optimize actions, active jobs, chapter list. The read CTA lives at the top of the page (`ReadButton`). */
export function ChaptersSection({ seriesId }: ChaptersSectionProps) {
  const { data, isPending, isError, error } = useChapters(seriesId);
  const seriesJobs = useSeriesJobs(seriesId);

  if (isPending) {
    return <ChaptersSectionSkeleton />;
  }

  if (isError) {
    return (
      <Card className="p-4">
        <p className="text-sm text-danger">Couldn&apos;t load chapters. {error.message}</p>
      </Card>
    );
  }

  const { chapters, readCount, series } = data;
  const jobs = seriesJobs.data?.pages.flatMap((page) => page.items) ?? [];
  const hasActiveOptimizeJob = jobs.some(
    (job) => job.kind === "OPTIMIZE" && (job.status === "QUEUED" || job.status === "RUNNING"),
  );

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Chapters</h2>
        <p className="text-xs text-muted">
          {chapters.length} chapter{chapters.length === 1 ? "" : "s"} · {readCount} read
        </p>
      </div>

      {series.canEdit ? (
        <ContentActions
          seriesId={seriesId}
          seriesTitle={series.title}
          hasActiveOptimizeJob={hasActiveOptimizeJob}
        />
      ) : null}

      {/* Offline downloads are a reader's affordance, so this sits outside the
          canEdit gate above. */}
      <DownloadControl seriesId={seriesId} />

      <JobStatusStrip jobs={jobs} />

      <ChapterList seriesId={seriesId} chapters={chapters} canEdit={series.canEdit} />
    </Card>
  );
}

function ChaptersSectionSkeleton() {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-40 w-full" />
    </Card>
  );
}
