/**
 * Pure V1 → V2 transforms.
 *
 * Everything in this file is a total function of its arguments: no database,
 * no filesystem, no clock except the `now` a caller passes in. That is what
 * makes the mapping table in the plan testable line by line, and it keeps
 * `importer.ts` about *order* rather than about *meaning*.
 *
 * The rules encoded here are the ones a re-read of the migration files cannot
 * tell you — which V1 vocabulary maps to which V2 enum, when a cookie is too
 * old to be worth carrying over, and what a V1 in-app link becomes once the
 * series it points at has a new id.
 */
import type {
  AutoSyncMode,
  ChapterOrigin,
  JobKind,
  JobStatus,
  MediaType,
  NotificationType,
  ReadingStatus,
  SourceStatus,
} from "@/generated/prisma/client";

/** Cookies older than this are dropped rather than re-encrypted. */
export const COOKIE_MAX_AGE_DAYS = 7;
/** Only notifications newer than this are imported (and only unread ones). */
export const NOTIFICATION_MAX_AGE_DAYS = 30;
/** Lifetime of the invite minted for each imported user. */
export const INVITE_EXPIRY_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Media type                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * V1 stored `media_type` as free text (migration 0003 turned the enum into
 * TEXT), seeded from the old enum plus whatever the Jikan importer wrote.
 * The five original values map 1:1; `COMIC`/`NOVEL` exist in the V2 enum and
 * are accepted; anything else becomes `OTHER` and the raw spelling is kept as
 * a tag so the information is not lost.
 */
const MEDIA_TYPES: Record<string, MediaType> = {
  MANGA: "MANGA",
  MANHWA: "MANHWA",
  MANHUA: "MANHUA",
  LIGHT_NOVEL: "LIGHT_NOVEL",
  BOOK: "BOOK",
  COMIC: "COMIC",
  NOVEL: "NOVEL",
  OTHER: "OTHER",
};

export interface MappedMediaType {
  mediaType: MediaType;
  /** Raw V1 value to append to `tags`, or null when it was recognised. */
  extraTag: string | null;
}

export function mapMediaType(raw: string | null | undefined): MappedMediaType {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return { mediaType: "MANGA", extraTag: null };
  const key = trimmed.toUpperCase().replace(/[\s-]+/g, "_");
  const known = MEDIA_TYPES[key];
  if (known) return { mediaType: known, extraTag: null };
  return { mediaType: "OTHER", extraTag: trimmed };
}

/* -------------------------------------------------------------------------- */
/* Reading status / auto-sync                                                 */
/* -------------------------------------------------------------------------- */

const READING_STATUSES = new Set<string>([
  "READING",
  "COMPLETED",
  "ON_HOLD",
  "DROPPED",
  "PLAN_TO_READ",
]);

/** V1 and V2 share the vocabulary; an unknown value falls back to the default. */
export function mapReadingStatus(raw: string | null | undefined): ReadingStatus {
  const key = (raw ?? "").trim().toUpperCase();
  return READING_STATUSES.has(key) ? (key as ReadingStatus) : "PLAN_TO_READ";
}

const AUTO_SYNC_MODES = new Set<string>(["INHERIT", "DISABLED", "CUSTOM"]);

export function mapAutoSyncMode(raw: string | null | undefined): AutoSyncMode {
  const key = (raw ?? "").trim().toUpperCase();
  return AUTO_SYNC_MODES.has(key) ? (key as AutoSyncMode) : "INHERIT";
}

/* -------------------------------------------------------------------------- */
/* Sources                                                                    */
/* -------------------------------------------------------------------------- */

/** V1 sites that never had a ripper: their chapters come from the manifest. */
export const LOCAL_V1_SITES = new Set(["pdf", "manual"]);

/** True when the V1 rip is local content (PDF import / manual upload). */
export function isLocalV1Site(site: string | null | undefined): boolean {
  return LOCAL_V1_SITES.has((site ?? "").trim().toLowerCase());
}

/**
 * `RipStatus` → `SourceStatus`. `UNSUPPORTED` meant "we have a URL but no
 * ripper for it", which in V2 is `UNCONFIGURED`; `RUNNING` cannot survive a
 * migration (no process is running) so it lands as `PENDING`.
 *
 * A source with no plugin installed is `NEEDS_PLUGIN` whatever V1 thought:
 * reading the already-downloaded chapters keeps working and syncing resumes
 * once the plugin is installed.
 */
