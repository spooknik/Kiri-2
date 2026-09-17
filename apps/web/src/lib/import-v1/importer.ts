/**
 * Kiri 1.x → 2.0 import.
 *
 * One function, `runV1Import`, drives the whole thing; the admin job handler
 * (`src/lib/jobs/handlers/v1-import.ts`) and the CLI (`scripts/import-v1.ts`)
 * are two thin progress sinks around it.
 *
 * Order matters and is fixed (it is the plan's "V1 import" section):
 *
 *   preflight → users (+invites) → series (batched) → covers → library entries
 *   → sources → files (copy/link) → manifest ingest → reading positions
 *   → notifications → settings → credentials → job history → report
 *
 * Everything that follows from these three properties:
 *
 *   - **Idempotent.** Every row is looked up in `ImportMapping (v1Table, v1Id)`
 *     first. A mapped row is *updated*; an unmapped row that already exists in
 *     V2 for other reasons (same `malId`, same email) is *attached* — the
 *     mapping is recorded and the existing data is left exactly as it is,
 *     because the import must never overwrite something a V2 user typed.
 *   - **V1 is read-only.** `V1Client` enforces it at the connection level; this
 *     module never issues a write against it, and the connection string is
 *     never logged.
 *   - **Dry run is the same code.** `NoopWriter` answers every write with what
 *     the real writer would have returned, so `--dry-run` walks the identical
 *     path and produces the identical report shape.
 */
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { JobProgress } from "@/lib/contracts/content";
import type {
  V1ImportCounts,
  V1ImportMode,
  V1ImportReport,
  V1ImportTable,
  V1ImportWarning,
} from "@/lib/contracts/import-v1";
import { V1_IMPORT_TABLES } from "@/lib/contracts/import-v1";
import { normalizeManifest, type Manifest } from "@/lib/content/manifest";
import { MANIFEST_FILE } from "@/lib/content/store";
import { prisma } from "@/lib/prisma";
import { normalizeTags, sanitizePathSegment, toSortTitle } from "@/lib/text";
import {
  INVITE_EXPIRY_DAYS,
  isLocalV1Site,
  mapAutoSyncMode,
  mapCookie,
  mapMediaType,
  mapNotificationType,
  mapReadingStatus,
  mapRipJobKind,
  mapRipJobStatus,
  mapRipStatus,
  notificationCutoff,
  planCover,
  rewriteSeriesLink,
  ripSlugFromOutputDir,
  V1_COVER_EXTENSIONS,
} from "@/lib/import-v1/mapping";
import {
  V1Client,
  V1PreflightError,
  type V1Preflight,
  type V1Series,
  type V1SeriesRip,
} from "@/lib/import-v1/v1-client";
import {
  NoopWriter,
  PrismaWriter,
  type CredentialWrite,
  type ImportWriter,
  type InviteWrite,
  type JobWrite,
  type LibraryEntryWrite,
  type NotificationWrite,
  type PositionWrite,
  type SeriesWrite,
  type SourceWrite,
  type UserWrite,
} from "@/lib/import-v1/writer";

/** Series per transaction, as in the plan. */
const SERIES_BATCH = 200;
/** `IN (...)` chunk size for the lookups that fan out over imported ids. */
const LOOKUP_CHUNK = 500;
/** Warnings past this point are dropped (the count still reflects reality). */
const MAX_WARNINGS = 300;

export interface RunV1ImportOptions {
  databaseUrl: string;
  dataDir: string;
  mode: V1ImportMode;
  dryRun: boolean;
  adminEmail?: string | undefined;
  importJobs: "skip" | "history";
  /** V2 user that asked for the import (job runner); null for the CLI. */
  requestedById?: string | null | undefined;
}

