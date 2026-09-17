"use client";

import { Info } from "lucide-react";
import { Button, Card } from "@/components/ui";

export interface ExistingSeriesCardProps {
  onTrack: () => void;
  onOpen: () => void;
  loading?: boolean;
}

/** Shown after a 409 CONFLICT on create: the series already exists on this instance. */
export function ExistingSeriesCard({ onTrack, onOpen, loading }: ExistingSeriesCardProps) {
  return (
    <Card className="border-primary/30 bg-primary-light p-4">
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <p className="text-sm text-foreground">
            This series is already in the library. Track it with your chosen status, or open it to
            see everyone&apos;s progress.
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" onClick={onTrack} loading={loading} className="flex-1">
            Track it
          </Button>
          <Button type="button" variant="secondary" onClick={onOpen} className="flex-1">
            Open series
          </Button>
        </div>
      </div>
    </Card>
  );
}
