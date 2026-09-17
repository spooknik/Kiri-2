/**
 * The importer's only side effects.
 *
 * `importer.ts` decides *what* should happen; an {@link ImportWriter} decides
 * *whether it really happens*. {@link PrismaWriter} writes to PostgreSQL and
 * the content store; {@link NoopWriter} writes nothing and answers with what
 * the real writer would have produced, which is what makes `--dry-run` run the
 * identical code path and produce the identical report.
 *
 * Two rules the interface exists to enforce:
 *   - **Mapping rows travel with their subject.** Every create/update is
 *     committed in the same transaction as its `ImportMapping` row, so a crash
 *     can never leave a series imported but unmapped (which a re-run would
 *     then duplicate).
 *   - **Nothing in here knows about V1.** The writer takes V2-shaped data and
 *     a `(v1Table, v1Id)` pair; the translation happened in `mapping.ts`.
 */
import { createReadStream, createWriteStream, type Dirent } from "node:fs";
import { lstat, mkdir, readdir, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import type {
  AutoSyncMode,
  JobKind,
  JobStatus,
  MediaType,
  NotificationType,
  Prisma,
  ReadingStatus,
  SourceStatus,
} from "@/generated/prisma/client";
import { ingestManifest, type IngestResult } from "@/lib/content/ingest";
import { libraryDir, MANIFEST_FILE } from "@/lib/content/store";
import type { V1ImportMode } from "@/lib/contracts/import-v1";
import { storeCoverFromBuffer } from "@/lib/cover-storage";
import { encryptSecret } from "@/lib/crypto";
import { createInvite } from "@/lib/invites";
import { prisma } from "@/lib/prisma";
import { updateAppSettings } from "@/lib/settings";

/* -------------------------------------------------------------------------- */
/* Operation shapes                                                           */
/* -------------------------------------------------------------------------- */

/**
 * - `create`: no V2 row yet.
 * - `update`: a row this importer created on an earlier run; fields are topped
 *   up from V1.
 * - `attach`: a row that already existed in V2 for other reasons (a matching
 *   `malId`, a member who signed up before the import). Only the mapping row
 *   is written — the importer never overwrites data it did not create.
 */
export type WriteMode = "create" | "update" | "attach";

export interface UserData {
  email: string;
  name: string;
  displayName: string;
  role: "admin" | "member";
  optimizerFormat: string;
  optimizerQuality: number;
  mustSetPassword: boolean;
  emailVerified: boolean;
  createdAt: Date;
}

export interface UserWrite {
  v1Id: string;
  mode: WriteMode;
  existingId: string | null;
  data: UserData;
}

export interface InviteWrite {
  userId: string;
  email: string;
  displayName: string;
  role: "admin" | "member";
  expiresInDays: number;
  createdById: string;
}

export interface InviteResult {
  email: string;
  displayName: string;
  url: string;
  expiresAt: string;
}

export interface SeriesData {
  title: string;
  originalTitle: string | null;
  sortTitle: string;
  synopsis: string | null;
  mediaType: MediaType;
  isAdult: boolean;
  isBookClub: boolean;
  publicationYear: number | null;
  totalChapters: number | null;
  totalVolumes: number | null;
  tags: string[];
  sourceUrl: string | null;
  externalIds: Record<string, unknown>;
  malId: number | null;
  createdById: string;
  createdAt: Date;
}

export interface SeriesWrite {
  v1Id: string;
  mode: WriteMode;
  existingId: string | null;
  data: SeriesData;
}

export interface LibraryEntryData {
  userId: string;
  seriesId: string;
  status: ReadingStatus;
  currentChapter: number;
  rating: number | null;
  notes: string | null;
  joinedAt: Date;
}

export interface LibraryEntryWrite {
  v1Id: string;
  mode: WriteMode;
  data: LibraryEntryData;
}

export interface SourceData {
  seriesId: string;
  pluginId: string | null;
  normalizedUrl: string | null;
  slug: string | null;
  status: SourceStatus;
  configJson: Record<string, unknown>;
  cookie: string | null;
  userAgent: string | null;
  cookieUpdatedAt: Date | null;
  lastError: string | null;
  lastSyncedAt: Date | null;
  autoSyncMode: AutoSyncMode;
  autoSyncIntervalMinutes: number | null;
  autoSyncRequestedAt: Date | null;
}

export interface SourceWrite {
  v1Id: string;
  mode: WriteMode;
  data: SourceData;
}

export interface PositionData {
  userId: string;
  seriesId: string;
  chapterId: string | null;
  pageIndex: number;
  updatedAt: Date;
}

export interface PositionWrite {
  v1Id: string;
  mode: WriteMode;
  data: PositionData;
}

export interface NotificationData {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  link: string | null;
  seriesId: string | null;
  createdAt: Date;
}

export interface NotificationWrite {
  v1Id: string;
  data: NotificationData;
}

export interface CredentialData {
  pluginId: string;
  host: string;
  cookie: string | null;
  userAgent: string | null;
}

export interface CredentialWrite {
  v1Id: string;
  mode: WriteMode;
  data: CredentialData;
}

export interface SettingsWrite {
  autoSyncEnabled: boolean;
  autoSyncIntervalMinutes: number;
  verbosePluginLogging: boolean;
}

export interface JobWrite {
  v1Id: string;
  kind: JobKind;
  status: JobStatus;
  seriesId: string | null;
  sourceId: string | null;
  config: Record<string, unknown>;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

/** What a manifest promises before anything is written. */
export interface PlannedIngest {
  chapters: number;
  pages: number;
  /** Pages that already exist in V2 for this series (0 for a fresh import). */
  existingPages: number;
  existingChapters: number;
}

export interface IngestCounts {
  chaptersCreated: number;
  chaptersUpdated: number;
  pagesCreated: number;
  pagesUpdated: number;
  warnings: string[];
}

export type MaterializeAction = "copied" | "linked" | "skipped" | "failed";

export interface MaterializeRequest {
  seriesId: string;
  sourceDir: string;
  mode: V1ImportMode;
}

export interface MaterializeResult {
  action: MaterializeAction;
  bytes: number;
  error?: string;
}

/* -------------------------------------------------------------------------- */
/* Interface                                                                  */
/* -------------------------------------------------------------------------- */

export interface ImportWriter {
  readonly dryRun: boolean;
  readonly runId: string;

  /** All users plus their mapping rows in one transaction. v1Id -> v2Id. */
  writeUsers(ops: UserWrite[]): Promise<Map<string, string>>;
  createInvites(ops: InviteWrite[]): Promise<InviteResult[]>;
  /** One batch (<= 200) of series plus their mapping rows. v1Id -> v2Id. */
  writeSeriesBatch(ops: SeriesWrite[]): Promise<Map<string, string>>;
  /** Convert and store a cover; returns the stored file name or null. */
  storeCover(seriesId: string, image: Buffer): Promise<string | null>;
  writeLibraryEntries(ops: LibraryEntryWrite[]): Promise<void>;
  writeSources(ops: SourceWrite[]): Promise<void>;
  /** Copy or link one V1 rip directory into the V2 content store. */
  materialize(request: MaterializeRequest): Promise<MaterializeResult>;
  ingestSeries(seriesId: string, planned: PlannedIngest): Promise<IngestCounts>;
  writePositions(ops: PositionWrite[]): Promise<void>;
  writeNotifications(ops: NotificationWrite[]): Promise<void>;
  writeCredentials(ops: CredentialWrite[]): Promise<void>;
  writeSettings(op: SettingsWrite): Promise<void>;
  writeJobs(ops: JobWrite[]): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

const TRANSACTION_TIMEOUT_MS = 120_000;
const TRANSACTION_MAX_WAIT_MS = 30_000;
const INVITE_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Placeholder shown instead of a token that a dry run never minted. */
export const DRY_RUN_INVITE_URL = "(dry run - no invite was created)";

function json(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/**
 * `encryptSecret` returns a Node `Buffer` (backed by `ArrayBufferLike`), while
 * Prisma's `Bytes` columns want a plain `Uint8Array<ArrayBuffer>`. Copying is
 * the only way to promise the buffer is not shared.
 */
function toBytes(value: Buffer): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy;
}

async function recordMapping(
  tx: Prisma.TransactionClient,
  runId: string,
  v1Table: string,
  v1Id: string,
  v2Model: string,
  v2Id: string,
): Promise<void> {
  await tx.importMapping.upsert({
    where: { v1Table_v1Id: { v1Table, v1Id } },
    create: { runId, v1Table, v1Id, v2Model, v2Id },
    update: { runId, v2Model, v2Id },
  });
}

/** Recursive size of a directory; missing paths measure zero. */
export async function measureDirectory(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await measureDirectory(child);
    } else if (entry.isFile()) {
      try {
        total += (await stat(child)).size;
      } catch {
        // A file that vanished mid-walk contributes nothing.
      }
    }
  }
  return total;
}

async function fileSizeOf(file: string): Promise<number | null> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

/**
 * Stream-copy a directory tree, skipping files that already exist at the same
 * size. Returns the number of bytes actually written, so a resumed import
 * reports "0 bytes copied" rather than double-counting.
 */
async function copyTree(from: string, to: string): Promise<number> {
  await mkdir(to, { recursive: true });
  const entries = await readdir(from, { withFileTypes: true });
  let bytes = 0;
  for (const entry of entries) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      bytes += await copyTree(source, target);
      continue;
    }
    if (!entry.isFile()) continue;
    const sourceSize = await fileSizeOf(source);
    if (sourceSize === null) continue;
    if ((await fileSizeOf(target)) === sourceSize) continue;
    await pipeline(createReadStream(source), createWriteStream(target));
    bytes += sourceSize;
  }
  return bytes;
}

