"use client";

import { useState } from "react";
import { FileText, Sparkles, Upload } from "lucide-react";
import { Button, useToast } from "@/components/ui";
import { ConfirmDialog } from "@/components/series/confirm-dialog";
import { ImportPdfDialog } from "@/components/uploads/import-pdf-dialog";
import { UploadChapterDialog } from "@/components/uploads/upload-chapter-dialog";
import { useOptimizeSeries } from "@/hooks/use-chapters";

export interface ContentActionsProps {
  seriesId: string;
  seriesTitle: string;
  /** Disables "Optimize images" while one is already running for this series. */
  hasActiveOptimizeJob: boolean;
}

/** Upload chapter / Import PDF / Optimize images actions row — canEdit-gated, mounted by ChaptersSection. */
export function ContentActions({
  seriesId,
  seriesTitle,
  hasActiveOptimizeJob,
}: ContentActionsProps) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [confirmOptimize, setConfirmOptimize] = useState(false);
  const optimizeSeries = useOptimizeSeries(seriesId);
  const { toast } = useToast();

  function handleOptimize() {
    optimizeSeries.mutate(undefined, {
      onSuccess: () => {
        toast({ title: "Optimization started", tone: "success" });
        setConfirmOptimize(false);
      },
      onError: (error) => {
        const description =
          error.status === 409
            ? "An optimize job is already running for this series."
            : error.message;
        toast({ title: "Couldn't start optimization", description, tone: "danger" });
        setConfirmOptimize(false);
      },
    });
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="secondary" size="sm" onClick={() => setUploadOpen(true)}>
        <Upload className="h-4 w-4" aria-hidden="true" /> Upload chapter
      </Button>
      <Button type="button" variant="secondary" size="sm" onClick={() => setImportOpen(true)}>
        <FileText className="h-4 w-4" aria-hidden="true" /> Import PDF
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={hasActiveOptimizeJob}
        onClick={() => setConfirmOptimize(true)}
      >
        <Sparkles className="h-4 w-4" aria-hidden="true" /> Optimize images
      </Button>

      <UploadChapterDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        seriesId={seriesId}
      />
      <ImportPdfDialog open={importOpen} onClose={() => setImportOpen(false)} seriesId={seriesId} />
      <ConfirmDialog
        open={confirmOptimize}
        onClose={() => setConfirmOptimize(false)}
        onConfirm={handleOptimize}
        title="Optimize images?"
        description={`Re-encode ${seriesTitle}'s chapter images to save space. This runs in the background.`}
        confirmLabel="Optimize"
        tone="primary"
        loading={optimizeSeries.isPending}
      />
    </div>
  );
}
