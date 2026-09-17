/**
 * Running one sync (or verify) of a series against its plugin.
 *
 * The plugin owns the series directory and the manifest; the host owns the
 * database. So a sync is: pick the credential, run the subprocess, forward its
 * events to the job, then **ingest the manifest** and turn what changed into
 * notifications. Nothing here parses HTML or touches an image.
 *
 * Rules that come straight from V1 and are worth keeping:
 *   - a failed sync leaves the previous chapters alone; the source carries the
 *     error, the library does not lose anything;
 *   - `NEEDS_CREDENTIAL` is not a retry — retrying without a new cookie just
 *     burns the site's patience — it is a notification asking for one;
 *   - an **automatic** sync that found nothing new says nothing at all. Only
 *     new chapters, and manual runs, are worth a notification.
 */
import { z } from "zod";
import { ManifestError } from "@/lib/content/manifest";
import { ingestManifest, type IngestResult } from "@/lib/content/ingest";
import { ensureDir, libraryDir, resolveInside } from "@/lib/content/store";
import { credentialForSource } from "@/lib/plugins/credentials";
import { getEnv } from "@/lib/env";
import { JobFailure, type JobContext } from "@/lib/jobs/types";
import { createNotifications } from "@/lib/notifications";
import { loadPlugin } from "@/lib/plugins/registry";
import { spawnPlugin, type PluginEvent, type PluginFailure } from "@/lib/plugins/process";
import { bundledSdkVersion, resolveSdkDir } from "@/lib/plugins/sdk-link";
import { readSourceConfig } from "@/lib/plugins/serialize";
import { prisma } from "@/lib/prisma";
import { readGlobalPluginSettings } from "@/lib/plugins/app-settings";

/** Page downloads a plugin may run in parallel. */
export const SYNC_CONCURRENCY = 4;
/** Silence from the plugin that means it is wedged. */
export const SYNC_IDLE_TIMEOUT_MS = 300_000;

export const syncConfigSchema = z.object({
  seriesId: z.uuid(),
  sourceId: z.uuid(),
  kind: z.enum(["sync", "verify"]).default("sync"),
  /** Set by the scheduler; suppresses "nothing changed" notifications. */
  autoSync: z.boolean().optional(),
});
export type SyncJobConfig = z.infer<typeof syncConfigSchema>;

export interface SyncResult {
  kind: "sync" | "verify";
  chaptersCreated: number;
  chaptersUpdated: number;
  chaptersMissing: number;
  pagesUpserted: number;
  newChapters: number;
  /** `data` from the plugin's `result` event. */
  pluginResult: unknown;
  warnings: string[];
  credentialOrigin: "series" | "plugin" | "none";
  sandboxed: boolean;
}

/* -------------------------------------------------------------------------- */
/* Failure handling                                                           */
/* -------------------------------------------------------------------------- */

/** Codes the scheduler may retry by itself. */
const RETRYABLE = new Set(["RATE_LIMITED", "NETWORK", "IO"]);

async function failSource(sourceId: string, code: string, message: string): Promise<void> {
  await prisma.source
    .update({
      where: { id: sourceId },
      data: { status: "FAILED", lastError: message.slice(0, 2000), lastErrorCode: code },
    })
    .catch(() => undefined);
}

/* -------------------------------------------------------------------------- */
/* The job                                                                    */
/* -------------------------------------------------------------------------- */

