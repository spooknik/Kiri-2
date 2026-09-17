/**
 * Read-only access to a Kiri 1.x database.
 *
 * The importer talks to V1 with raw `pg` SQL rather than a second Prisma
 * client: V1's schema is frozen history, the column names here are the ones in
 * `prisma/migrations/0001_init … 0017_add_rip_cookie_updated_at` of the 1.x
 * repository, and a generated client for a dead schema would be one more thing
 * to keep alive.
 *
 * **Nothing here writes.** Every pooled connection is put into
 * `default_transaction_read_only`, so a mistake in a future edit is refused by
 * PostgreSQL itself rather than by code review. The connection string never
 * appears in a log line or an error message — callers hold it encrypted and
 * hand it to {@link V1Client.connect} at the last moment.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

/** The migration the importer requires; anything older is a different schema. */
export const REQUIRED_V1_MIGRATION = "0017_add_rip_cookie_updated_at";

/* -------------------------------------------------------------------------- */
/* Row shapes (exact V1 column names)                                         */
/* -------------------------------------------------------------------------- */

export interface V1User {
  id: string;
  email: string;
  display_name: string;
  optimizer_format: string;
  optimizer_quality: number;
  created_at: Date;
}

export interface V1Series {
  id: string;
  mal_id: number | null;
  title: string;
  original_title: string | null;
  publication_year: number | null;
  tags: string[];
  image_url: string | null;
  synopsis: string | null;
  media_type: string;
  is_adult: boolean;
  is_book_club: boolean;
  total_chapters: number | null;
  total_volumes: number | null;
  link: string | null;
  created_by_id: string;
  created_at: Date;
}

export interface V1UserSeries {
  id: string;
  user_id: string;
  series_id: string;
  status: string;
  current_chapter: number;
  rating: number | null;
  notes: string | null;
  updated_at: Date;
  joined_at: Date;
}

export interface V1SeriesRip {
  id: string;
  series_id: string;
  site: string | null;
  normalized_url: string | null;
  output_dir: string | null;
  manifest_path: string | null;
  status: string;
  cookie: string | null;
  user_agent: string | null;
  cookie_updated_at: Date | null;
  last_error: string | null;
  last_synced_at: Date | null;
  auto_sync_mode: string;
  auto_sync_interval_minutes: number | null;
  auto_sync_requested_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface V1RipJob {
  id: string;
  series_rip_id: string;
  kind: string;
  status: string;
  config_json: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface V1ReaderProgress {
  id: string;
  user_id: string;
  series_id: string;
  chapter_slug: string | null;
  page_index: number;
  updated_at: Date;
  created_at: Date;
}

export interface V1Notification {
  id: string;
  user_id: string;
  type: string;
  title: string;
  message: string;
  link: string | null;
  series_id: string | null;
  read_at: Date | null;
  created_at: Date;
}

export interface V1AppSettings {
  id: string;
  auto_sync_enabled: boolean;
  auto_sync_interval_minutes: number;
  verbose_rip_logging: boolean;
  updated_at: Date;
}

export interface V1SiteCredential {
  id: string;
  site: string;
  cookie: string | null;
  user_agent: string | null;
  updated_at: Date;
  created_at: Date;
}

/* -------------------------------------------------------------------------- */
/* Preflight                                                                  */
/* -------------------------------------------------------------------------- */

export const V1_SOURCE_TABLES = [
  "users",
  "series",
  "user_series",
  "series_rips",
  "rip_jobs",
  "reader_progress",
  "notifications",
  "app_settings",
  "site_credentials",
] as const;
export type V1SourceTable = (typeof V1_SOURCE_TABLES)[number];

export interface V1DirectoryStat {
  path: string;
  exists: boolean;
  /** Immediate entries; 0 when the directory is missing. */
  entries: number;
}

export interface V1Preflight {
  /** Applied migration names, oldest first. */
  migrations: string[];
  /** `site_credentials` was dropped by 0015 and re-added by 0016. */
  hasSiteCredentials: boolean;
  counts: Record<V1SourceTable, number>;
  dataDir: string;
  rips: V1DirectoryStat;
  covers: V1DirectoryStat;
}

/** Thrown when the V1 side cannot be imported at all (bad schema, no data dir). */
export class V1PreflightError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "V1PreflightError";
    this.code = code;
  }
}

