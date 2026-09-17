"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, Field, Input, useToast } from "@/components/ui";
import { useUpload } from "@/hooks/use-upload";
import { api, ApiClientError } from "@/lib/api-client";
import { contentQueryKeys } from "@/lib/content-query-keys";
import type { EnqueuedJobResponse, ImportKind } from "@/lib/contracts/content";
import { UploadProgress, type UploadProgressItem } from "./upload-progress";

export interface UploadChapterDialogProps {
  open: boolean;
  onClose: () => void;
  seriesId: string;
}

type Phase = "idle" | "uploading" | "importing" | "error";

const ARCHIVE_EXTENSIONS = [".zip", ".cbz"];

function isArchiveFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

const EMPTY_FORM = { title: "", number: "", volume: "" };

/**
 * Upload a chapter as a `.zip`/`.cbz` archive or a set of loose images.
 * Uploads each file via `useUpload` (chunked, resumable), then
 * `POST /api/series/:id/chapters/import` to enqueue the import job. Closes
 * on success — the import's progress shows up in `JobStatusStrip` once the
 * next job poll lands.
 */
export function UploadChapterDialog({ open, onClose, seriesId }: UploadChapterDialogProps) {
  const queryClient = useQueryClient();
  const { upload, cancel } = useUpload();
  const { toast } = useToast();

  const [form, setForm] = useState(EMPTY_FORM);
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progressItems, setProgressItems] = useState<UploadProgressItem[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  // Forces the Dialog to remount (and re-run its own showModal effect) when
  // the user cancels the "close while uploading?" confirm below — the
  // native <dialog> has already closed itself by then (Dialog.tsx wires its
  // own close button/backdrop/Escape straight to `ref.current.close()`),
  // and our `open` prop staying `true` wouldn't otherwise reopen it.
  const [reopenKey, setReopenKey] = useState(0);

  const uploading = phase === "uploading" || phase === "importing";

  function resetForm() {
    setForm(EMPTY_FORM);
    setFiles([]);
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

  function handleFilesChange(event: ChangeEvent<HTMLInputElement>) {
    setFiles(event.target.files ? Array.from(event.target.files) : []);
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
    if (files.length === 0) {
      setFormError("Choose a .zip/.cbz archive, or one or more image files.");
      return;
    }

    const isArchive = files.length === 1 && isArchiveFile(files[0]!);
    const allImages = files.every((file) => file.type.startsWith("image/"));
    if (!isArchive && !allImages) {
      setFormError(
        "Select either one .zip/.cbz archive, or one or more image files — not a mix of both.",
      );
      return;
    }
    const kind: ImportKind = isArchive ? "archive" : "images";
    const ordered = isArchive
      ? files
      : [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    setPhase("uploading");
    setProgressItems(
      ordered.map((file) => ({
        name: file.name,
        sentBytes: 0,
        totalBytes: file.size,
        status: "pending",
      })),
    );

    try {
      const uploadIds: string[] = [];
      for (let i = 0; i < ordered.length; i++) {
        const file = ordered[i]!;
        setProgressItems((items) =>
          items.map((item, idx) => (idx === i ? { ...item, status: "uploading" } : item)),
        );
        const session = await upload(file, {
          onProgress: ({ sentBytes, totalBytes }) => {
            setProgressItems((items) =>
              items.map((item, idx) => (idx === i ? { ...item, sentBytes, totalBytes } : item)),
            );
          },
        });
        uploadIds.push(session.id);
        setProgressItems((items) =>
          items.map((item, idx) => (idx === i ? { ...item, status: "done" } : item)),
        );
      }

      setPhase("importing");
      await api.post<EnqueuedJobResponse>(`/api/series/${seriesId}/chapters/import`, {
        kind,
        uploadIds,
        title,
        number: form.number.trim() === "" ? null : Number(form.number),
        volume: form.volume.trim() === "" ? null : form.volume.trim(),
      });

      void queryClient.invalidateQueries({ queryKey: contentQueryKeys.jobsAll });
      void queryClient.invalidateQueries({ queryKey: contentQueryKeys.chapters(seriesId) });
      toast({
        title: "Upload queued",
        description: "We'll process it in the background — watch the chapters list for progress.",
        tone: "success",
      });
      resetForm();
      onClose();
    } catch (err) {
      setPhase("error");
      setProgressItems((items) =>
        items.map((item) => (item.status === "uploading" ? { ...item, status: "error" } : item)),
      );
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
      title="Upload chapter"
      className="max-w-md"
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <Field label="Title" htmlFor="upload-chapter-title" required>
          <Input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="e.g. Chapter 42"
            disabled={uploading}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Number" htmlFor="upload-chapter-number">
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
          <Field label="Volume" htmlFor="upload-chapter-volume">
            <Input
              value={form.volume}
              onChange={(e) => setForm({ ...form, volume: e.target.value })}
              placeholder="Optional"
              disabled={uploading}
            />
          </Field>
        </div>

        <Field
          label="File"
          htmlFor="upload-chapter-file"
          help="One .zip/.cbz archive, or select multiple images (sorted by filename)."
        >
          <input
            id="upload-chapter-file"
            type="file"
            accept=".zip,.cbz,image/*"
            multiple
            onChange={handleFilesChange}
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
          {phase === "importing" ? "Queuing…" : uploading ? "Uploading…" : "Upload"}
        </Button>
      </form>
    </Dialog>
  );
}