export function mapRipStatus(raw: string | null | undefined, hasPlugin: boolean): SourceStatus {
  if (!hasPlugin) return "NEEDS_PLUGIN";
  switch ((raw ?? "").trim().toUpperCase()) {
    case "UNSUPPORTED":
      return "UNCONFIGURED";
    case "PENDING":
    case "RUNNING":
      return "PENDING";
    case "READY":
      return "READY";
    case "FAILED":
      return "FAILED";
    default:
      return "UNCONFIGURED";
  }
}

/**
 * Directory name V1 used under `rips/<site>/`. V1 built it from the series
 * slug (`getSeriesRipPaths`) and stored the result in `output_dir`, so the
 * basename of that column is the authoritative, already-sanitised value; the
 * PDF and manual paths (`rips/pdf/<seriesId>`, `rips/manual/<seriesId>`)
 * follow the same shape.
 */
export function ripSlugFromOutputDir(outputDir: string | null | undefined): string | null {
  const raw = (outputDir ?? "").trim();
  if (raw === "") return null;
  const parts = raw.split(/[\\/]+/).filter((part) => part !== "" && part !== ".");
  const last = parts[parts.length - 1];
  return last === undefined || last === "" ? null : last;
}

/* -------------------------------------------------------------------------- */
/* Cookies                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Ported verbatim from V1 `src/lib/rip-queue.ts:40-57`.
 *
 * Cloudflare's bot-management cookies are bound to the browser's IP and TLS
 * fingerprint, so replaying them from the server makes Cloudflare re-challenge
 * even when `cf_clearance` itself is still valid. Strip them before storing.
 */
const VOLATILE_COOKIE_NAMES = new Set(["__cf_bm", "_cfuvid", "cf_chl_rc_ni"]);

export function stripVolatileCookies(cookieHeader: string): string {
  // A bare cf_clearance value (no "=") has nothing to strip.
  if (!cookieHeader.includes("=")) return cookieHeader;

  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) return false;
      const name = (part.split("=")[0] ?? "").trim();
      return !VOLATILE_COOKIE_NAMES.has(name) && !name.startsWith("cf_chl_");
    })
    .join("; ");
}

/**
 * A cookie with no timestamp is a legacy paste of unknown age — V1's own
 * credential-recency rule treats that as epoch 0 (`rip-queue.ts:517-519`), so
 * the importer treats it as stale and drops it. Re-pasting a cookie takes ten
 * seconds; a silently dead one costs a failed sync and a confused user.
 */
export function isCookieStale(
  updatedAt: Date | null | undefined,
  now: Date,
  maxAgeDays: number = COOKIE_MAX_AGE_DAYS,
): boolean {
  if (!updatedAt) return true;
  const age = now.getTime() - updatedAt.getTime();
  return age > maxAgeDays * DAY_MS;
}

export interface MappedCookie {
  /** Cleaned cookie header, or null when it must not be carried over. */
  cookie: string | null;
  userAgent: string | null;
  /** Why it was dropped, for the report. */
  dropped: "stale" | "empty" | null;
}

/**
 * Decide what a V1 cookie/User-Agent pair becomes. `cf_clearance` is bound to
 * the exact User-Agent that solved the challenge, so the two travel together
 * or not at all.
 */
export function mapCookie(
  cookie: string | null | undefined,
  userAgent: string | null | undefined,
  updatedAt: Date | null | undefined,
  now: Date,
): MappedCookie {
  const raw = (cookie ?? "").trim();
  if (raw === "") return { cookie: null, userAgent: null, dropped: "empty" };
  if (isCookieStale(updatedAt, now)) return { cookie: null, userAgent: null, dropped: "stale" };
  const cleaned = stripVolatileCookies(raw).trim();
  if (cleaned === "") return { cookie: null, userAgent: null, dropped: "empty" };
  return { cookie: cleaned, userAgent: (userAgent ?? "").trim() || null, dropped: null };
}

/* -------------------------------------------------------------------------- */
/* Notifications                                                              */
/* -------------------------------------------------------------------------- */

const NOTIFICATION_TYPES: Record<string, NotificationType> = {
  BOOK_CLUB_ADDED: "BOOK_CLUB_ADDED",
  RIP_COMPLETED: "SYNC_COMPLETED",
  RIP_FAILED: "SYNC_FAILED",
  NEW_CHAPTER: "NEW_CHAPTER",
};

/** V1's four notification types; anything unknown is not importable. */
export function mapNotificationType(raw: string | null | undefined): NotificationType | null {
  return NOTIFICATION_TYPES[(raw ?? "").trim().toUpperCase()] ?? null;
}

