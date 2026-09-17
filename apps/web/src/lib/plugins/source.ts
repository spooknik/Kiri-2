/**
 * The per-series content source: bind a URL to a plugin, configure it, hand it
 * a cookie, and ask for a sync.
 *
 * One `Source` row per series (1:1), which is why every function here takes a
 * series id rather than a source id. Chapters do **not** belong to the source:
 * unbinding a series keeps everything that was downloaded, and a PDF or manual
 * chapter never needs a source at all.
 *
 * Authorization: viewing follows `canViewSeries`, every mutation follows
 * `canEditSeries` (creator or admin). Both are asserted here rather than in the
 * routes so a future caller cannot forget.
 */
import type { Prisma, Source } from "@/generated/prisma/client";
import { ApiError, badRequest, conflict, notFound } from "@/lib/api";
import type { SessionUser } from "@/lib/auth/types";
import { assertCanEditSeries, assertCanViewSeries } from "@/lib/authz";
import type {
  SourceView,
  configureSourceSchema,
  sourceCredentialSchema,
  updateSourceSchema,
} from "@/lib/contracts/plugins";
import { sealCookie } from "@/lib/plugins/credentials";
import {
  duplicateSourceConflict,
  findSeriesByNormalizedUrl,
  resolveUrl,
} from "@/lib/plugins/resolve";
import { readSourceConfig, toSourceView, type SourceSettings } from "@/lib/plugins/serialize";
import { enqueueJob } from "@/lib/jobs/queue";
import { triggerJobProcessing } from "@/lib/jobs/runner";
import { readGlobalPluginSettings } from "@/lib/plugins/app-settings";
import { prisma } from "@/lib/prisma";
import type { z } from "zod";

type ConfigureInput = z.infer<typeof configureSourceSchema>;
type UpdateInput = z.infer<typeof updateSourceSchema>;
type CredentialInput = z.infer<typeof sourceCredentialSchema>;

const SOURCE_JOB_KINDS = ["SOURCE_SYNC", "SOURCE_VERIFY"] as const;

const sourceWithPlugin = { plugin: true } satisfies Prisma.SourceInclude;
type SourceWithPlugin = Source & { plugin: Prisma.PluginGetPayload<object> | null };

/* -------------------------------------------------------------------------- */
/* Loading                                                                    */
/* -------------------------------------------------------------------------- */

const seriesAccessSelect = {
  id: true,
  visibility: true,
  isAdult: true,
  createdById: true,
} satisfies Prisma.SeriesSelect;

async function loadSeries(seriesId: string, user: SessionUser, mode: "view" | "edit") {
  const series = await prisma.series.findUnique({
    where: { id: seriesId },
    select: seriesAccessSelect,
  });
  if (!series) throw notFound("Series");
  if (mode === "edit") assertCanEditSeries(user, series);
  else assertCanViewSeries(user, series);
  return series;
}

