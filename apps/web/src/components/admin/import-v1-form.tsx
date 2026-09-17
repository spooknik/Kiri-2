"use client";

/**
 * Admin UI for the Kiri 1.x import.
 *
 * The form starts a `V1_IMPORT` job and then follows it with `useJob`; the
 * report the handler returns as `resultJson` is rendered underneath. Two
 * things the copy has to get across, because both are irreversible-ish:
 *
 *   - **dry run first** — it walks the whole import and writes nothing;
 *   - **copy vs link** — a link means the 1.x directory *becomes* Kiri 2's
 *     storage, so 1.x must be decommissioned first.
 *
 * The invite links are shown once. They are not stored anywhere in readable
 * form (only a hash is), so a lost link means minting a new invite by hand.
 */
import { useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Play, TriangleAlert } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  Switch,
  useToast,
} from "@/components/ui";
import { InviteUrlField } from "@/components/admin/invite-url-field";
import { useJob } from "@/hooks/use-jobs";
import { api, ApiClientError } from "@/lib/api-client";
import type { JobView } from "@/lib/contracts/content";
import {
  V1_IMPORT_TABLES,
  type V1ImportEnqueued,
  type V1ImportReport,
  type V1ImportTable,
} from "@/lib/contracts/import-v1";

const TABLE_LABELS: Record<V1ImportTable, string> = {
  users: "Users",
  series: "Series",
  libraryEntries: "Library entries",
  sources: "Sources",
  chapters: "Chapters",
  pages: "Pages",
  positions: "Reading positions",
  notifications: "Notifications",
  credentials: "Credentials",
  settings: "Settings",
  jobs: "Job history",
};

const COLUMNS = ["read", "created", "reused", "updated", "skipped"] as const;

interface FormState {
  databaseUrl: string;
  dataDir: string;
  mode: "copy" | "link";
  dryRun: boolean;
  adminEmail: string;
  importJobs: "skip" | "history";
}

const INITIAL: FormState = {
  databaseUrl: "",
  dataDir: "",
  mode: "copy",
  dryRun: true,
  adminEmail: "",
  importJobs: "skip",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function isReport(value: unknown): value is V1ImportReport {
  return (
    typeof value === "object" &&
    value !== null &&
    "runId" in value &&
    "counts" in value &&
    "content" in value
  );
}

export function ImportV1Form() {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const { toast } = useToast();
  const job = useJob(jobId);

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setStarting(true);
    try {
      const response = await api.post<V1ImportEnqueued>("/api/admin/import-v1", {
        databaseUrl: form.databaseUrl.trim(),
        dataDir: form.dataDir.trim(),
        mode: form.mode,
        dryRun: form.dryRun,
        ...(form.adminEmail.trim() ? { adminEmail: form.adminEmail.trim() } : {}),
        importJobs: form.importJobs,
      });
      setJobId(response.jobId);
      toast({
        title: form.dryRun ? "Dry run started" : "Import started",
        tone: "success",
      });
    } catch (error) {
      toast({
        title: "Could not start the import",
        description: error instanceof ApiClientError ? error.message : String(error),
        tone: "danger",
      });
    } finally {
      setStarting(false);
    }
  }

  const running = job.data?.status === "QUEUED" || job.data?.status === "RUNNING";

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Import from Kiri 1.x</CardTitle>
          <CardDescription>
            Reads a 1.x database and its data directory directly. Kiri never writes to the 1.x
            database. Run it with <strong>dry run</strong> first — that walks the entire import and
            reports what it would do without changing anything.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
            <Field
              label="1.x database URL"
              htmlFor="v1-database-url"
              help="postgresql://user:password@host:5432/readingtracker — used read-only and stored encrypted."
            >
              <Input
                type="password"
                autoComplete="off"
                placeholder="postgresql://…"
                value={form.databaseUrl}
                onChange={(event) => update("databaseUrl", event.target.value)}
                required
              />
            </Field>

            <Field
              label="1.x data directory"
              htmlFor="v1-data-dir"
              help="The folder that contains rips/ and covers/, as this server sees it (e.g. /data or D:\\kiri\\data)."
            >
              <Input
                value={form.dataDir}
                onChange={(event) => update("dataDir", event.target.value)}
                required
              />
            </Field>

            <Field
              label="Chapter files"
              htmlFor="v1-mode"
              help={
                form.mode === "copy"
                  ? "Copy duplicates every chapter into this instance's storage. Safe while 1.x is still running; needs the disk space twice."
                  : "Link points this instance at the 1.x folders instead of copying. No extra disk space, but the 1.x install must be decommissioned — its folders now belong to Kiri 2."
              }
            >
              <Select
                value={form.mode}
                onChange={(event) => update("mode", event.target.value as FormState["mode"])}
              >
                <option value="copy">Copy files (recommended)</option>
                <option value="link">Link to the 1.x folders</option>
              </Select>
            </Field>

            <Field
              label="Admin account"
              htmlFor="v1-admin-email"
              help="Which 1.x user becomes the admin. Leave blank to pick the person who added the most series. Ignored when this instance already has an admin — then everyone is imported as a member."
            >
              <Input
                type="email"
                placeholder="you@example.com"
                value={form.adminEmail}
                onChange={(event) => update("adminEmail", event.target.value)}
              />
            </Field>

            <Field
              label="Job history"
              htmlFor="v1-import-jobs"
              help="Finished 1.x sync jobs can be imported as history (without their logs)."
            >
              <Select
                value={form.importJobs}
                onChange={(event) =>
                  update("importJobs", event.target.value as FormState["importJobs"])
                }
              >
                <option value="skip">Do not import job history</option>
                <option value="history">Import finished jobs as history</option>
              </Select>
            </Field>

            <div className="flex items-center justify-between gap-3 border-t border-card-border pt-4">
              <div>
                <p className="text-sm font-medium text-foreground">Dry run</p>
                <p className="text-xs text-muted">
                  Walk the whole import and report what it would do. Nothing is written — no rows,
                  no files, no invites.
                </p>
              </div>
              <Switch
                checked={form.dryRun}
                onCheckedChange={(value) => update("dryRun", value)}
                aria-label="Dry run"
              />
            </div>

            <Button
              type="submit"
              className="self-start"
              loading={starting || running}
              disabled={starting || running}
            >
              <Play className="h-4 w-4" aria-hidden="true" />
              {form.dryRun ? "Start dry run" : "Start import"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {job.data ? <JobPanel job={job.data} /> : null}
    </div>
  );
}

