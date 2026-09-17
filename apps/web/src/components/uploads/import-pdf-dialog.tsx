"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, Field, Input, Select, useToast } from "@/components/ui";
import { useUpload } from "@/hooks/use-upload";
import { api, ApiClientError } from "@/lib/api-client";
import { contentQueryKeys } from "@/lib/content-query-keys";
import type { EnqueuedJobResponse } from "@/lib/contracts/content";
import { UploadProgress, type UploadProgressItem } from "./upload-progress";

export interface ImportPdfDialogProps {
  open: boolean;
  onClose: () => void;
  seriesId: string;
}

type Phase = "idle" | "uploading" | "importing" | "error";

const QUALITY_PRESETS = [
  { value: "standard", label: "Standard (faster, smaller files)", scale: 1, maxWidth: 1200 },
  { value: "high", label: "High", scale: 1.5, maxWidth: 1600 },
  { value: "max", label: "Maximum (slower, largest files)", scale: 2, maxWidth: 2400 },
] as const;

type QualityPreset = (typeof QUALITY_PRESETS)[number]["value"];

const EMPTY_FORM = { title: "", number: "", volume: "", quality: "high" as QualityPreset };

/**
 * Import a chapter from a single PDF: upload it via `useUpload`, then
 * `POST /api/series/:id/chapters/import` with `kind: "pdf"` and the chosen
 * quality preset's `pdf.scale`/`pdf.maxWidth`. Closes on success — progress
 * shows up in `JobStatusStrip`.
 */
export function ImportPdfDialog({ open, onClose, seriesId }: ImportPdfDialogProps) {
  const queryClient = useQueryClient();
  const { upload, cancel } = useUpload();
  const { toast } = useToast();

  const [form, setForm] = useState(EMPTY_FORM);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progressItems, setProgressItems] = useState<UploadProgressItem[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  // See UploadChapterDialog for why this remount trick is needed.
  const [reopenKey, setReopenKey] = useState(0);

  const uploading = phase === "uploading" || phase === "importing";

  function resetForm() {
    setForm(EMPTY_FORM);
    setFile(null);
    setPhase("idle");
    setProgressItems([]);
    setFormError(null);
  }

  function handleCloseAttempt() {
    if (uploading) {
      const proceed = window.confirm(
        "This upload is still in progress. Closing now will cancel it. Close anyway?",
      );
      if (!proceed) {
        setReopenKey((key) => key + 1);
        return;
      }
      cancel();
    }
    resetForm();
    onClose();
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
    setFormError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const title = form.title.trim();
    if (!title) {
      setFormError("Title is required.");
      return;
    }
    if (!file) {
      setFormError("Choose a PDF file.");
      return;
    }
    if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
      setFormError("That doesn't look like a PDF.");
      return;
    }

    const preset = QUALITY_PRESETS.find((p) => p.value === form.quality) ?? QUALITY_PRESETS[1];

    setPhase("uploading");
    setProgressItems([
      { name: file.name, sentBytes: 0, totalBytes: file.size, status: "uploading" },
    ]);

    try {
      const session = await upload(file, {
        onProgress: ({ sentBytes, totalBytes }) => {
          setProgressItems([{ name: file.name, sentBytes, totalBytes, status: "uploading" }]);
        },
      });
      setProgressItems([
        { name: file.name, sentBytes: file.size, totalBytes: file.size, status: "done" },
      ]);

      setPhase("importing");
      await api.post<EnqueuedJobResponse>(`/api/series/${seriesId}/chapters/import`, {
        kind: "pdf",
        uploadIds: [session.id],
        title,
        number: form.number.trim() === "" ? null : Number(form.number),
        volume: form.volume.trim() === "" ? null : form.volume.trim(),
        pdf: { scale: preset.scale, maxWidth: preset.maxWidth },
      });

      void queryClient.invalidateQueries({ queryKey: contentQueryKeys.jobsAll });
      void queryClient.invalidateQueries({ queryKey: contentQueryKeys.chapters(seriesId) });
      toast({
        title: "Import queued",
        description: "We'll process it in the background — watch the chapters list for progress.",
        tone: "success",
      });
      resetForm();
      onClose();
    } catch (err) {
      setPhase("error");
      setProgressItems((items) => items.map((item) => ({ ...item, status: "error" })));
      if (err instanceof ApiClientError) {
        if (err.isOffline) {
          setFormError("You're offline. Reconnect and try again.");
        } else if (err.status === 409) {
          setFormError("A matching upload or import job is already running for this series.");
        } else if (err.status === 413) {
          setFormError("That file is too large.");
        } else {
          setFormError(err.message);
        }
      } else if ((err as DOMException)?.name !== "AbortError") {
        setFormError("Something went wrong. Try again.");
      }
    }
  }

  return (
    <Dialog
      key={reopenKey}
      open={open}
      onClose={handleCloseAttempt}
      title="Import PDF"
      className="max-w-md"
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <Field label="Title" htmlFor="import-pdf-title" required>
          <Input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="e.g. Chapter 42"
            disabled={uploading}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Number" htmlFor="import-pdf-number">
            <Input
              type="number"
              inputMode="decimal"
              step="any"
              min={0}
              value={form.number}
              onChange={(e) => setForm({ ...form, number: e.target.value })}
              placeholder="Optional"
              disabled={uploading}
            />
          </Field>
          <Field label="Volume" htmlFor="import-pdf-volume">
            <Input
              value={form.volume}
              onChange={(e) => setForm({ ...form, volume: e.target.value })}
              placeholder="Optional"
              disabled={uploading}
            />
          </Field>
        </div>

        <Field
          label="Quality"
          htmlFor="import-pdf-quality"
          help="Higher quality means larger files and slower processing."
        >
          <Select
            value={form.quality}
            onChange={(e) => setForm({ ...form, quality: e.target.value as QualityPreset })}
            disabled={uploading}
          >
            {QUALITY_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="PDF file" htmlFor="import-pdf-file">
          <input
            id="import-pdf-file"
            type="file"
            accept=".pdf,application/pdf"
            onChange={handleFileChange}
            disabled={uploading}
            className="block w-full text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-surface-2 file:px-3 file:py-2 file:text-sm file:font-medium file:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          />
        </Field>

        <UploadProgress items={progressItems} />

        {formError ? (
          <p role="alert" className="text-sm text-danger">
            {formError}
          </p>
        ) : null}

        <Button type="submit" loading={uploading}>
          {phase === "importing" ? "Queuing…" : uploading ? "Uploading…" : "Import"}
        </Button>
      </form>
    </Dialog>
  );
}
