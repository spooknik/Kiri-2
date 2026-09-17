"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import {
  Button,
  Checkbox,
  Dialog,
  Field,
  Input,
  Spinner,
  TabPanel,
  Tabs,
  useToast,
} from "@/components/ui";
import { useJob } from "@/hooks/use-jobs";
import { useInstallPlugin } from "@/hooks/use-plugins";
import { useUpload } from "@/hooks/use-upload";
import type { JobView } from "@/lib/contracts/content";
import type { InstallPluginInput } from "@/lib/contracts/plugins";
import { pluginQueryKeys } from "@/lib/plugin-query-keys";

export interface InstallPluginDialogProps {
  open: boolean;
  onClose: () => void;
}

type InstallTab = "upload" | "url" | "git";

const WARNING_TEXT =
  "Plugins run as programs on this server with access to your library files and network. Only install plugins you trust.";

/** Known PLUGIN_INSTALL failure codes with an actionable hint beyond the raw error message. */
const ERROR_HINTS: Record<string, string> = {
  SANDBOX_NOT_ACCEPTED:
    "This plugin asks for a relaxed sandbox. Check the box below and try again.",
  GIT_UNAVAILABLE: "Git isn't available on this server — use a zip upload or URL install instead.",
};

/** PLUGIN_INSTALL job phases (fetch/extract/install deps/link SDK/verify/finish) → display label. */
const INSTALL_PHASE_LABELS: Record<string, string> = {
  fetch: "Fetching",
  extract: "Extracting",
  "install deps": "Installing dependencies",
  "link sdk": "Linking SDK",
  verify: "Verifying",
  finish: "Finishing",
};

/**
 * Admin "Install plugin" flow: three install sources sharing one warning +
 * relaxed-sandbox checkbox, then inline PLUGIN_INSTALL job progress via
 * `useJob`. The zip-upload tab reuses the chunked upload client
 * (`useUpload`) to get an `uploadId` before posting the install request.
 */
