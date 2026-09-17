/**
 * V1_IMPORT job handler.
 *
 * Config (written by `POST /api/admin/import-v1`):
 * `{ databaseUrlEnc, dataDir, mode, dryRun, adminEmail?, importJobs, requestedById }`.
 *
 * `databaseUrlEnc` is base64 of the AES-256-GCM envelope from
 * `src/lib/crypto.ts`. The V1 connection string is a credential: it is
 * encrypted before it reaches `Job.configJson`, decrypted here, held in a local
 * for the length of the run, and never written to the job log, the report or an
 * error message.
 */
import { z } from "zod";
import { decryptSecret } from "@/lib/crypto";
import { V1_IMPORT_MODES, type V1ImportReport } from "@/lib/contracts/import-v1";
import { runV1Import } from "@/lib/import-v1/importer";
import { JobFailure, registerJobHandler, type JobContext } from "@/lib/jobs/types";
import { createNotifications } from "@/lib/notifications";
import { recordAudit } from "@/lib/audit";

const configSchema = z.object({
  /** base64(encryptSecret(v1 DATABASE_URL)) */
  databaseUrlEnc: z.string().min(1),
  dataDir: z.string().trim().min(1),
  mode: z.enum(V1_IMPORT_MODES).default("copy"),
  dryRun: z.boolean().default(false),
  adminEmail: z.string().trim().min(1).optional(),
  importJobs: z.enum(["skip", "history"]).default("skip"),
  requestedById: z.string().min(1).optional(),
});

/** A V1 import can take a long time on a big library; four hours is plenty. */
const TIMEOUT_MS = 4 * 60 * 60 * 1000;

function summarise(report: V1ImportReport): string {
  const { counts } = report;
  return (
    `${counts.series.created} series, ${counts.chapters.created} chapters, ` +
    `${counts.pages.created} pages, ${counts.users.created} users` +
    (report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : "")
  );
}

export async function handleV1Import(ctx: JobContext): Promise<V1ImportReport> {
  const parsed = configSchema.safeParse(ctx.job.config);
  if (!parsed.success) {
    throw new JobFailure("INVALID_CONFIG", `Invalid V1_IMPORT config: ${parsed.error.message}`);
  }
  const config = parsed.data;

  const databaseUrl = decryptSecret(Buffer.from(config.databaseUrlEnc, "base64"));
  if (databaseUrl === null) {
    throw new JobFailure(
      "NEEDS_CREDENTIAL",
      "The stored Kiri 1.x connection string could not be decrypted (APP_SECRET changed?). " +
        "Start the import again.",
    );
  }

  const requestedById = config.requestedById ?? ctx.job.requestedById ?? null;
  ctx.log(
    `Importing from Kiri 1.x — mode ${config.mode}` +
      `${config.dryRun ? " (dry run)" : ""}, data dir ${config.dataDir}`,
  );

  let report: V1ImportReport;
  try {
    report = await runV1Import(
      {
        databaseUrl,
        dataDir: config.dataDir,
        mode: config.mode,
        dryRun: config.dryRun,
        adminEmail: config.adminEmail,
        importJobs: config.importJobs,
        requestedById,
      },
      {
        signal: ctx.signal,
        log: (line) => ctx.log(line),
        onProgress: (update) => ctx.progress(update),
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "IMPORT_FAILED";
    throw new JobFailure(code, message);
  }

  ctx.log(`Import finished: ${summarise(report)}`);

  await recordAudit({
    actorId: requestedById,
    action: "import.v1",
    targetType: "import",
    targetId: report.runId,
    metadata: {
      dryRun: report.dryRun,
      mode: report.mode,
      durationMs: report.durationMs,
      series: report.counts.series,
      users: report.counts.users,
      warnings: report.warnings.length,
    },
  });

  if (requestedById) {
    await createNotifications({
      userIds: [requestedById],
      type: "IMPORT_COMPLETED",
      title: report.dryRun ? "Kiri 1.x dry run finished" : "Kiri 1.x import finished",
      message: report.dryRun
        ? `Nothing was written. It would import ${summarise(report)}.`
        : `Imported ${summarise(report)}.`,
      link: "/admin/import-v1",
      jobId: ctx.job.id,
    });
  }

  return report;
}

registerJobHandler("V1_IMPORT", handleV1Import, { timeoutMs: TIMEOUT_MS, maxAttempts: 1 });