/**
 * Rewrite an in-app link so it points at the imported series.
 *
 * V1 only ever produced `/series/<id>` and `/series/<id>?fix=cookie`
 * (`src/lib/notifications.ts:88`, `src/lib/rip-queue.ts:735`). The query
 * string is preserved; any deeper path (`/series/<id>/reader`) is dropped
 * because V2 has no such route — the series page is the right landing spot.
 * A link whose series did not import becomes null rather than a 404.
 */
export function rewriteSeriesLink(
  link: string | null | undefined,
  resolveSeriesId: (v1SeriesId: string) => string | undefined,
): string | null {
  const raw = (link ?? "").trim();
  if (raw === "") return null;
  const match = raw.match(/^\/series\/([^/?#]+)([/?#].*)?$/);
  if (!match?.[1]) return null;
  const mapped = resolveSeriesId(decodeURIComponent(match[1]));
  if (!mapped) return null;
  const rest = match[2] ?? "";
  const query = rest.startsWith("?") || rest.startsWith("#") ? rest : "";
  return `/series/${mapped}${query}`;
}

/* -------------------------------------------------------------------------- */
/* Jobs                                                                       */
/* -------------------------------------------------------------------------- */

const JOB_KINDS: Record<string, JobKind> = {
  SYNC: "SOURCE_SYNC",
  VERIFY: "SOURCE_VERIFY",
  OPTIMIZE: "OPTIMIZE",
  PDF_IMPORT: "PDF_IMPORT",
};

export function mapRipJobKind(raw: string | null | undefined): JobKind | null {
  return JOB_KINDS[(raw ?? "").trim().toUpperCase()] ?? null;
}

const TERMINAL_JOB_STATUSES: Record<string, JobStatus> = {
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
};

/** Only terminal rows are imported: a QUEUED/RUNNING V1 job has no worker. */
export function mapRipJobStatus(raw: string | null | undefined): JobStatus | null {
  return TERMINAL_JOB_STATUSES[(raw ?? "").trim().toUpperCase()] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Covers                                                                     */
/* -------------------------------------------------------------------------- */

/** V1 cover files, in the order `cover-storage.ts` preferred them. */
export const V1_COVER_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"] as const;

export type CoverPlan =
  { kind: "local"; v1SeriesId: string } | { kind: "remote"; url: string } | { kind: "none" };

/**
 * V1 `image_url` is either the local cover route (`/api/series/<id>/cover`,
 * `cover-storage.ts:103-105`) or a remote URL left over from before local
 * storage existed. Local covers are copied through the V2 cover pipeline;
 * remote ones are recorded in `externalIds.remoteCover` and *not* fetched —
 * an import must not depend on thirty third-party hosts still being up.
 */
export function planCover(imageUrl: string | null | undefined, v1SeriesId: string): CoverPlan {
  const raw = (imageUrl ?? "").trim();
  if (raw === "") return { kind: "none" };
  if (raw === `/api/series/${v1SeriesId}/cover`) return { kind: "local", v1SeriesId };
  if (/^https?:\/\//i.test(raw)) return { kind: "remote", url: raw };
  // Some other relative path: nothing we can resolve.
  return { kind: "none" };
}

/* -------------------------------------------------------------------------- */
/* Chapters                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * V1 manifests tag uploaded chapters with `source: "manual"` and PDF-imported
 * ones with `source: "pdf"`; everything else came from a ripper. `ingest.ts`
 * already implements exactly this, so the importer does not translate chapter
 * rows itself — this helper exists for the report and for tests.
 */
export function mapChapterOrigin(source: string | null | undefined): ChapterOrigin {
  switch ((source ?? "").trim().toLowerCase()) {
    case "manual":
      return "MANUAL";
    case "pdf":
      return "PDF";
    default:
      return "PLUGIN";
  }
}

/* -------------------------------------------------------------------------- */
/* Series identity                                                            */
/* -------------------------------------------------------------------------- */

/** Fallback dedupe key when a V1 series has no `mal_id`. */
export function seriesMatchKey(title: string, createdById: string): string {
  return `${title.trim().toLowerCase()} ${createdById}`;
}

/** Cut-off for the notification window, as a Date the SQL reader can use. */
export function notificationCutoff(now: Date, days: number = NOTIFICATION_MAX_AGE_DAYS): Date {
  return new Date(now.getTime() - days * DAY_MS);
}