export function InstallPluginDialog({ open, onClose }: InstallPluginDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { upload } = useUpload();
  const installPlugin = useInstallPlugin();

  const [tab, setTab] = useState<InstallTab>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [acceptRelaxedSandbox, setAcceptRelaxedSandbox] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  // Forces the Dialog to remount when the user cancels the "still
  // installing" confirm below — see UploadChapterDialog for the same trick.
  const [reopenKey, setReopenKey] = useState(0);

  const job = useJob(jobId);
  const jobActive = job.data?.status === "QUEUED" || job.data?.status === "RUNNING";
  const busy = uploading || installPlugin.isPending || jobActive;

  function reset() {
    setTab("upload");
    setFile(null);
    setUrl("");
    setGitUrl("");
    setGitRef("");
    setAcceptRelaxedSandbox(false);
    setFormError(null);
    setUploading(false);
    setJobId(null);
  }

  function handleCloseAttempt() {
    if (busy) {
      const proceed = window.confirm(
        "The plugin install is still in progress. Closing now won't cancel it — check the plugin list for the result. Close anyway?",
      );
      if (!proceed) {
        setReopenKey((key) => key + 1);
        return;
      }
    }
    reset();
    onClose();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    let input: InstallPluginInput;
    if (tab === "upload") {
      if (!file) {
        setFormError("Choose a .zip file.");
        return;
      }
      try {
        setUploading(true);
        const session = await upload(file);
        input = { type: "upload", uploadId: session.id, acceptRelaxedSandbox };
      } catch (err) {
        setFormError(err instanceof Error ? err.message : "Upload failed.");
        setUploading(false);
        return;
      }
      setUploading(false);
    } else if (tab === "url") {
      if (!url.trim()) {
        setFormError("Enter a URL.");
        return;
      }
      input = { type: "url", url: url.trim(), acceptRelaxedSandbox };
    } else {
      if (!gitUrl.trim()) {
        setFormError("Enter a git repository URL.");
        return;
      }
      input = {
        type: "git",
        url: gitUrl.trim(),
        ref: gitRef.trim() || undefined,
        acceptRelaxedSandbox,
      };
    }

    installPlugin.mutate(input, {
      onSuccess: (response) => setJobId(response.jobId),
      onError: (error) => setFormError(error.message),
    });
  }

  function handleDone() {
    void queryClient.invalidateQueries({ queryKey: pluginQueryKeys.pluginsAll });
    toast({ title: "Plugin installed", tone: "success" });
    reset();
    onClose();
  }

  return (
    <Dialog
      key={reopenKey}
      open={open}
      onClose={handleCloseAttempt}
      title="Install plugin"
      className="max-w-lg"
    >
      {!jobId ? (
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <Tabs
            items={[
              { value: "upload", label: "Upload zip" },
              { value: "url", label: "From URL" },
              { value: "git", label: "From git" },
            ]}
            value={tab}
            onValueChange={(v) => setTab(v as InstallTab)}
          >
            <TabPanel value="upload" activeValue={tab}>
              <Field label="Plugin .zip" htmlFor="install-plugin-file">
                <input
                  id="install-plugin-file"
                  type="file"
                  accept=".zip"
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setFile(event.target.files?.[0] ?? null)
                  }
                  disabled={busy}
                  className="block w-full text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-surface-2 file:px-3 file:py-2 file:text-sm file:font-medium file:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                />
              </Field>
            </TabPanel>
            <TabPanel value="url" activeValue={tab}>
              <Field label="Zip URL" htmlFor="install-plugin-url" help="Must be an https URL.">
                <Input
                  id="install-plugin-url"
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/plugin.zip"
                  disabled={busy}
                />
              </Field>
            </TabPanel>
            <TabPanel value="git" activeValue={tab}>
              <div className="flex flex-col gap-3">
                <Field label="Repository URL" htmlFor="install-plugin-git-url">
                  <Input
                    id="install-plugin-git-url"
                    type="url"
                    value={gitUrl}
                    onChange={(e) => setGitUrl(e.target.value)}
                    placeholder="https://github.com/…/plugin.git"
                    disabled={busy}
                  />
                </Field>
                <Field
                  label="Ref (optional)"
                  htmlFor="install-plugin-git-ref"
                  help="Branch, tag, or commit. Defaults to the repository's default branch."
                >
                  <Input
                    id="install-plugin-git-ref"
                    value={gitRef}
                    onChange={(e) => setGitRef(e.target.value)}
                    placeholder="main"
                    disabled={busy}
                  />
                </Field>
              </div>
            </TabPanel>
          </Tabs>

          <div className="rounded-md border border-warning/30 bg-warning-light p-3 text-sm text-warning">
            {WARNING_TEXT}
          </div>
          <Checkbox
            label="This plugin asks for a relaxed sandbox and I accept the risk"
            checked={acceptRelaxedSandbox}
            onChange={(e) => setAcceptRelaxedSandbox(e.target.checked)}
            disabled={busy}
          />

          {formError ? (
            <p role="alert" className="text-sm text-danger">
              {formError}
            </p>
          ) : null}

          <Button type="submit" loading={busy}>
            {uploading ? "Uploading…" : "Install"}
          </Button>
        </form>
      ) : (
        <InstallJobProgress
          job={job.data}
          isLoading={job.isPending}
          onDone={handleDone}
          onRetry={reset}
        />
      )}
    </Dialog>
  );
}

function InstallJobProgress({
  job,
  isLoading,
  onDone,
  onRetry,
}: {
  job: JobView | undefined;
  isLoading: boolean;
  onDone: () => void;
  onRetry: () => void;
}) {
  if (isLoading || !job) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner size="sm" /> Starting install…
      </div>
    );
  }

  if (job.status === "FAILED" || job.status === "CANCELLED") {
    const hint = job.errorCode ? ERROR_HINTS[job.errorCode] : undefined;
    return (
      <div className="flex flex-col gap-3">
        <div className="rounded-md bg-danger-light p-3 text-sm text-danger">
          <p className="font-medium">Install failed{job.errorCode ? ` (${job.errorCode})` : ""}</p>
          <p>{job.error ?? "Something went wrong."}</p>
          {hint ? <p className="mt-1">{hint}</p> : null}
        </div>
        <Button type="button" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  const { current, total, phase, message } = job.progress;
  const percent =
    total && total > 0 ? Math.min(100, Math.round(((current ?? 0) / total) * 100)) : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        {job.status === "SUCCEEDED" ? (
          <Check className="h-4 w-4 text-success" aria-hidden="true" />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        )}
        {job.status === "SUCCEEDED"
          ? "Installed"
          : phase
            ? (INSTALL_PHASE_LABELS[phase] ?? phase)
            : "Working"}
      </div>
      {percent !== null ? (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}
      {message ? <p className="text-xs text-muted">{message}</p> : null}
      {job.status === "SUCCEEDED" ? (
        <Button type="button" onClick={onDone}>
          Done
        </Button>
      ) : null}
    </div>
  );
}