/** True when the target already holds a manifest of exactly the source's size. */
async function alreadyMaterialized(sourceDir: string, targetDir: string): Promise<boolean> {
  const sourceManifest = await fileSizeOf(path.join(sourceDir, MANIFEST_FILE));
  if (sourceManifest === null) return false;
  return (await fileSizeOf(path.join(targetDir, MANIFEST_FILE))) === sourceManifest;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* PrismaWriter                                                               */
/* -------------------------------------------------------------------------- */

export class PrismaWriter implements ImportWriter {
  readonly dryRun = false;

  constructor(readonly runId: string) {}

  async writeUsers(ops: UserWrite[]): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    if (ops.length === 0) return ids;
    await prisma.$transaction(
      async (tx) => {
        for (const op of ops) {
          let id = op.existingId;
          if (op.mode === "create") {
            const created = await tx.user.create({
              data: {
                email: op.data.email,
                name: op.data.name,
                displayName: op.data.displayName,
                role: op.data.role,
                optimizerFormat: op.data.optimizerFormat,
                optimizerQuality: op.data.optimizerQuality,
                mustSetPassword: op.data.mustSetPassword,
                emailVerified: op.data.emailVerified,
                createdAt: op.data.createdAt,
              },
              select: { id: true },
            });
            id = created.id;
          } else if (op.mode === "update" && id) {
            await tx.user.update({
              where: { id },
              data: {
                name: op.data.name,
                displayName: op.data.displayName,
                optimizerFormat: op.data.optimizerFormat,
                optimizerQuality: op.data.optimizerQuality,
              },
            });
          }
          if (!id) continue;
          // The only role change an import ever makes: promoting the chosen
          // admin on an instance that has none. Nobody is ever demoted, and an
          // existing V2 member is never touched otherwise.
          if (op.mode !== "create" && op.data.role === "admin") {
            await tx.user.update({ where: { id }, data: { role: "admin" } });
          }
          ids.set(op.v1Id, id);
          await recordMapping(tx, this.runId, "users", op.v1Id, "User", id);
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
    );
    return ids;
  }

  async createInvites(ops: InviteWrite[]): Promise<InviteResult[]> {
    const results: InviteResult[] = [];
    for (const op of ops) {
      const created = await createInvite({
        email: op.email,
        role: op.role,
        expiresInDays: op.expiresInDays,
        createdById: op.createdById,
      });
      results.push({
        email: op.email,
        displayName: op.displayName,
        url: created.url,
        expiresAt: created.invite.expiresAt.toISOString(),
      });
    }
    return results;
  }

  async writeSeriesBatch(ops: SeriesWrite[]): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    if (ops.length === 0) return ids;
    await prisma.$transaction(
      async (tx) => {
        for (const op of ops) {
          let id = op.existingId;
          if (op.mode === "create") {
            const created = await tx.series.create({
              data: {
                title: op.data.title,
                originalTitle: op.data.originalTitle,
                sortTitle: op.data.sortTitle,
                synopsis: op.data.synopsis,
                mediaType: op.data.mediaType,
                visibility: "SHARED",
                isAdult: op.data.isAdult,
                isBookClub: op.data.isBookClub,
                publicationYear: op.data.publicationYear,
                totalChapters: op.data.totalChapters,
                totalVolumes: op.data.totalVolumes,
                tags: op.data.tags,
                sourceUrl: op.data.sourceUrl,
                externalIds: json(op.data.externalIds),
                malId: op.data.malId,
                createdById: op.data.createdById,
                createdAt: op.data.createdAt,
              },
              select: { id: true },
            });
            id = created.id;
          } else if (op.mode === "update" && id) {
            await tx.series.update({
              where: { id },
              data: {
                title: op.data.title,
                originalTitle: op.data.originalTitle,
                sortTitle: op.data.sortTitle,
                synopsis: op.data.synopsis,
                mediaType: op.data.mediaType,
                isAdult: op.data.isAdult,
                isBookClub: op.data.isBookClub,
                publicationYear: op.data.publicationYear,
                totalChapters: op.data.totalChapters,
                totalVolumes: op.data.totalVolumes,
                tags: op.data.tags,
                sourceUrl: op.data.sourceUrl,
                externalIds: json(op.data.externalIds),
                malId: op.data.malId,
              },
            });
          }
          if (!id) continue;
          ids.set(op.v1Id, id);
          await recordMapping(tx, this.runId, "series", op.v1Id, "Series", id);
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
    );
    return ids;
  }

  async storeCover(seriesId: string, image: Buffer): Promise<string | null> {
    const { file } = await storeCoverFromBuffer(seriesId, image);
    await prisma.series.update({ where: { id: seriesId }, data: { coverFile: file } });
    return file;
  }

  async writeLibraryEntries(ops: LibraryEntryWrite[]): Promise<void> {
    if (ops.length === 0) return;
    await prisma.$transaction(
      async (tx) => {
        for (const op of ops) {
          const row = await tx.libraryEntry.upsert({
            where: {
              userId_seriesId: { userId: op.data.userId, seriesId: op.data.seriesId },
            },
            create: {
              userId: op.data.userId,
              seriesId: op.data.seriesId,
              status: op.data.status,
              currentChapter: op.data.currentChapter,
              rating: op.data.rating,
              notes: op.data.notes,
              joinedAt: op.data.joinedAt,
            },
            update:
              op.mode === "attach"
                ? {}
                : {
                    status: op.data.status,
                    currentChapter: op.data.currentChapter,
                    rating: op.data.rating,
                    notes: op.data.notes,
                  },
            select: { id: true },
          });
          await recordMapping(tx, this.runId, "user_series", op.v1Id, "LibraryEntry", row.id);
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
    );
  }

  async writeSources(ops: SourceWrite[]): Promise<void> {
    if (ops.length === 0) return;
    await prisma.$transaction(
      async (tx) => {
        for (const op of ops) {
          const cookieEnc = op.data.cookie === null ? null : toBytes(encryptSecret(op.data.cookie));
          const fields = {
            pluginId: op.data.pluginId,
            normalizedUrl: op.data.normalizedUrl,
            slug: op.data.slug,
            status: op.data.status,
            configJson: json(op.data.configJson),
            cookieEnc,
            userAgent: op.data.userAgent,
            cookieUpdatedAt: op.data.cookieUpdatedAt,
            lastError: op.data.lastError,
            lastSyncedAt: op.data.lastSyncedAt,
            autoSyncMode: op.data.autoSyncMode,
            autoSyncIntervalMinutes: op.data.autoSyncIntervalMinutes,
            autoSyncRequestedAt: op.data.autoSyncRequestedAt,
          };
          const row = await tx.source.upsert({
            where: { seriesId: op.data.seriesId },
            create: { seriesId: op.data.seriesId, ...fields },
            update: op.mode === "attach" ? {} : fields,
            select: { id: true },
          });
          await recordMapping(tx, this.runId, "series_rips", op.v1Id, "Source", row.id);
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
    );
  }

  async materialize(request: MaterializeRequest): Promise<MaterializeResult> {
    const target = libraryDir(request.seriesId);
    try {
      if (request.mode === "link") {
        if (await pathExists(target)) return { action: "skipped", bytes: 0 };
        await mkdir(path.dirname(target), { recursive: true });
        // "junction" is the only directory link Windows grants without
        // developer mode or elevation; "dir" is the POSIX equivalent.
        await symlink(request.sourceDir, target, process.platform === "win32" ? "junction" : "dir");
        return { action: "linked", bytes: 0 };
      }
      if (await alreadyMaterialized(request.sourceDir, target)) {
        return { action: "skipped", bytes: 0 };
      }
      const bytes = await copyTree(request.sourceDir, target);
      return { action: "copied", bytes };
    } catch (error) {
      return {
        action: "failed",
        bytes: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** `planned` is what a dry run would have guessed; the real thing measures. */
  async ingestSeries(seriesId: string): Promise<IngestCounts> {
    const before = await prisma.page.count({ where: { chapter: { seriesId } } });
    const result: IngestResult = await ingestManifest(seriesId, { reason: "import" });
    const after = await prisma.page.count({ where: { chapter: { seriesId } } });
    const pagesCreated = Math.max(0, after - before);
    return {
      chaptersCreated: result.chaptersCreated,
      chaptersUpdated: result.chaptersUpdated,
      pagesCreated,
      pagesUpdated: Math.max(0, result.pagesUpserted - pagesCreated),
      warnings: result.warnings,
    };
  }

  async writePositions(ops: PositionWrite[]): Promise<void> {
    if (ops.length === 0) return;
    await prisma.$transaction(
      async (tx) => {
        for (const op of ops) {
          const row = await tx.readingPosition.upsert({
            where: { userId_seriesId: { userId: op.data.userId, seriesId: op.data.seriesId } },
            create: {
              userId: op.data.userId,
              seriesId: op.data.seriesId,
              chapterId: op.data.chapterId,
              pageIndex: op.data.pageIndex,
            },
            update:
              op.mode === "attach"
                ? {}
                : { chapterId: op.data.chapterId, pageIndex: op.data.pageIndex },
            select: { id: true },
          });
          await recordMapping(
            tx,
            this.runId,
            "reader_progress",
            op.v1Id,
            "ReadingPosition",
            row.id,
          );
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
    );
  }

  async writeNotifications(ops: NotificationWrite[]): Promise<void> {
    if (ops.length === 0) return;
    await prisma.$transaction(
      async (tx) => {
        for (const op of ops) {
          const row = await tx.notification.create({
            data: {
              userId: op.data.userId,
              type: op.data.type,
              title: op.data.title,
              message: op.data.message,
              link: op.data.link,
              seriesId: op.data.seriesId,
              createdAt: op.data.createdAt,
            },
            select: { id: true },
          });
          await recordMapping(tx, this.runId, "notifications", op.v1Id, "Notification", row.id);
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
    );
  }

  async writeCredentials(ops: CredentialWrite[]): Promise<void> {
    if (ops.length === 0) return;
    await prisma.$transaction(async (tx) => {
      for (const op of ops) {
        const cookieEnc = op.data.cookie === null ? null : toBytes(encryptSecret(op.data.cookie));
        const row = await tx.pluginCredential.upsert({
          where: {
            pluginId_host: { pluginId: op.data.pluginId, host: op.data.host },
          },
          create: {
            pluginId: op.data.pluginId,
            host: op.data.host,
            cookieEnc,
            userAgent: op.data.userAgent,
          },
          update: op.mode === "attach" ? {} : { cookieEnc, userAgent: op.data.userAgent },
          select: { id: true },
        });
        await recordMapping(
          tx,
          this.runId,
          "site_credentials",
          op.v1Id,
          "PluginCredential",
          row.id,
        );
      }
    });
  }

  async writeSettings(op: SettingsWrite): Promise<void> {
    await updateAppSettings({
      autoSyncEnabled: op.autoSyncEnabled,
      autoSyncIntervalMinutes: op.autoSyncIntervalMinutes,
      verbosePluginLogging: op.verbosePluginLogging,
    });
  }

  async writeJobs(ops: JobWrite[]): Promise<void> {
    if (ops.length === 0) return;
    await prisma.$transaction(
      async (tx) => {
        for (const op of ops) {
          const row = await tx.job.create({
            data: {
              kind: op.kind,
              status: op.status,
              seriesId: op.seriesId,
              sourceId: op.sourceId,
              configJson: json(op.config),
              error: op.error,
              startedAt: op.startedAt,
              finishedAt: op.finishedAt,
              createdAt: op.createdAt,
            },
            select: { id: true },
          });
          await recordMapping(tx, this.runId, "rip_jobs", op.v1Id, "Job", row.id);
        }
      },
      { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* NoopWriter (dry run)                                                       */
/* -------------------------------------------------------------------------- */

/** One line per intended operation, for `--dry-run` output and for tests. */
export interface IntendedOperation {
  op: string;
  mode?: WriteMode;
  v1Id?: string;
  detail?: string;
}

/**
 * Answers every write with what {@link PrismaWriter} would have returned and
 * records the intent. Ids for created rows are freshly generated UUIDs: they
 * never reach the database, but downstream steps (covers, entries, sources,
 * ingest) need *a* key to work with, and using a real-looking one keeps the
 * dry run on exactly the same code path.
 */
export class NoopWriter implements ImportWriter {
  readonly dryRun = true;
  readonly operations: IntendedOperation[] = [];

  constructor(readonly runId: string) {}

  private record(op: IntendedOperation): void {
    this.operations.push(op);
  }

  async writeUsers(ops: UserWrite[]): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const op of ops) {
      const id = op.existingId ?? randomUUID();
      ids.set(op.v1Id, id);
      this.record({ op: "user", mode: op.mode, v1Id: op.v1Id, detail: op.data.email });
    }
    return ids;
  }

  async createInvites(ops: InviteWrite[]): Promise<InviteResult[]> {
    const expiresAt = new Date(Date.now() + INVITE_DAYS_MS).toISOString();
    return ops.map((op) => {
      this.record({ op: "invite", detail: op.email });
      return {
        email: op.email,
        displayName: op.displayName,
        url: DRY_RUN_INVITE_URL,
        expiresAt,
      };
    });
  }

  async writeSeriesBatch(ops: SeriesWrite[]): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const op of ops) {
      const id = op.existingId ?? randomUUID();
      ids.set(op.v1Id, id);
      this.record({ op: "series", mode: op.mode, v1Id: op.v1Id, detail: op.data.title });
    }
    return ids;
  }

  async storeCover(seriesId: string, image: Buffer): Promise<string | null> {
    this.record({ op: "cover", detail: `${seriesId} (${image.byteLength} bytes)` });
    return "cover.webp";
  }

  async writeLibraryEntries(ops: LibraryEntryWrite[]): Promise<void> {
    for (const op of ops) this.record({ op: "libraryEntry", mode: op.mode, v1Id: op.v1Id });
  }

  async writeSources(ops: SourceWrite[]): Promise<void> {
    for (const op of ops) {
      this.record({ op: "source", mode: op.mode, v1Id: op.v1Id, detail: op.data.status });
    }
  }

  async materialize(request: MaterializeRequest): Promise<MaterializeResult> {
    const bytes = await measureDirectory(request.sourceDir);
    this.record({ op: "files", detail: `${request.mode} ${request.sourceDir}` });
    return { action: request.mode === "link" ? "linked" : "copied", bytes };
  }

  async ingestSeries(seriesId: string, planned: PlannedIngest): Promise<IngestCounts> {
    this.record({ op: "ingest", detail: seriesId });
    return {
      chaptersCreated: Math.max(0, planned.chapters - planned.existingChapters),
      chaptersUpdated: Math.min(planned.chapters, planned.existingChapters),
      pagesCreated: Math.max(0, planned.pages - planned.existingPages),
      pagesUpdated: Math.min(planned.pages, planned.existingPages),
      warnings: [],
    };
  }

  async writePositions(ops: PositionWrite[]): Promise<void> {
    for (const op of ops) this.record({ op: "position", mode: op.mode, v1Id: op.v1Id });
  }

  async writeNotifications(ops: NotificationWrite[]): Promise<void> {
    for (const op of ops) this.record({ op: "notification", v1Id: op.v1Id });
  }

  async writeCredentials(ops: CredentialWrite[]): Promise<void> {
    for (const op of ops) {
      this.record({ op: "credential", mode: op.mode, v1Id: op.v1Id, detail: op.data.host });
    }
  }

  async writeSettings(op: SettingsWrite): Promise<void> {
    this.record({ op: "settings", detail: `autoSync=${op.autoSyncEnabled}` });
  }

  async writeJobs(ops: JobWrite[]): Promise<void> {
    for (const op of ops) this.record({ op: "job", v1Id: op.v1Id, detail: op.kind });
  }
}