export async function runSourceSync(ctx: JobContext): Promise<SyncResult> {
  const parsed = syncConfigSchema.safeParse(ctx.job.config);
  if (!parsed.success) {
    throw new JobFailure("INVALID_CONFIG", `Invalid source-sync config: ${parsed.error.message}`);
  }
  const config = parsed.data;
  const verify = config.kind === "verify";

  /* 1. Source and plugin -------------------------------------------------- */
  const source = await prisma.source.findUnique({
    where: { id: config.sourceId },
    include: { plugin: true },
  });
  if (!source || source.seriesId !== config.seriesId) {
    throw new JobFailure("SOURCE_MISSING", "This series no longer has that content source.");
  }
  if (!source.normalizedUrl && !verify) {
    throw new JobFailure("SOURCE_MISSING", "This series has no link to sync from.");
  }

  if (!source.plugin) {
    await prisma.source.update({
      where: { id: source.id },
      data: { status: "NEEDS_PLUGIN", lastErrorCode: "PLUGIN_UNAVAILABLE" },
    });
    throw new JobFailure(
      "PLUGIN_UNAVAILABLE",
      "The plugin for this series is not installed. Install it from Admin -> Plugins.",
    );
  }
  if (source.plugin.status !== "ENABLED") {
    throw new JobFailure(
      "PLUGIN_UNAVAILABLE",
      `${source.plugin.name} is ${source.plugin.status.toLowerCase()}; enable it to sync.`,
    );
  }
  const plugin = await loadPlugin(source.plugin);
  if (!plugin) {
    throw new JobFailure(
      "PLUGIN_UNAVAILABLE",
      `${source.plugin.name} is installed but its files are unreadable.`,
    );
  }

  /* 2. Credential and settings ------------------------------------------- */
  const credential = await credentialForSource(source);
  if (credential.origin !== "none") {
    ctx.log(`Using the ${credential.origin === "series" ? "series" : "plugin"} cookie`);
  }
  const settings = readSourceConfig(source.configJson).settings;
  const appSettings = await readGlobalPluginSettings();

  const outputDir = libraryDir(config.seriesId);
  await ensureDir(outputDir);
  const scratch = resolveInside(ctx.tmpDir, "plugin");
  await ensureDir(scratch);

  await prisma.source.update({
    where: { id: source.id },
    data: { status: "RUNNING", lastError: null, lastErrorCode: null },
  });

  /* 3. Run ---------------------------------------------------------------- */
  const args = verify
    ? ["--output", outputDir]
    : [source.normalizedUrl ?? "", "--output", outputDir];

  ctx.log(`${verify ? "Verifying" : "Syncing"} with ${plugin.row.name} ${plugin.row.version}`);

  const run = await spawnPlugin({
    plugin: {
      id: plugin.row.id,
      dir: plugin.dir,
      entryPath: plugin.entryPath,
      descriptor: plugin.descriptor,
    },
    verb: verify ? "verify" : "sync",
    args,
    outputDir,
    tmpDir: scratch,
    sdkDir: resolveSdkDir(),
    signal: ctx.signal,
    timeouts: { idle: SYNC_IDLE_TIMEOUT_MS, total: getEnv().JOB_TIMEOUT_MS },
    env: {
      ...(credential.cookie ? { KIRI_COOKIE: credential.cookie } : {}),
      ...(credential.userAgent ? { KIRI_USER_AGENT: credential.userAgent } : {}),
      KIRI_OUTPUT_DIR: outputDir,
      KIRI_PLUGIN_DIR: plugin.dir,
      // The SDK version we actually linked, not the descriptor's range:
      // the SDK re-checks its own range against this and exits 7 on a
      // mismatch.
      KIRI_SDK_VERSION: bundledSdkVersion(),
      KIRI_APP_VERSION: process.env["NEXT_PUBLIC_APP_VERSION"] ?? "dev",
      KIRI_CONCURRENCY: String(SYNC_CONCURRENCY),
      KIRI_SETTINGS: JSON.stringify(settings),
      ...(appSettings.verbosePluginLogging ? { KIRI_VERBOSE: "1" } : {}),
    },
    onEvent: (event) => void forwardEvent(ctx, event),
    onStderr: (line) => ctx.log(line),
    onUnparsed: (line) => ctx.log(`[stdout] ${line}`),
  });

  if (run.retriedWithoutSandbox) {
    ctx.log("The sandbox blocked this plugin; it was re-run without it (KIRI_PLUGIN_SANDBOX=warn)");
  }

  /* 4. Failures ----------------------------------------------------------- */
  if (run.error) {
    await handleFailure(ctx, source.id, config, run.error);
  }

  /* 5. Ingest ------------------------------------------------------------- */
  let ingest: IngestResult;
  try {
    ingest = await ingestManifest(config.seriesId, { reason: "sync" });
  } catch (error) {
    if (error instanceof ManifestError) {
      await failSource(source.id, "MANIFEST_MISSING", error.message);
      throw new JobFailure(
        "MANIFEST_MISSING",
        `${plugin.row.name} finished without writing a manifest: ${error.message}`,
      );
    }
    throw error;
  }
  for (const warning of ingest.warnings) ctx.log(`[ingest] ${warning}`);

  await prisma.source.update({
    where: { id: source.id },
    data: {
      status: "READY",
      lastError: null,
      lastErrorCode: null,
      ...(verify ? {} : { lastSyncedAt: new Date() }),
    },
  });

  /* 6. Notifications ------------------------------------------------------ */
  await notifyNewChapters(config.seriesId, ingest);
  if (!config.autoSync && ctx.job.requestedById) {
    await createNotifications({
      userIds: [ctx.job.requestedById],
      type: "SYNC_COMPLETED",
      title: verify ? "Verify finished" : "Sync finished",
      message:
        ingest.newlyCompleted.length > 0
          ? `${ingest.newlyCompleted.length} new chapter(s) are ready to read.`
          : "No new chapters this time.",
      link: `/series/${config.seriesId}`,
      seriesId: config.seriesId,
      jobId: ctx.job.id,
      dedupeKey: `sync-done:${ctx.job.id}`,
    });
  }

  return {
    kind: config.kind,
    chaptersCreated: ingest.chaptersCreated,
    chaptersUpdated: ingest.chaptersUpdated,
    chaptersMissing: ingest.chaptersMissing,
    pagesUpserted: ingest.pagesUpserted,
    newChapters: ingest.newlyCompleted.length,
    pluginResult: run.result ?? null,
    warnings: ingest.warnings,
    credentialOrigin: credential.origin,
    sandboxed: run.sandboxed,
  };
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

/** Plugin events into job progress and the job log. */
async function forwardEvent(ctx: JobContext, event: PluginEvent): Promise<void> {
  switch (event.t) {
    case "progress":
      await ctx.progress({
        phase: event.phase,
        current: event.current,
        total: event.total,
        ...(event.chapterSlug === undefined ? {} : { chapterSlug: event.chapterSlug }),
      });
      return;
    case "log":
      if (event.level === "debug") return;
      ctx.log(`[${event.level}] ${event.msg}`);
      return;
    case "chapter":
      if (event.status === "failed") ctx.log(`Chapter ${event.slug} failed`);
      return;
    case "hello":
      ctx.log(`${event.plugin} ${event.version} (sdk ${event.sdk})`);
      return;
    default:
      return;
  }
}

/**
 * Turn a plugin failure into a job failure, after recording it on the source
 * and telling somebody who can fix it.
 */
async function handleFailure(
  ctx: JobContext,
  sourceId: string,
  config: SyncJobConfig,
  failure: PluginFailure,
): Promise<never> {
  const message = failure.hint ? `${failure.message} — ${failure.hint}` : failure.message;
  await failSource(sourceId, failure.code, message);

  if (failure.code === "NEEDS_CREDENTIAL") {
    const series = await prisma.series.findUnique({
      where: { id: config.seriesId },
      select: { title: true, createdById: true },
    });
    if (series) {
      await createNotifications({
        userIds: [series.createdById],
        type: "NEEDS_CREDENTIAL",
        title: `${series.title} needs a cookie`,
        message:
          `${message} Paste a fresh cookie and matching User-Agent on the series page, ` +
          "or capture one with the Kiri Cookie Bridge extension.",
        link: `/series/${config.seriesId}`,
        seriesId: config.seriesId,
        jobId: ctx.job.id,
        dedupeKey: `needs-credential:${config.seriesId}`,
      });
    }
    throw new JobFailure("NEEDS_CREDENTIAL", message, { retryable: false });
  }

  if (!config.autoSync && ctx.job.requestedById) {
    await createNotifications({
      userIds: [ctx.job.requestedById],
      type: "SYNC_FAILED",
      title: config.kind === "verify" ? "Verify failed" : "Sync failed",
      message,
      link: `/series/${config.seriesId}`,
      seriesId: config.seriesId,
      jobId: ctx.job.id,
      dedupeKey: `sync-failed:${ctx.job.id}`,
    });
  }

  throw new JobFailure(failure.code, message, {
    retryable: failure.retryable || RETRYABLE.has(failure.code),
  });
}

/** NEW_CHAPTER for everyone with this series in their library. */
async function notifyNewChapters(seriesId: string, ingest: IngestResult): Promise<void> {
  if (ingest.newlyCompleted.length === 0) return;

  const [series, trackers] = await Promise.all([
    prisma.series.findUnique({ where: { id: seriesId }, select: { title: true } }),
    prisma.libraryEntry.findMany({ where: { seriesId }, select: { userId: true } }),
  ]);
  if (!series || trackers.length === 0) return;

  const userIds = trackers.map((entry) => entry.userId);
  for (const chapter of ingest.newlyCompleted) {
    const label = chapter.number === null ? chapter.title : `Chapter ${chapter.number}`;
    await createNotifications({
      userIds,
      type: "NEW_CHAPTER",
      title: `${series.title}: ${label}`,
      message: chapter.title,
      link: `/read?series=${seriesId}&chapter=${chapter.chapterId}`,
      seriesId,
      dedupeKey: `new-chapter:${chapter.chapterId}`,
    });
  }
}