function JobPanel({ job }: { job: JobView }) {
  const report = isReport(job.result) ? job.result : null;
  const total = job.progress.total ?? 0;
  const current = job.progress.current ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {job.status === "RUNNING" || job.status === "QUEUED" ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
          ) : job.status === "SUCCEEDED" ? (
            <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-danger" aria-hidden="true" />
          )}
          <span>Import job</span>
          <Badge
            tone={
              job.status === "SUCCEEDED"
                ? "success"
                : job.status === "FAILED" || job.status === "CANCELLED"
                  ? "danger"
                  : "primary"
            }
          >
            {job.status}
          </Badge>
        </CardTitle>
        <CardDescription>
          {job.progress.phase ? (
            <>
              {job.progress.phase}
              {total > 0 ? ` — ${current}/${total}` : ""}
              {percent !== null ? ` (${percent}%)` : ""}
              {job.progress.message ? ` — ${job.progress.message}` : ""}
            </>
          ) : (
            "Waiting for the worker…"
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {job.error ? (
          <p role="alert" className="text-sm text-danger">
            {job.errorCode ? `${job.errorCode}: ` : ""}
            {job.error}
          </p>
        ) : null}
        {report ? <ReportView report={report} /> : null}
      </CardContent>
    </Card>
  );
}

function ReportView({ report }: { report: V1ImportReport }) {
  return (
    <div className="flex flex-col gap-5">
      {report.dryRun ? (
        <p className="rounded-md border border-card-border bg-surface-2 p-3 text-sm text-secondary">
          This was a <strong>dry run</strong> — nothing was written. Turn dry run off and start it
          again to apply these changes.
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-sm">
          <caption className="sr-only">Rows read and written per table</caption>
          <thead>
            <tr className="border-b border-card-border text-muted">
              <th scope="col" className="py-1 text-left font-medium">
                Table
              </th>
              {COLUMNS.map((column) => (
                <th key={column} scope="col" className="py-1 text-right font-medium capitalize">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {V1_IMPORT_TABLES.map((table) => (
              <tr key={table} className="border-b border-card-border/50 last:border-0">
                <th scope="row" className="py-1 text-left font-normal text-foreground">
                  {TABLE_LABELS[table]}
                </th>
                {COLUMNS.map((column) => (
                  <td key={column} className="py-1 text-right tabular-nums text-secondary">
                    {report.counts[table][column]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-sm text-secondary">
        {report.content.sources} rip folder(s): {report.content.copied} copied,{" "}
        {report.content.linked} linked, {report.content.failed} failed,{" "}
        {formatBytes(report.content.bytes)} transferred, {report.content.manifestsMissing}{" "}
        manifest(s) missing.
      </p>

      {report.needsPlugin.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-foreground">Waiting for a plugin</h3>
          <p className="text-sm text-muted">
            These 1.x sites have no plugin installed yet. Their series are fully readable — only
            syncing new chapters is paused until you install a matching plugin, and the sources pick
            it up automatically.
          </p>
          <ul className="flex flex-wrap gap-2">
            {report.needsPlugin.map((entry) => (
              <li key={entry.site}>
                <Badge tone="warning">
                  {entry.site} · {entry.seriesCount}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {report.invites.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-foreground">Invite links</h3>
          <p className="text-sm text-muted">
            Imported accounts have no password yet. Send each person their link — they expire in 30
            days. <strong>These links are shown once</strong> and cannot be recovered afterwards;
            mint a replacement on the Invites page if one is lost.
          </p>
          <ul className="flex flex-col gap-3">
            {report.invites.map((invite) => (
              <li key={invite.email} className="flex flex-col gap-1">
                <span className="text-sm text-foreground">
                  {invite.displayName} <span className="text-muted">&lt;{invite.email}&gt;</span>
                </span>
                <InviteUrlField url={invite.url} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {report.warnings.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <TriangleAlert className="h-4 w-4 text-warning" aria-hidden="true" />
            Warnings ({report.warnings.length})
          </h3>
          <ul className="flex flex-col gap-1">
            {report.warnings.map((warning, index) => (
              <li key={`${warning.code}-${index}`} className="text-sm text-secondary">
                <span className="font-mono text-xs text-muted">{warning.code}</span>{" "}
                {warning.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