async function statDirectory(dir: string): Promise<V1DirectoryStat> {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) return { path: dir, exists: false, entries: 0 };
    const entries = await readdir(dir);
    return { path: dir, exists: true, entries: entries.length };
  } catch {
    return { path: dir, exists: false, entries: 0 };
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? `${code} ${error.message}` : error.message;
  }
  return String(error);
}

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

export class V1Client {
  private constructor(private readonly pool: Pool) {}

  /**
   * Open a small read-only pool. `default_transaction_read_only` is set on
   * every connection as it is handed out, so a stray INSERT anywhere in the
   * importer is a database error, not a corrupted V1 install.
   */
  static async connect(databaseUrl: string): Promise<V1Client> {
    const pool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      connectionTimeoutMillis: 15_000,
      application_name: "kiri-v1-import",
    });
    // An idle-client error must not crash the process; the next query reports it.
    pool.on("error", () => {});
    const client = new V1Client(pool);
    try {
      await client.rows("SELECT 1");
    } catch (cause) {
      await pool.end().catch(() => {});
      throw new V1PreflightError(
        "V1_UNREACHABLE",
        `Could not connect to the Kiri 1.x database: ${describe(cause)}`,
      );
    }
    return client;
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }

  /**
   * Every query runs on a connection that has just been put into
   * `default_transaction_read_only`. The SET is awaited here rather than fired
   * from a `pool.on("connect")` listener, which pg 8 deprecates because it
   * overlaps two queries on one client.
   */
  private async rows<T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query("SET default_transaction_read_only = on");
      const result = await client.query<T>(sql, params);
      return result.rows;
    } finally {
      client.release();
    }
  }

  private async count(table: string): Promise<number> {
    const rows = await this.rows<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}"`);
    return Number(rows[0]?.n ?? 0);
  }

  private async tableExists(table: string): Promise<boolean> {
    const rows = await this.rows<{ present: boolean }>(
      `SELECT to_regclass($1) IS NOT NULL AS present`,
      [`public.${table}`],
    );
    return rows[0]?.present === true;
  }

  /**
   * Connect-time sanity check: the schema is the one this importer knows, and
   * the data directory has the two subdirectories the files come from.
   */
  async preflight(dataDir: string): Promise<V1Preflight> {
    if (!(await this.tableExists("_prisma_migrations"))) {
      throw new V1PreflightError(
        "V1_NOT_KIRI",
        "That database has no _prisma_migrations table — it is not a Kiri 1.x database.",
      );
    }
    const migrationRows = await this.rows<{ migration_name: string }>(
      `SELECT "migration_name" FROM "_prisma_migrations"
        WHERE "rolled_back_at" IS NULL AND "finished_at" IS NOT NULL
        ORDER BY "finished_at" ASC, "migration_name" ASC`,
    );
    const migrations = migrationRows.map((row) => row.migration_name);
    if (!migrations.includes(REQUIRED_V1_MIGRATION)) {
      throw new V1PreflightError(
        "V1_SCHEMA_TOO_OLD",
        `The Kiri 1.x database is missing migration ${REQUIRED_V1_MIGRATION}. ` +
          "Run the 1.x migrations on it first, then import.",
      );
    }

    const hasSiteCredentials = await this.tableExists("site_credentials");
    const counts = {} as Record<V1SourceTable, number>;
    for (const table of V1_SOURCE_TABLES) {
      counts[table] =
        table === "site_credentials" && !hasSiteCredentials ? 0 : await this.count(table);
    }

    const root = path.resolve(dataDir);
    const [rips, covers] = await Promise.all([
      statDirectory(path.join(root, "rips")),
      statDirectory(path.join(root, "covers")),
    ]);

    return { migrations, hasSiteCredentials, counts, dataDir: root, rips, covers };
  }

  /* ---------------------------------------------------------------------- */
  /* Table readers — column lists are the V1 migration column names verbatim */
  /* ---------------------------------------------------------------------- */

  listUsers(): Promise<V1User[]> {
    return this.rows<V1User & Record<string, unknown>>(
      `SELECT "id", "email", "display_name", "optimizer_format", "optimizer_quality", "created_at"
         FROM "users" ORDER BY "created_at" ASC, "id" ASC`,
    );
  }

  listSeries(): Promise<V1Series[]> {
    return this.rows<V1Series & Record<string, unknown>>(
      `SELECT "id", "mal_id", "title", "original_title", "publication_year", "tags",
              "image_url", "synopsis", "media_type", "is_adult", "is_book_club",
              "total_chapters", "total_volumes", "link", "created_by_id", "created_at"
         FROM "series" ORDER BY "created_at" ASC, "id" ASC`,
    );
  }

  listUserSeries(): Promise<V1UserSeries[]> {
    return this.rows<V1UserSeries & Record<string, unknown>>(
      `SELECT "id", "user_id", "series_id", "status"::text AS "status", "current_chapter",
              "rating", "notes", "updated_at", "joined_at"
         FROM "user_series" ORDER BY "joined_at" ASC, "id" ASC`,
    );
  }

  listSeriesRips(): Promise<V1SeriesRip[]> {
    return this.rows<V1SeriesRip & Record<string, unknown>>(
      `SELECT "id", "series_id", "site", "normalized_url", "output_dir", "manifest_path",
              "status"::text AS "status", "cookie", "user_agent", "cookie_updated_at",
              "last_error", "last_synced_at", "auto_sync_mode"::text AS "auto_sync_mode",
              "auto_sync_interval_minutes", "auto_sync_requested_at", "created_at", "updated_at"
         FROM "series_rips" ORDER BY "created_at" ASC, "id" ASC`,
    );
  }

  /** Terminal rows only, and never `output_log` — V1 job logs are not imported. */
  listTerminalRipJobs(): Promise<V1RipJob[]> {
    return this.rows<V1RipJob & Record<string, unknown>>(
      `SELECT "id", "series_rip_id", "kind"::text AS "kind", "status"::text AS "status",
              "config_json", "started_at", "finished_at", "error", "created_at", "updated_at"
         FROM "rip_jobs"
        WHERE "status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
        ORDER BY "created_at" ASC, "id" ASC`,
    );
  }

  listReaderProgress(): Promise<V1ReaderProgress[]> {
    return this.rows<V1ReaderProgress & Record<string, unknown>>(
      `SELECT "id", "user_id", "series_id", "chapter_slug", "page_index", "updated_at", "created_at"
         FROM "reader_progress" ORDER BY "updated_at" ASC, "id" ASC`,
    );
  }

  /** Unread and newer than `since`; read or stale notifications are not imported. */
  listFreshUnreadNotifications(since: Date): Promise<V1Notification[]> {
    return this.rows<V1Notification & Record<string, unknown>>(
      `SELECT "id", "user_id", "type"::text AS "type", "title", "message", "link",
              "series_id", "read_at", "created_at"
         FROM "notifications"
        WHERE "read_at" IS NULL AND "created_at" >= $1
        ORDER BY "created_at" ASC, "id" ASC`,
      [since],
    );
  }

  async getAppSettings(): Promise<V1AppSettings | null> {
    const rows = await this.rows<V1AppSettings & Record<string, unknown>>(
      `SELECT "id", "auto_sync_enabled", "auto_sync_interval_minutes", "verbose_rip_logging",
              "updated_at"
         FROM "app_settings" ORDER BY "id" ASC LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  async listSiteCredentials(): Promise<V1SiteCredential[]> {
    if (!(await this.tableExists("site_credentials"))) return [];
    return this.rows<V1SiteCredential & Record<string, unknown>>(
      `SELECT "id", "site", "cookie", "user_agent", "updated_at", "created_at"
         FROM "site_credentials" ORDER BY "site" ASC`,
    );
  }
}
