"use client";

import { useState } from "react";
import { Button, Card, Field, Select } from "@/components/ui";
import { useUpdateEntry } from "@/hooks/use-entry";
import {
  READING_STATUSES,
  READING_STATUS_LABELS,
  type ReadingStatus,
} from "@/lib/contracts/series";

export interface TrackSeriesCardProps {
  seriesId: string;
}

/** Shown instead of `ProgressCard` when the current user has no library entry yet. */
export function TrackSeriesCard({ seriesId }: TrackSeriesCardProps) {
  const [status, setStatus] = useState<ReadingStatus>("PLAN_TO_READ");
  const updateEntry = useUpdateEntry(seriesId);

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="text-sm font-semibold text-foreground">Track this series</h2>
      <p className="text-sm text-muted">Add it to your library to record your progress.</p>
      <Field label="Starting status" htmlFor="track-status">
        <Select value={status} onChange={(e) => setStatus(e.target.value as ReadingStatus)}>
          {READING_STATUSES.map((s) => (
            <option key={s} value={s}>
              {READING_STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
      </Field>
      <Button
        type="button"
        onClick={() => updateEntry.mutate({ status })}
        loading={updateEntry.isPending}
      >
        Track this series
      </Button>
    </Card>
  );
}