/** The active SOURCE_SYNC/SOURCE_VERIFY job for a series, if any. */
export async function activeSourceJobId(seriesId: string): Promise<string | null> {
  const job = await prisma.job.findFirst({
    where: {
      seriesId,
      kind: { in: [...SOURCE_JOB_KINDS] },
      status: { in: ["QUEUED", "RUNNING"] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return job?.id ?? null;
}

async function buildView(seriesId: string, source: SourceWithPlugin | null): Promise<SourceView> {
  const settings = await readGlobalPluginSettings();
  const [activeJobId, credentialCount] = await Promise.all([
    activeSourceJobId(seriesId),
    source?.pluginId
      ? prisma.pluginCredential.count({ where: { pluginId: source.pluginId } })
      : Promise.resolve(0),
  ]);
  return toSourceView({
    seriesId,
    source,
    hasPluginCredential: credentialCount > 0,
    activeJobId,
    globalIntervalMinutes: settings.autoSyncIntervalMinutes,
    globalAutoSyncEnabled: settings.autoSyncEnabled,
  });
}

async function loadSource(seriesId: string): Promise<SourceWithPlugin | null> {
  return (await prisma.source.findUnique({
    where: { seriesId },
    include: sourceWithPlugin,
  })) as SourceWithPlugin | null;
}

/** GET /api/series/:id/source */
export async function getSourceView(user: SessionUser, seriesId: string): Promise<SourceView> {
  await loadSeries(seriesId, user, "view");
  return buildView(seriesId, await loadSource(seriesId));
}

/* -------------------------------------------------------------------------- */
/* Configure                                                                  */
/* -------------------------------------------------------------------------- */

/** Merge a settings patch into `configJson`, dropping keys set to null. */
function mergeConfig(
  existing: unknown,
  patch: SourceSettings | undefined,
  extra: Record<string, unknown> = {},
): Prisma.InputJsonValue {
  const current = readSourceConfig(existing);
  const settings = patch === undefined ? current.settings : { ...current.settings, ...patch };
  const config: Record<string, unknown> = { settings };
  if (current.v1Site !== null) config["v1Site"] = current.v1Site;
  return { ...config, ...extra } as Prisma.InputJsonValue;
}

/**
 * PUT /api/series/:id/source — resolve a URL and bind it.
 *
 * A URL no plugin claims is a 400 with the reason, not a source in a broken
 * state. A URL another *visible* series already reads is a 409 carrying that
 * series id, so the UI can offer to open it instead of silently creating a
 * second copy of the same shelf.
 */
export async function configureSource(
  user: SessionUser,
  seriesId: string,
  input: ConfigureInput,
): Promise<SourceView> {
  await loadSeries(seriesId, user, "edit");

  const resolved = await resolveUrl(input.url);
  if (!resolved.handled || !resolved.pluginId || !resolved.normalizedUrl) {
    throw badRequest(
      "No installed plugin handles that link. Install a plugin for this site, or check the URL.",
    );
  }

  const duplicate = await findSeriesByNormalizedUrl(user, resolved.normalizedUrl, {
    excludeSeriesId: seriesId,
  });
  if (duplicate) throw duplicateSourceConflict(duplicate);

  const existing = await prisma.source.findUnique({ where: { seriesId } });
  const configJson = mergeConfig(existing?.configJson, input.settings);

  await prisma.source.upsert({
    where: { seriesId },
    create: {
      seriesId,
      pluginId: resolved.pluginId,
      normalizedUrl: resolved.normalizedUrl,
      slug: resolved.slug,
      status: "PENDING",
      configJson,
    },
    update: {
      pluginId: resolved.pluginId,
      normalizedUrl: resolved.normalizedUrl,
      slug: resolved.slug,
      status: "PENDING",
      configJson,
      lastError: null,
      lastErrorCode: null,
    },
  });

  // Binding a URL is a request to fetch it; waiting for a second click would
  // only leave the series empty and the user wondering.
  await startSync(user, seriesId, "sync").catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 409) return;
    throw error;
  });

  return buildView(seriesId, await loadSource(seriesId));
}

/** PATCH /api/series/:id/source — auto-sync knobs and plugin settings. */
export async function updateSource(
  user: SessionUser,
  seriesId: string,
  input: UpdateInput,
): Promise<SourceView> {
  await loadSeries(seriesId, user, "edit");
  const existing = await prisma.source.findUnique({ where: { seriesId } });
  if (!existing) throw notFound("Source");

  const data: Prisma.SourceUpdateInput = {};
  if (input.autoSyncMode !== undefined) data.autoSyncMode = input.autoSyncMode;
  if (input.autoSyncIntervalMinutes !== undefined) {
    data.autoSyncIntervalMinutes = input.autoSyncIntervalMinutes ?? null;
  }
  if (input.settings !== undefined) {
    data.configJson = mergeConfig(existing.configJson, input.settings);
  }

  await prisma.source.update({ where: { seriesId }, data });
  return buildView(seriesId, await loadSource(seriesId));
}

/**
 * DELETE /api/series/:id/source — forget where the series came from. Chapters,
 * pages and files stay: they are the user's library, not the plugin's.
 */
export async function unbindSource(user: SessionUser, seriesId: string): Promise<void> {
  await loadSeries(seriesId, user, "edit");
  await prisma.source.deleteMany({ where: { seriesId } });
}

/* -------------------------------------------------------------------------- */
/* Credentials                                                                */
/* -------------------------------------------------------------------------- */

/**
 * PUT /api/series/:id/source/credential — a cookie pasted for this series.
 * `cookieUpdatedAt` is stamped here and nowhere else; the recency rule in
 * `credentials.ts` compares it against the extension's capture time.
 */
export async function setSeriesCredential(
  user: SessionUser,
  seriesId: string,
  input: CredentialInput,
): Promise<SourceView> {
  await loadSeries(seriesId, user, "edit");
  const existing = await prisma.source.findUnique({ where: { seriesId } });
  if (!existing) throw notFound("Source");

  await prisma.source.update({
    where: { seriesId },
    data: {
      cookieEnc: sealCookie(input.cookie),
      userAgent: input.userAgent?.trim() ? input.userAgent.trim() : null,
      cookieUpdatedAt: new Date(),
      // The cookie is the answer to that error; stop showing it.
      ...(existing.lastErrorCode === "NEEDS_CREDENTIAL" ? { lastErrorCode: null } : {}),
    },
  });
  return buildView(seriesId, await loadSource(seriesId));
}

/** DELETE /api/series/:id/source/credential */
export async function clearSeriesCredential(
  user: SessionUser,
  seriesId: string,
): Promise<SourceView> {
  await loadSeries(seriesId, user, "edit");
  const existing = await prisma.source.findUnique({ where: { seriesId } });
  if (!existing) throw notFound("Source");

  await prisma.source.update({
    where: { seriesId },
    data: { cookieEnc: null, userAgent: null, cookieUpdatedAt: null },
  });
  return buildView(seriesId, await loadSource(seriesId));
}

/* -------------------------------------------------------------------------- */
/* Syncing                                                                    */
/* -------------------------------------------------------------------------- */

export type SyncKind = "sync" | "verify";

/** Enqueue a run without the authz check (callers that already did it). */
async function startSync(
  user: SessionUser | null,
  seriesId: string,
  kind: SyncKind,
): Promise<string> {
  const source = await prisma.source.findUnique({
    where: { seriesId },
    include: sourceWithPlugin,
  });
  if (!source) throw notFound("Source");
  if (!source.pluginId) {
    throw conflict(
      "This series has no plugin installed for its link. Install the plugin, then sync.",
    );
  }
  if (!source.normalizedUrl) {
    throw conflict("This series has no link yet. Paste one before syncing.");
  }
  if (source.plugin && source.plugin.status !== "ENABLED") {
    throw conflict(`${source.plugin.name} is ${source.plugin.status.toLowerCase()}.`);
  }

  const job = await enqueueJob({
    kind: kind === "verify" ? "SOURCE_VERIFY" : "SOURCE_SYNC",
    seriesId,
    sourceId: source.id,
    pluginId: source.pluginId,
    requestedById: user?.id ?? null,
    config: { seriesId, sourceId: source.id, kind },
  });
  triggerJobProcessing();
  return job.id;
}

/** POST /api/series/:id/source/sync */
export async function requestSync(
  user: SessionUser,
  seriesId: string,
  kind: SyncKind,
): Promise<{ jobId: string }> {
  await loadSeries(seriesId, user, "edit");
  return { jobId: await startSync(user, seriesId, kind) };
}

/** Used by the auto-sync scheduler, which has no user and its own dedupe. */
export async function enqueueAutoSync(seriesId: string, sourceId: string, pluginId: string) {
  const job = await enqueueJob({
    kind: "SOURCE_SYNC",
    seriesId,
    sourceId,
    pluginId,
    config: { seriesId, sourceId, kind: "sync", autoSync: true },
  });
  return job;
}
