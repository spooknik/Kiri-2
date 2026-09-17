"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, Pencil, Trash2 } from "lucide-react";
import { Badge, Button, Card, Skeleton } from "@/components/ui";
import { useDeleteSeries, useSeries } from "@/hooks/use-series";
import { ApiClientError } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { MEDIA_TYPE_LABELS } from "@/lib/contracts/series";
import { ChaptersSection } from "./content/chapters-section";
import { SeriesExtras } from "./series-extras";
import { ConfirmDialog } from "./confirm-dialog";
import { EditSeriesDialog } from "./edit-series-dialog";
import { MembersCard } from "./members-card";
import { ProgressCard } from "./progress-card";
import { SeriesNotFound } from "./series-not-found";
import { TrackSeriesCard } from "./track-series-card";

export interface SeriesViewProps {
  id: string;
}

const SYNOPSIS_COLLAPSE_LENGTH = 280;

/** Client series-detail view: header, progress, members, edit/delete. */
export function SeriesView({ id }: SeriesViewProps) {
  const { data: series, isPending, isError, error } = useSeries(id);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [synopsisExpanded, setSynopsisExpanded] = useState(false);
  const deleteSeries = useDeleteSeries(id);

  if (isPending) {
    return <SeriesViewSkeleton />;
  }

  if (isError) {
    if (error instanceof ApiClientError && error.status === 404) {
      return <SeriesNotFound />;
    }
    return (
      <Card className="p-4">
        <p className="text-sm text-danger">Couldn&apos;t load this series. {error.message}</p>
      </Card>
    );
  }

  const synopsis = series.synopsis ?? "";
  const isLongSynopsis = synopsis.length > SYNOPSIS_COLLAPSE_LENGTH;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="mx-auto h-56 w-40 shrink-0 overflow-hidden rounded-lg border border-card-border bg-surface-2 sm:mx-0">
          {series.coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- served cover, unoptimized images
            <img src={series.coverUrl} alt="" className="h-full w-full object-cover" />
          ) : null}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h1 className="text-xl font-bold text-foreground">{series.title}</h1>
          {series.originalTitle ? (
            <p className="text-sm text-muted">{series.originalTitle}</p>
          ) : null}

          <div className="flex flex-wrap gap-1.5">
            <Badge tone="primary">{MEDIA_TYPE_LABELS[series.mediaType]}</Badge>
            {series.isBookClub ? <Badge tone="neutral">Book club</Badge> : null}
            {series.visibility === "PRIVATE" ? <Badge tone="neutral">Private</Badge> : null}
            {series.isAdult ? <Badge tone="danger">18+</Badge> : null}
          </div>

          <p className="text-sm text-muted">Added by {series.createdBy.displayName}</p>

          {series.sourceUrl ? (
            <a
              href={series.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex w-fit items-center gap-1 text-sm text-primary hover:underline"
            >
              Read source <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          ) : null}

          {series.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {series.tags.map((tag) => (
                <Badge key={tag} tone="neutral">
                  {tag}
                </Badge>
              ))}
            </div>
          ) : null}

          {series.canEdit ? (
            <div className="mt-1 flex gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => setEditOpen(true)}>
                <Pencil className="h-4 w-4" aria-hidden="true" /> Edit
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      {synopsis ? (
        <Card className="p-4">
          <p
            className={cn(
              "whitespace-pre-line text-sm text-foreground",
              !synopsisExpanded && isLongSynopsis && "line-clamp-5",
            )}
          >
            {synopsis}
          </p>
          {isLongSynopsis ? (
            <button
              type="button"
              onClick={() => setSynopsisExpanded((v) => !v)}
              className="focus-ring mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary"
            >
              {synopsisExpanded ? (
                <>
                  Show less <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                </>
              ) : (
                <>
                  Show more <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                </>
              )}
            </button>
          ) : null}
        </Card>
      ) : null}

      {series.entry ? (
        <ProgressCard
          seriesId={series.id}
          entry={series.entry}
          totalChapters={series.totalChapters}
        />
      ) : (
        <TrackSeriesCard seriesId={series.id} />
      )}

      <ChaptersSection seriesId={series.id} />

      <SeriesExtras seriesId={series.id} canEdit={series.canEdit} />

      {series.visibility === "SHARED" && series.members.length > 0 ? (
        <MembersCard members={series.members} />
      ) : null}

      {series.canEdit ? (
        <Card className="flex flex-col gap-2 border-danger/30 p-4">
          <h2 className="text-sm font-semibold text-danger">Danger zone</h2>
          <p className="text-xs text-muted">
            Deleting this series removes it — and everyone&apos;s progress on it — for good.
          </p>
          <Button
            type="button"
            variant="danger"
            size="sm"
            className="w-fit"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" /> Delete series
          </Button>
        </Card>
      ) : null}

      {series.canEdit ? (
        <EditSeriesDialog open={editOpen} onClose={() => setEditOpen(false)} series={series} />
      ) : null}

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => deleteSeries.mutate()}
        title={`Delete ${series.title}?`}
        description="This permanently deletes the series and every member's progress, rating and notes. This can't be undone."
        confirmLabel="Delete series"
        loading={deleteSeries.isPending}
      />
    </div>
  );
}

function SeriesViewSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 sm:flex-row">
        <Skeleton className="mx-auto h-56 w-40 sm:mx-0" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-7 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-20 w-full" />
        </div>
      </div>
      <Skeleton className="h-32 w-full" />
    </div>
  );
}
