"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { Button, Dialog, Field, Input, useToast } from "@/components/ui";
import { getExistingSeriesId } from "@/components/series/series-form-utils";
import { useResolveUrl } from "@/hooks/use-plugins";
import { useConfigureSource } from "@/hooks/use-source";
import type { ResolveUrlResponse } from "@/lib/contracts/plugins";

export interface ConfigureSourceDialogProps {
  open: boolean;
  onClose: () => void;
  seriesId: string;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * "Connect a source" dialog for `SourceSection`'s UNCONFIGURED state: a URL
 * field that resolves against installed plugins on blur (`POST
 * /api/plugins/resolve`) to preview which plugin would handle it, then
 * `PUT /api/series/:id/source` on submit. A 409 with `existingSeriesId`
 * (another series already bound to this normalized URL) offers a link
 * instead of a raw error, reusing the same helper the add-series flow uses
 * for its MAL-conflict case (`getExistingSeriesId`).
 */
export function ConfigureSourceDialog({ open, onClose, seriesId }: ConfigureSourceDialogProps) {
  const router = useRouter();
  const { toast } = useToast();
  const configureSource = useConfigureSource(seriesId);
  const resolveUrl = useResolveUrl();

  const [url, setUrl] = useState("");
  const [resolved, setResolved] = useState<ResolveUrlResponse | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [existingSeriesId, setExistingSeriesId] = useState<string | null>(null);

  function reset() {
    setUrl("");
    setResolved(null);
    setFormError(null);
    setExistingSeriesId(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  function handleBlur() {
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      setResolved(null);
      return;
    }
    resolveUrl.mutate(
      { url: trimmed },
      {
        onSuccess: (data) => setResolved(data),
        onError: () => setResolved(null),
      },
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) {
      setFormError("Enter a URL.");
      return;
    }
    setFormError(null);
    setExistingSeriesId(null);
    configureSource.mutate(
      { url: trimmed },
      {
        onSuccess: () => {
          toast({ title: "Source connected", tone: "success" });
          reset();
          onClose();
        },
        onError: (error) => {
          const conflictId = getExistingSeriesId(error);
          if (conflictId) {
            setExistingSeriesId(conflictId);
            return;
          }
          setFormError(error.message);
        },
      },
    );
  }

  const host = hostOf(url.trim());

  return (
    <Dialog open={open} onClose={handleClose} title="Connect a source" className="max-w-md">
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <Field
          label="Series URL"
          htmlFor="configure-source-url"
          help="The series' page on the site Kiri should sync from."
        >
          <Input
            id="configure-source-url"
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setResolved(null);
              setExistingSeriesId(null);
            }}
            onBlur={handleBlur}
            placeholder="https://…"
            disabled={configureSource.isPending}
          />
        </Field>

        {resolveUrl.isPending ? (
          <p className="text-xs text-muted">Checking…</p>
        ) : resolved ? (
          resolved.handled ? (
            <p className="flex items-center gap-1.5 text-xs text-success">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Recognised by {resolved.pluginName}
            </p>
          ) : (
            <p className="flex items-center gap-1.5 text-xs text-warning">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              No installed plugin handles {host ?? "this site"} — ask an admin to install one.
            </p>
          )
        ) : null}

        {existingSeriesId ? (
          <div className="rounded-md border border-primary/30 bg-primary-light p-3 text-sm text-foreground">
            <p>Another series already uses this source.</p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-2"
              onClick={() => router.push(`/series/${existingSeriesId}`)}
            >
              Open that series
            </Button>
          </div>
        ) : null}

        {formError ? (
          <p role="alert" className="text-sm text-danger">
            {formError}
          </p>
        ) : null}

        <Button type="submit" loading={configureSource.isPending}>
          Connect
        </Button>
      </form>
    </Dialog>
  );
}