export interface RunV1ImportHooks {
  onProgress?: ((progress: JobProgress) => void | Promise<void>) | undefined;
  log?: ((line: string) => void) | undefined;
  signal?: AbortSignal | undefined;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function emptyCounts(): V1ImportCounts {
  return { read: 0, created: 0, reused: 0, updated: 0, skipped: 0 };
}

function emptyCountsByTable(): Record<V1ImportTable, V1ImportCounts> {
  const out = {} as Record<V1ImportTable, V1ImportCounts>;
  for (const table of V1_IMPORT_TABLES) out[table] = emptyCounts();
  return out;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function fileExists(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

/** V1 wrote chapter directories with the same `sanitizePathSegment` V2 uses. */
function v1PagePath(seriesDir: string, slug: string, file: string): string {
  const parts = file
    .split(/[\\/]+/)
    .filter((part) => part !== "" && part !== ".")
    .map(sanitizePathSegment);
  return path.join(seriesDir, sanitizePathSegment(slug), ...parts);
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

export async function runV1Import(
  options: RunV1ImportOptions,
  hooks: RunV1ImportHooks = {},
): Promise<V1ImportReport> {
  const runId = randomUUID();
  const startedAt = new Date();
  const now = startedAt;
  const counts = emptyCountsByTable();
  const warnings: V1ImportWarning[] = [];
  const content: V1ImportReport["content"] = {
    sources: 0,
    copied: 0,
    linked: 0,
    failed: 0,
    bytes: 0,
    manifestsMissing: 0,
  };
  const needsPlugin = new Map<string, number>();
  let invites: V1ImportReport["invites"] = [];

  const log = hooks.log ?? (() => {});
  const writer: ImportWriter = options.dryRun ? new NoopWriter(runId) : new PrismaWriter(runId);

  function warn(warning: V1ImportWarning): void {
    if (warnings.length < MAX_WARNINGS) warnings.push(warning);
  }

  function checkAborted(): void {
    if (hooks.signal?.aborted) throw new Error("The import was cancelled.");
  }

  async function progress(update: JobProgress): Promise<void> {
    checkAborted();
    await hooks.onProgress?.(update);
  }

  const dataDir = path.resolve(options.dataDir);
  const ripsRoot = path.join(dataDir, "rips");
  const coversRoot = path.join(dataDir, "covers");

  const client = await V1Client.connect(options.databaseUrl);
  try {
    /* ---------------------------------------------------------------- */
    /* 1. Preflight                                                     */
    /* ---------------------------------------------------------------- */
    await progress({ phase: "preflight", message: "Checking the Kiri 1.x database" });
    const preflight: V1Preflight = await client.preflight(dataDir);
    log(
      `V1 schema ok (${preflight.migrations.length} migrations). ` +
        `rips/ ${preflight.rips.exists ? `${preflight.rips.entries} entries` : "missing"}, ` +
        `covers/ ${preflight.covers.exists ? `${preflight.covers.entries} entries` : "missing"}.`,
    );
    if (!preflight.rips.exists) {
      warn({
        code: "RIPS_DIR_MISSING",
        message: `No rips/ directory under ${dataDir} — no chapters will be imported.`,
      });
    }
    if (!preflight.covers.exists) {
      warn({
        code: "COVERS_DIR_MISSING",
        message: `No covers/ directory under ${dataDir} — covers will be skipped.`,
      });
    }

    const [v1Users, v1Series, v1UserSeries, v1Rips, v1Progress, v1Settings, v1Credentials] =
      await Promise.all([
        client.listUsers(),
        client.listSeries(),
        client.listUserSeries(),
        client.listSeriesRips(),
        client.listReaderProgress(),
        client.getAppSettings(),
        client.listSiteCredentials(),
      ]);
    const v1Notifications = await client.listFreshUnreadNotifications(notificationCutoff(now));

    const mappings = await loadMappings();

    /* ---------------------------------------------------------------- */
    /* 2. Users, admin choice, invites                                  */
    /* ---------------------------------------------------------------- */
    await progress({ phase: "users", current: 0, total: v1Users.length });

    const existingUsers = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        role: true,
        name: true,
        displayName: true,
        optimizerFormat: true,
        optimizerQuality: true,
      },
    });
    const usersByEmail = new Map(existingUsers.map((row) => [normalizeEmail(row.email), row]));
    const usersById = new Map(existingUsers.map((row) => [row.id, row]));
    const existingAdmin = existingUsers.find((row) => row.role === "admin") ?? null;

    const adminV1Id = existingAdmin ? null : chooseAdmin(v1Users, v1Series, options.adminEmail);
    if (!existingAdmin && options.adminEmail && adminV1Id !== null) {
      const chosen = v1Users.find((user) => user.id === adminV1Id);
      if (chosen && normalizeEmail(chosen.email) !== normalizeEmail(options.adminEmail)) {
        warn({
          code: "ADMIN_EMAIL_NOT_FOUND",
          message:
            `No Kiri 1.x user has the address ${options.adminEmail}; ` +
            `${chosen.email} was made admin instead.`,
        });
      }
    }
    if (existingAdmin) {
      log(
        `This instance already has an admin (${existingAdmin.email}); everyone imports as member.`,
      );
    }

    const userOps: UserWrite[] = [];
    for (const user of v1Users) {
      counts.users.read += 1;
      const email = normalizeEmail(user.email);
      const mappedId = mappings.users.get(user.id);
      const mapped = mappedId ? usersById.get(mappedId) : undefined;
      const byEmail = usersByEmail.get(email);
      const existing = mapped ?? byEmail ?? null;
      const mode = mapped ? "update" : existing ? "attach" : "create";
      const data = {
        email,
        name: user.display_name,
        displayName: user.display_name,
        role: (user.id === adminV1Id ? "admin" : "member") as "admin" | "member",
        optimizerFormat: user.optimizer_format,
        optimizerQuality: user.optimizer_quality,
        mustSetPassword: true,
        emailVerified: false,
        createdAt: user.created_at,
      };
      if (mode === "create") counts.users.created += 1;
      else if (mode === "attach") counts.users.reused += 1;
      else if (
        existing &&
        (existing.name !== data.name ||
          existing.displayName !== data.displayName ||
          existing.optimizerFormat !== data.optimizerFormat ||
          existing.optimizerQuality !== data.optimizerQuality)
      ) {
        counts.users.updated += 1;
      } else {
        counts.users.reused += 1;
      }
      userOps.push({ v1Id: user.id, mode, existingId: existing?.id ?? null, data });
    }

    const userIds = await writer.writeUsers(userOps);
    await progress({ phase: "users", current: v1Users.length, total: v1Users.length });

    const adminUserId = adminV1Id ? (userIds.get(adminV1Id) ?? null) : (existingAdmin?.id ?? null);
    const inviteCreatorId =
      options.requestedById ?? adminUserId ?? userIds.values().next().value ?? null;

    const inviteOps: InviteWrite[] = [];
    if (inviteCreatorId) {
      for (const op of userOps) {
        if (op.mode !== "create") continue;
        inviteOps.push({
          userId: userIds.get(op.v1Id) ?? "",
          email: op.data.email,
          displayName: op.data.displayName,
          role: op.data.role,
          expiresInDays: INVITE_EXPIRY_DAYS,
          createdById: inviteCreatorId,
        });
      }
    } else if (userOps.some((op) => op.mode === "create")) {
      warn({
        code: "INVITE_SKIPPED_NO_CREATOR",
        message: "No V2 user could own the invites, so none were created.",
      });
    }
    invites = await writer.createInvites(inviteOps);

    /* ---------------------------------------------------------------- */
    /* 3. Series                                                        */
    /* ---------------------------------------------------------------- */
    await progress({ phase: "series", current: 0, total: v1Series.length });

    const existingSeries = await prisma.series.findMany({
      select: {
        id: true,
        title: true,
        originalTitle: true,
        sortTitle: true,
        synopsis: true,
        mediaType: true,
        isAdult: true,
        isBookClub: true,
        publicationYear: true,
        totalChapters: true,
        totalVolumes: true,
        tags: true,
        sourceUrl: true,
        malId: true,
        createdById: true,
        coverFile: true,
      },
    });
    const seriesById = new Map(existingSeries.map((row) => [row.id, row]));
    const seriesByMalId = new Map<number, string>();
    const seriesByTitleCreator = new Map<string, string>();
    for (const row of existingSeries) {
      if (row.malId !== null && !seriesByMalId.has(row.malId)) seriesByMalId.set(row.malId, row.id);
      const key = `${row.title.trim().toLowerCase()} ${row.createdById}`;
      if (!seriesByTitleCreator.has(key)) seriesByTitleCreator.set(key, row.id);
    }

    const seriesOps: SeriesWrite[] = [];
    const coverPlans: { v1Id: string; url: string | null }[] = [];
    for (const series of v1Series) {
      counts.series.read += 1;
      let ownerId = userIds.get(series.created_by_id) ?? null;
      if (!ownerId) {
        ownerId = adminUserId;
        warn({
          code: "SERIES_CREATOR_MISSING",
          message: `Series "${series.title}" had no importable creator; it now belongs to the admin.`,
          v1Table: "series",
          v1Id: series.id,
        });
      }
      if (!ownerId) {
        counts.series.skipped += 1;
        warn({
          code: "SERIES_SKIPPED_NO_OWNER",
          message: `Series "${series.title}" was skipped: no V2 user to own it.`,
          v1Table: "series",
          v1Id: series.id,
        });
        continue;
      }

      const media = mapMediaType(series.media_type);
      const tags = normalizeTags([
        ...(series.tags ?? []),
        ...(media.extraTag ? [media.extraTag] : []),
      ]);
      const cover = planCover(series.image_url, series.id);
      const externalIds: Record<string, unknown> = {};
      if (series.mal_id !== null) externalIds.malId = series.mal_id;
      if (cover.kind === "remote") externalIds.remoteCover = cover.url;

      const data = {
        title: series.title,
        originalTitle: series.original_title,
        sortTitle: toSortTitle(series.title),
        synopsis: series.synopsis,
        mediaType: media.mediaType,
        isAdult: series.is_adult,
        isBookClub: series.is_book_club,
        publicationYear: series.publication_year,
        totalChapters: series.total_chapters,
        totalVolumes: series.total_volumes,
        tags,
        sourceUrl: series.link,
        externalIds,
        malId: series.mal_id,
        createdById: ownerId,
        createdAt: series.created_at,
      };

      const mappedId = mappings.series.get(series.id);
      const mapped = mappedId ? seriesById.get(mappedId) : undefined;
      const titleKey = `${series.title.trim().toLowerCase()} ${ownerId}`;
      const dedupedId =
        (series.mal_id !== null ? seriesByMalId.get(series.mal_id) : undefined) ??
        seriesByTitleCreator.get(titleKey);
      const existing = mapped ?? (dedupedId ? seriesById.get(dedupedId) : undefined) ?? null;
      const mode = mapped ? "update" : existing ? "attach" : "create";

      if (mode === "create") counts.series.created += 1;
      else if (mode === "attach") counts.series.reused += 1;
      else if (existing && seriesChanged(existing, data)) counts.series.updated += 1;
      else counts.series.reused += 1;

      seriesOps.push({ v1Id: series.id, mode, existingId: existing?.id ?? null, data });
      coverPlans.push({ v1Id: series.id, url: cover.kind === "local" ? series.id : null });
    }

    const seriesIds = new Map<string, string>();
    let seriesDone = 0;
    for (const batch of chunk(seriesOps, SERIES_BATCH)) {
      const written = await writer.writeSeriesBatch(batch);
      for (const [v1Id, v2Id] of written) {
        seriesIds.set(v1Id, v2Id);
        // Keep the in-run indexes fresh so two V1 rows that dedupe to the same
        // key do not both create a series.
        const op = batch.find((candidate) => candidate.v1Id === v1Id);
        if (op) {
          if (op.data.malId !== null && !seriesByMalId.has(op.data.malId)) {
            seriesByMalId.set(op.data.malId, v2Id);
          }
          const key = `${op.data.title.trim().toLowerCase()} ${op.data.createdById}`;
          if (!seriesByTitleCreator.has(key)) seriesByTitleCreator.set(key, v2Id);
        }
      }
      seriesDone += batch.length;
      await progress({ phase: "series", current: seriesDone, total: seriesOps.length });
    }

    /* ---------------------------------------------------------------- */
    /* 4. Covers                                                        */
    /* ---------------------------------------------------------------- */
    const localCovers = coverPlans.filter((plan) => plan.url !== null);
    await progress({ phase: "covers", current: 0, total: localCovers.length });
    let coversDone = 0;
    for (const plan of localCovers) {
      coversDone += 1;
      const seriesId = seriesIds.get(plan.v1Id);
      if (!seriesId) continue;
      // Never replace a cover this import did not put there.
      if (seriesById.get(seriesId)?.coverFile) continue;
      const image = await readV1Cover(coversRoot, plan.v1Id);
      if (!image) {
        warn({
          code: "COVER_MISSING",
          message: `No cover file under covers/${plan.v1Id}/.`,
          v1Table: "series",
          v1Id: plan.v1Id,
          seriesId,
        });
        continue;
      }
      try {
        await writer.storeCover(seriesId, image);
      } catch (error) {
        warn({
          code: "COVER_FAILED",
          message: `Cover for series ${plan.v1Id} could not be converted: ${describe(error)}`,
          v1Table: "series",
          v1Id: plan.v1Id,
          seriesId,
        });
      }
      if (coversDone % 20 === 0) {
        await progress({ phase: "covers", current: coversDone, total: localCovers.length });
      }
    }
    await progress({ phase: "covers", current: localCovers.length, total: localCovers.length });

    /* ---------------------------------------------------------------- */
    /* 5. Library entries                                               */
    /* ---------------------------------------------------------------- */
    await progress({ phase: "entries", current: 0, total: v1UserSeries.length });
    const importedSeriesIds = [...seriesIds.values()];
    const existingEntries = new Map<string, { id: string }>();
    for (const ids of chunk(importedSeriesIds, LOOKUP_CHUNK)) {
      const rows = await prisma.libraryEntry.findMany({
        where: { seriesId: { in: ids } },
        select: { id: true, userId: true, seriesId: true },
      });
      for (const row of rows) existingEntries.set(`${row.userId} ${row.seriesId}`, row);
    }

    const entryOps: LibraryEntryWrite[] = [];
    for (const entry of v1UserSeries) {
      counts.libraryEntries.read += 1;
      const userId = userIds.get(entry.user_id);
      const seriesId = seriesIds.get(entry.series_id);
      if (!userId || !seriesId) {
        counts.libraryEntries.skipped += 1;
        continue;
      }
      const mapped = mappings.userSeries.get(entry.id);
      const existing = existingEntries.get(`${userId} ${seriesId}`);
      const mode = mapped ? "update" : existing ? "attach" : "create";
      if (mode === "create") counts.libraryEntries.created += 1;
      else if (mode === "attach") counts.libraryEntries.reused += 1;
      else counts.libraryEntries.updated += 1;
      entryOps.push({
        v1Id: entry.id,
        mode,
        data: {
          userId,
          seriesId,
          status: mapReadingStatus(entry.status),
          currentChapter: entry.current_chapter,
          rating: entry.rating,
          notes: entry.notes,
          joinedAt: entry.joined_at,
        },
      });
    }
    await writer.writeLibraryEntries(entryOps);
    await progress({ phase: "entries", current: v1UserSeries.length, total: v1UserSeries.length });

    /* ---------------------------------------------------------------- */
    /* 6. Sources                                                       */
    /* ---------------------------------------------------------------- */
    await progress({ phase: "sources", current: 0, total: v1Rips.length });
    const plugins = await prisma.plugin.findMany({ select: { id: true, hosts: true } });
    const pluginBySite = new Map<string, string>();
    for (const plugin of plugins) {
      pluginBySite.set(plugin.id.toLowerCase(), plugin.id);
      for (const host of plugin.hosts) {
        if (!pluginBySite.has(host.toLowerCase())) pluginBySite.set(host.toLowerCase(), plugin.id);
      }
    }

    const existingSources = new Map<string, { id: string }>();
    for (const ids of chunk(importedSeriesIds, LOOKUP_CHUNK)) {
      const rows = await prisma.source.findMany({
        where: { seriesId: { in: ids } },
        select: { id: true, seriesId: true },
      });
      for (const row of rows) existingSources.set(row.seriesId, row);
    }

    const sourceOps: SourceWrite[] = [];
    for (const rip of v1Rips) {
      counts.sources.read += 1;
      const seriesId = seriesIds.get(rip.series_id);
      if (!seriesId) {
        counts.sources.skipped += 1;
        continue;
      }
      const site = (rip.site ?? "").trim();
      if (site === "" || isLocalV1Site(site)) {
        // PDF and manual content needs no Source: the chapters carry their
        // origin from the manifest (`source: "manual" | "pdf"`).
        counts.sources.skipped += 1;
        continue;
      }
      const pluginId = pluginBySite.get(site.toLowerCase()) ?? null;
      if (!pluginId) needsPlugin.set(site, (needsPlugin.get(site) ?? 0) + 1);
      const cookie = mapCookie(rip.cookie, rip.user_agent, rip.cookie_updated_at, now);
      if (cookie.dropped === "stale") {
        warn({
          code: "COOKIE_DROPPED_STALE",
          message: `The ${site} cookie for this series was older than 7 days and was not imported.`,
          v1Table: "series_rips",
          v1Id: rip.id,
          seriesId,
        });
      }
      const mapped = mappings.seriesRips.get(rip.id);
      const existing = existingSources.get(seriesId);
      const mode = mapped ? "update" : existing ? "attach" : "create";
      if (mode === "create") counts.sources.created += 1;
      else if (mode === "attach") counts.sources.reused += 1;
      else counts.sources.updated += 1;

      sourceOps.push({
        v1Id: rip.id,
        mode,
        data: {
          seriesId,
          pluginId,
          normalizedUrl: rip.normalized_url,
          slug: ripSlugFromOutputDir(rip.output_dir),
          status: mapRipStatus(rip.status, pluginId !== null),
          configJson: { v1Site: site },
          cookie: cookie.cookie,
          userAgent: cookie.userAgent,
          cookieUpdatedAt: cookie.cookie === null ? null : rip.cookie_updated_at,
          lastError: rip.last_error,
          lastSyncedAt: rip.last_synced_at,
          autoSyncMode: mapAutoSyncMode(rip.auto_sync_mode),
          autoSyncIntervalMinutes: rip.auto_sync_interval_minutes,
          autoSyncRequestedAt: rip.auto_sync_requested_at,
        },
      });
    }
    await writer.writeSources(sourceOps);
    await progress({ phase: "sources", current: v1Rips.length, total: v1Rips.length });

    /* ---------------------------------------------------------------- */
    /* 7 + 8. Files and manifest ingest                                 */
    /* ---------------------------------------------------------------- */
    await progress({ phase: "files", current: 0, total: v1Rips.length });
    /** seriesId -> chapter slug -> chapter id (real, or a placeholder in dry runs). */
    const chapterIds = new Map<string, Map<string, string>>();
    let ripsDone = 0;

    for (const rip of v1Rips) {
      ripsDone += 1;
      const seriesId = seriesIds.get(rip.series_id);
      if (!seriesId) continue;
      const sourceDir = resolveRipDir(ripsRoot, rip);
      if (!sourceDir) {
        content.manifestsMissing += 1;
        warn({
          code: "MANIFEST_MISSING",
          message: `Rip for series ${rip.series_id} has no usable output directory.`,
          v1Table: "series_rips",
          v1Id: rip.id,
          seriesId,
        });
        continue;
      }
      content.sources += 1;

      const manifestFile = path.join(sourceDir, MANIFEST_FILE);
      if (!(await fileExists(manifestFile))) {
        content.manifestsMissing += 1;
        warn({
          code: "MANIFEST_MISSING",
          message: `No manifest.json at ${sourceDir}; this series has no chapters to import.`,
          v1Table: "series_rips",
          v1Id: rip.id,
          seriesId,
        });
        continue;
      }

      const outcome = await writer.materialize({ seriesId, sourceDir, mode: options.mode });
      content.bytes += outcome.bytes;
      if (outcome.action === "copied") content.copied += 1;
      else if (outcome.action === "linked") content.linked += 1;
      else if (outcome.action === "failed") {
        content.failed += 1;
        warn({
          code: "FILES_FAILED",
          message: `Could not ${options.mode} ${sourceDir}: ${outcome.error ?? "unknown error"}`,
          v1Table: "series_rips",
          v1Id: rip.id,
          seriesId,
        });
        continue;
      }

      const manifest = await readManifest(manifestFile);
      if (!manifest) {
        content.manifestsMissing += 1;
        warn({
          code: "MANIFEST_MISSING",
          message: `manifest.json at ${sourceDir} is not readable JSON.`,
          v1Table: "series_rips",
          v1Id: rip.id,
          seriesId,
        });
        continue;
      }

      let plannedPages = 0;
      for (const chapter of manifest.chapters) {
        for (const image of chapter.images) {
          if (await fileExists(v1PagePath(sourceDir, chapter.slug, image.file))) plannedPages += 1;
        }
      }
      const [existingChapters, existingPages] = options.dryRun
        ? await Promise.all([
            prisma.chapter.count({ where: { seriesId } }),
            prisma.page.count({ where: { chapter: { seriesId } } }),
          ])
        : [0, 0];

      counts.chapters.read += manifest.chapters.length;
      counts.pages.read += plannedPages;

      const ingested = await writer.ingestSeries(seriesId, {
        chapters: manifest.chapters.length,
        pages: plannedPages,
        existingChapters,
        existingPages,
      });
      counts.chapters.created += ingested.chaptersCreated;
      counts.chapters.updated += ingested.chaptersUpdated;
      counts.chapters.reused += Math.max(
        0,
        manifest.chapters.length - ingested.chaptersCreated - ingested.chaptersUpdated,
      );
      counts.pages.created += ingested.pagesCreated;
      counts.pages.updated += ingested.pagesUpdated;
      counts.pages.reused += Math.max(
        0,
        plannedPages - ingested.pagesCreated - ingested.pagesUpdated,
      );
      for (const line of ingested.warnings) {
        warn({
          code: "INGEST_WARNING",
          message: line,
          v1Table: "series_rips",
          v1Id: rip.id,
          seriesId,
        });
      }

      // Placeholder ids in a dry run: nothing is written, but the position step
      // still has to answer "does this chapter slug exist?".
      const slugs = new Map<string, string>();
      for (const chapter of manifest.chapters) slugs.set(chapter.slug, randomUUID());
      chapterIds.set(seriesId, slugs);

      await progress({
        phase: "files",
        current: ripsDone,
        total: v1Rips.length,
        message: manifest.series?.title ?? undefined,
      });
    }

    // Real chapter ids, now that every manifest has been ingested.
    if (!options.dryRun) {
      for (const ids of chunk(importedSeriesIds, LOOKUP_CHUNK)) {
        const rows = await prisma.chapter.findMany({
          where: { seriesId: { in: ids } },
          select: { id: true, seriesId: true, slug: true },
        });
        for (const row of rows) {
          const bySlug = chapterIds.get(row.seriesId) ?? new Map<string, string>();
          bySlug.set(row.slug, row.id);
          chapterIds.set(row.seriesId, bySlug);
        }
      }
    }

    /* ---------------------------------------------------------------- */
    /* 9. Reading positions                                             */
    /* ---------------------------------------------------------------- */
    await progress({ phase: "positions", current: 0, total: v1Progress.length });
    const existingPositions = new Map<string, { id: string }>();
    for (const ids of chunk(importedSeriesIds, LOOKUP_CHUNK)) {
      const rows = await prisma.readingPosition.findMany({
        where: { seriesId: { in: ids } },
        select: { id: true, userId: true, seriesId: true },
      });
      for (const row of rows) existingPositions.set(`${row.userId} ${row.seriesId}`, row);
    }

    const positionOps: PositionWrite[] = [];
    for (const position of v1Progress) {
      counts.positions.read += 1;
      const userId = userIds.get(position.user_id);
      const seriesId = seriesIds.get(position.series_id);
      if (!userId || !seriesId) {
        counts.positions.skipped += 1;
        continue;
      }
      const slug = (position.chapter_slug ?? "").trim();
      const chapterId = slug === "" ? null : (chapterIds.get(seriesId)?.get(slug) ?? null);
      if (slug !== "" && chapterId === null) {
        warn({
          code: "POSITION_UNRESOLVED",
          message: `Chapter "${slug}" no longer exists; the reading position kept its page only.`,
          v1Table: "reader_progress",
          v1Id: position.id,
          seriesId,
        });
      }
      const mapped = mappings.readerProgress.get(position.id);
      const existing = existingPositions.get(`${userId} ${seriesId}`);
      const mode = mapped ? "update" : existing ? "attach" : "create";
      if (mode === "create") counts.positions.created += 1;
      else if (mode === "attach") counts.positions.reused += 1;
      else counts.positions.updated += 1;
      positionOps.push({
        v1Id: position.id,
        mode,
        data: {
          userId,
          seriesId,
          chapterId: options.dryRun ? null : chapterId,
          pageIndex: position.page_index,
          updatedAt: position.updated_at,
        },
      });
    }
    await writer.writePositions(positionOps);
    await progress({ phase: "positions", current: v1Progress.length, total: v1Progress.length });

    /* ---------------------------------------------------------------- */
    /* 10. Notifications                                                */
    /* ---------------------------------------------------------------- */
    await progress({ phase: "notifications", current: 0, total: v1Notifications.length });
    // `read` is every notification V1 has; the reader already dropped the ones
    // that are read or older than 30 days, so they show up as skipped.
    counts.notifications.read = preflight.counts.notifications;
    counts.notifications.skipped = Math.max(
      0,
      preflight.counts.notifications - v1Notifications.length,
    );

    const notificationOps: NotificationWrite[] = [];
    for (const notification of v1Notifications) {
      const userId = userIds.get(notification.user_id);
      const type = mapNotificationType(notification.type);
      if (!userId || !type) {
        counts.notifications.skipped += 1;
        continue;
      }
      if (mappings.notifications.has(notification.id)) {
        counts.notifications.reused += 1;
        continue;
      }
      counts.notifications.created += 1;
      notificationOps.push({
        v1Id: notification.id,
        data: {
          userId,
          type,
          title: notification.title,
          message: notification.message,
          link: rewriteSeriesLink(notification.link, (id) => seriesIds.get(id)),
          seriesId: notification.series_id ? (seriesIds.get(notification.series_id) ?? null) : null,
          createdAt: notification.created_at,
        },
      });
    }
    await writer.writeNotifications(notificationOps);

    /* ---------------------------------------------------------------- */
    /* 11. Settings                                                     */
    /* ---------------------------------------------------------------- */
    if (v1Settings) {
      counts.settings.read = 1;
      const already = await prisma.appSetting.findUnique({
        where: { id: "global" },
        select: { id: true },
      });
      if (already) counts.settings.updated = 1;
      else counts.settings.created = 1;
      await writer.writeSettings({
        autoSyncEnabled: v1Settings.auto_sync_enabled,
        autoSyncIntervalMinutes: v1Settings.auto_sync_interval_minutes,
        verbosePluginLogging: v1Settings.verbose_rip_logging,
      });
    }

    /* ---------------------------------------------------------------- */
    /* 12. Plugin credentials                                           */
    /* ---------------------------------------------------------------- */
    const existingCredentials = new Map<string, { id: string }>();
    if (v1Credentials.length > 0) {
      const rows = await prisma.pluginCredential.findMany({
        select: { id: true, pluginId: true, host: true },
      });
      for (const row of rows) existingCredentials.set(`${row.pluginId} ${row.host}`, row);
    }
    const pluginHosts = new Map(plugins.map((plugin) => [plugin.id, plugin.hosts]));
    const credentialOps: CredentialWrite[] = [];
    for (const credential of v1Credentials) {
      counts.credentials.read += 1;
      const pluginId = pluginBySite.get(credential.site.toLowerCase()) ?? null;
      if (!pluginId) {
        counts.credentials.skipped += 1;
        warn({
          code: "CREDENTIAL_SKIPPED_NO_PLUGIN",
          message: `No installed plugin handles "${credential.site}", so its saved cookie was skipped.`,
          v1Table: "site_credentials",
          v1Id: credential.id,
        });
        continue;
      }
      const cookie = mapCookie(
        credential.cookie,
        credential.user_agent,
        credential.updated_at,
        now,
      );
      if (cookie.cookie === null) {
        counts.credentials.skipped += 1;
        warn({
          code: "CREDENTIAL_DROPPED_STALE",
          message: `The saved cookie for "${credential.site}" was ${cookie.dropped === "stale" ? "older than 7 days" : "empty"} and was not imported.`,
          v1Table: "site_credentials",
          v1Id: credential.id,
        });
        continue;
      }
      const hosts = pluginHosts.get(pluginId) ?? [];
      const host = hosts.includes(credential.site)
        ? credential.site
        : (hosts[0] ?? credential.site);
      const mapped = mappings.siteCredentials.get(credential.id);
      const existing = existingCredentials.get(`${pluginId} ${host}`);
      const mode = mapped ? "update" : existing ? "attach" : "create";
      if (mode === "create") counts.credentials.created += 1;
      else if (mode === "attach") counts.credentials.reused += 1;
      else counts.credentials.updated += 1;
      credentialOps.push({
        v1Id: credential.id,
        mode,
        data: { pluginId, host, cookie: cookie.cookie, userAgent: cookie.userAgent },
      });
    }
    await writer.writeCredentials(credentialOps);

    /* ---------------------------------------------------------------- */
    /* 13. Job history                                                  */
    /* ---------------------------------------------------------------- */
    counts.jobs.read = preflight.counts.rip_jobs;
    if (options.importJobs === "history") {
      const ripById = new Map(v1Rips.map((rip) => [rip.id, rip]));
      const sourceIdByRip = await loadSourceIds(sourceOps, options.dryRun);
      const jobOps: JobWrite[] = [];
      for (const job of await client.listTerminalRipJobs()) {
        const kind = mapRipJobKind(job.kind);
        const status = mapRipJobStatus(job.status);
        const rip = ripById.get(job.series_rip_id);
        const seriesId = rip ? (seriesIds.get(rip.series_id) ?? null) : null;
        if (!kind || !status || !seriesId || mappings.ripJobs.has(job.id)) {
          counts.jobs.skipped += 1;
          continue;
        }
        counts.jobs.created += 1;
        jobOps.push({
          v1Id: job.id,
          kind,
          status,
          seriesId,
          sourceId: rip ? (sourceIdByRip.get(rip.id) ?? null) : null,
          config: { importedFromV1: true, v1Kind: job.kind },
          error: job.error,
          startedAt: job.started_at,
          finishedAt: job.finished_at,
          createdAt: job.created_at,
        });
      }
      await writer.writeJobs(jobOps);
      counts.jobs.skipped = Math.max(0, counts.jobs.read - counts.jobs.created);
    } else {
      counts.jobs.skipped = counts.jobs.read;
    }

    await progress({ phase: "report", message: "Assembling the report" });
  } finally {
    await client.close();
  }

  const finishedAt = new Date();
  return {
    runId,
    dryRun: options.dryRun,
    mode: options.mode,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    counts,
    content,
    needsPlugin: [...needsPlugin.entries()]
      .map(([site, seriesCount]) => ({ site, seriesCount }))
      .sort((a, b) => b.seriesCount - a.seriesCount || a.site.localeCompare(b.site)),
    invites,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Support                                                                    */
/* -------------------------------------------------------------------------- */

interface MappingIndex {
  users: Map<string, string>;
  series: Map<string, string>;
  userSeries: Map<string, string>;
  seriesRips: Map<string, string>;
  readerProgress: Map<string, string>;
  notifications: Map<string, string>;
  siteCredentials: Map<string, string>;
  ripJobs: Map<string, string>;
}

/** Everything a previous run recorded, so this one updates instead of inserts. */
async function loadMappings(): Promise<MappingIndex> {
  const rows = await prisma.importMapping.findMany({
    select: { v1Table: true, v1Id: true, v2Id: true },
  });
  const index: MappingIndex = {
    users: new Map(),
    series: new Map(),
    userSeries: new Map(),
    seriesRips: new Map(),
    readerProgress: new Map(),
    notifications: new Map(),
    siteCredentials: new Map(),
    ripJobs: new Map(),
  };
  const byTable: Record<string, Map<string, string>> = {
    users: index.users,
    series: index.series,
    user_series: index.userSeries,
    series_rips: index.seriesRips,
    reader_progress: index.readerProgress,
    notifications: index.notifications,
    site_credentials: index.siteCredentials,
    rip_jobs: index.ripJobs,
  };
  for (const row of rows) byTable[row.v1Table]?.set(row.v1Id, row.v2Id);
  return index;
}

/**
 * Admin when the V2 instance has none: `--admin-email` wins, then the V1 user
 * who created the most series, then the oldest account.
 */
function chooseAdmin(
  users: { id: string; email: string; created_at: Date }[],
  series: V1Series[],
  adminEmail: string | undefined,
): string | null {
  if (users.length === 0) return null;
  if (adminEmail) {
    const wanted = adminEmail.trim().toLowerCase();
    const match = users.find((user) => user.email.trim().toLowerCase() === wanted);
    if (match) return match.id;
  }
  const created = new Map<string, number>();
  for (const row of series) {
    created.set(row.created_by_id, (created.get(row.created_by_id) ?? 0) + 1);
  }
  let best: { id: string; count: number; createdAt: number } | null = null;
  for (const user of users) {
    const count = created.get(user.id) ?? 0;
    const createdAt = user.created_at.getTime();
    if (
      best === null ||
      count > best.count ||
      (count === best.count && createdAt < best.createdAt)
    ) {
      best = { id: user.id, count, createdAt };
    }
  }
  return best?.id ?? null;
}

function seriesChanged(
  existing: {
    title: string;
    originalTitle: string | null;
    sortTitle: string;
    synopsis: string | null;
    mediaType: string;
    isAdult: boolean;
    isBookClub: boolean;
    publicationYear: number | null;
    totalChapters: number | null;
    totalVolumes: number | null;
    tags: string[];
    sourceUrl: string | null;
    malId: number | null;
  },
  data: {
    title: string;
    originalTitle: string | null;
    sortTitle: string;
    synopsis: string | null;
    mediaType: string;
    isAdult: boolean;
    isBookClub: boolean;
    publicationYear: number | null;
    totalChapters: number | null;
    totalVolumes: number | null;
    tags: string[];
    sourceUrl: string | null;
    malId: number | null;
  },
): boolean {
  return (
    existing.title !== data.title ||
    existing.originalTitle !== data.originalTitle ||
    existing.sortTitle !== data.sortTitle ||
    existing.synopsis !== data.synopsis ||
    existing.mediaType !== data.mediaType ||
    existing.isAdult !== data.isAdult ||
    existing.isBookClub !== data.isBookClub ||
    existing.publicationYear !== data.publicationYear ||
    existing.totalChapters !== data.totalChapters ||
    existing.totalVolumes !== data.totalVolumes ||
    existing.tags.join(" ") !== data.tags.join(" ") ||
    existing.sourceUrl !== data.sourceUrl ||
    existing.malId !== data.malId
  );
}

/**
 * V1 rips live at `rips/<site>/<slug>`; `output_dir` holds the absolute path
 * from the machine that produced it, so only its basename is reusable.
 */
function resolveRipDir(ripsRoot: string, rip: V1SeriesRip): string | null {
  const site = (rip.site ?? "").trim();
  const slug = ripSlugFromOutputDir(rip.output_dir);
  if (site === "" || slug === null) return null;
  return path.join(ripsRoot, sanitizePathSegment(site), sanitizePathSegment(slug));
}

async function readManifest(file: string): Promise<Manifest | null> {
  try {
    const raw = await readFile(file, "utf8");
    return normalizeManifest(JSON.parse(raw)).manifest;
  } catch {
    return null;
  }
}

/** First V1 cover file that exists for a series, as a buffer. */
async function readV1Cover(coversRoot: string, v1SeriesId: string): Promise<Buffer | null> {
  for (const extension of V1_COVER_EXTENSIONS) {
    const file = path.join(coversRoot, sanitizePathSegment(v1SeriesId), `cover${extension}`);
    try {
      return await readFile(file);
    } catch {
      // Try the next extension.
    }
  }
  return null;
}

/** ripId -> Source id, for the imported job history. Empty in a dry run. */
async function loadSourceIds(
  sourceOps: SourceWrite[],
  dryRun: boolean,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (dryRun || sourceOps.length === 0) return out;
  const rows = await prisma.source.findMany({
    where: { seriesId: { in: sourceOps.map((op) => op.data.seriesId) } },
    select: { id: true, seriesId: true },
  });
  const bySeries = new Map(rows.map((row) => [row.seriesId, row.id]));
  for (const op of sourceOps) {
    const id = bySeries.get(op.data.seriesId);
    if (id) out.set(op.v1Id, id);
  }
  return out;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { V1PreflightError };
