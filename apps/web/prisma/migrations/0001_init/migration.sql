-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('SHARED', 'PRIVATE');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('MANGA', 'MANHWA', 'MANHUA', 'COMIC', 'LIGHT_NOVEL', 'NOVEL', 'BOOK', 'OTHER');

-- CreateEnum
CREATE TYPE "ReadingStatus" AS ENUM ('READING', 'COMPLETED', 'ON_HOLD', 'DROPPED', 'PLAN_TO_READ');

-- CreateEnum
CREATE TYPE "SourceStatus" AS ENUM ('UNCONFIGURED', 'NEEDS_PLUGIN', 'PENDING', 'RUNNING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "AutoSyncMode" AS ENUM ('INHERIT', 'DISABLED', 'CUSTOM');

-- CreateEnum
CREATE TYPE "JobKind" AS ENUM ('SOURCE_SYNC', 'SOURCE_VERIFY', 'OPTIMIZE', 'PDF_IMPORT', 'MANUAL_UPLOAD', 'PLUGIN_INSTALL', 'V1_IMPORT', 'INGEST_MANIFEST');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ChapterStatus" AS ENUM ('PENDING', 'DOWNLOADING', 'COMPLETED', 'FAILED', 'MISSING_FROM_SOURCE');

-- CreateEnum
CREATE TYPE "ChapterOrigin" AS ENUM ('PLUGIN', 'PDF', 'MANUAL');

-- CreateEnum
CREATE TYPE "PluginStatus" AS ENUM ('ENABLED', 'DISABLED', 'BROKEN');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('BOOK_CLUB_ADDED', 'SYNC_COMPLETED', 'SYNC_FAILED', 'NEW_CHAPTER', 'NOTE_REPLY', 'NOTE_MENTION', 'NEEDS_CREDENTIAL', 'PLUGIN_INSTALLED', 'PLUGIN_FAILED', 'IMPORT_COMPLETED');

-- CreateEnum
CREATE TYPE "InviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RegistrationMode" AS ENUM ('INVITE', 'OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "banned" BOOLEAN NOT NULL DEFAULT false,
    "ban_reason" TEXT,
    "ban_expires" TIMESTAMP(3),
    "display_name" TEXT NOT NULL,
    "show_adult" BOOLEAN NOT NULL DEFAULT false,
    "show_spoilers" BOOLEAN NOT NULL DEFAULT false,
    "optimizer_format" TEXT NOT NULL DEFAULT 'WEBP',
    "optimizer_quality" INTEGER NOT NULL DEFAULT 80,
    "must_set_password" BOOLEAN NOT NULL DEFAULT false,
    "reader_prefs" JSONB,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "user_id" TEXT NOT NULL,
    "impersonated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMP(3),
    "refresh_token_expires_at" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "email" TEXT,
    "role" TEXT NOT NULL DEFAULT 'member',
    "status" "InviteStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "redeemed_by_id" TEXT,
    "redeemed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "series" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "original_title" TEXT,
    "sort_title" TEXT NOT NULL,
    "synopsis" TEXT,
    "media_type" "MediaType" NOT NULL DEFAULT 'MANGA',
    "visibility" "Visibility" NOT NULL DEFAULT 'SHARED',
    "is_adult" BOOLEAN NOT NULL DEFAULT false,
    "is_book_club" BOOLEAN NOT NULL DEFAULT false,
    "publication_year" INTEGER,
    "total_chapters" INTEGER,
    "total_volumes" INTEGER,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source_url" TEXT,
    "cover_file" TEXT,
    "external_ids" JSONB NOT NULL DEFAULT '{}',
    "mal_id" INTEGER,
    "chapter_count" INTEGER NOT NULL DEFAULT 0,
    "last_chapter_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "search_vector" tsvector,

    CONSTRAINT "series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_entry" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "series_id" TEXT NOT NULL,
    "status" "ReadingStatus" NOT NULL DEFAULT 'PLAN_TO_READ',
    "current_chapter" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rating" INTEGER,
    "notes" TEXT,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "library_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source" (
    "id" TEXT NOT NULL,
    "series_id" TEXT NOT NULL,
    "plugin_id" TEXT,
    "normalized_url" TEXT,
    "slug" TEXT,
    "status" "SourceStatus" NOT NULL DEFAULT 'UNCONFIGURED',
    "config_json" JSONB NOT NULL DEFAULT '{}',
    "cookie_enc" BYTEA,
    "user_agent" TEXT,
    "cookie_updated_at" TIMESTAMP(3),
    "last_error" TEXT,
    "last_error_code" TEXT,
    "last_synced_at" TIMESTAMP(3),
    "auto_sync_mode" "AutoSyncMode" NOT NULL DEFAULT 'INHERIT',
    "auto_sync_interval_minutes" INTEGER,
    "auto_sync_requested_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapter" (
    "id" TEXT NOT NULL,
    "series_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "external_id" TEXT,
    "title" TEXT NOT NULL,
    "number" DOUBLE PRECISION,
    "volume" TEXT,
    "status" "ChapterStatus" NOT NULL DEFAULT 'PENDING',
    "origin" "ChapterOrigin" NOT NULL DEFAULT 'PLUGIN',
    "page_count" INTEGER NOT NULL DEFAULT 0,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "source_url" TEXT,
    "release_date" TIMESTAMP(3),
    "release_date_text" TEXT,
    "downloaded_at" TIMESTAMP(3),
    "last_error" TEXT,
    "sort_index" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chapter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page" (
    "id" TEXT NOT NULL,
    "chapter_id" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "file" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "sha256" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "mime" TEXT,
    "source_url" TEXT,

    CONSTRAINT "page_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapter_read" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "series_id" TEXT NOT NULL,
    "chapter_id" TEXT NOT NULL,
    "read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chapter_read_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reading_position" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "series_id" TEXT NOT NULL,
    "chapter_id" TEXT,
    "page_index" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reading_position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "series_id" TEXT NOT NULL,
    "chapter_id" TEXT,
    "page_index" INTEGER,
    "pin_x" DOUBLE PRECISION,
    "pin_y" DOUBLE PRECISION,
    "body" TEXT NOT NULL,
    "parent_id" TEXT,
    "is_spoiler" BOOLEAN NOT NULL DEFAULT false,
    "edited_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job" (
    "id" TEXT NOT NULL,
    "kind" "JobKind" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "source_id" TEXT,
    "series_id" TEXT,
    "plugin_id" TEXT,
    "requested_by_id" TEXT,
    "config_json" JSONB NOT NULL DEFAULT '{}',
    "progress_json" JSONB NOT NULL DEFAULT '{}',
    "result_json" JSONB,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "pid" INTEGER,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "heartbeat_at" TIMESTAMP(3),
    "output_log" TEXT,
    "error" TEXT,
    "error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plugin" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sdk_range" TEXT NOT NULL,
    "entry" TEXT NOT NULL,
    "dir" TEXT NOT NULL,
    "hosts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "media_types" "MediaType"[] DEFAULT ARRAY[]::"MediaType"[],
    "adult" BOOLEAN NOT NULL DEFAULT false,
    "homepage" TEXT,
    "license" TEXT,
    "min_kiri_version" TEXT,
    "install_source" TEXT,
    "descriptor_hash" TEXT NOT NULL,
    "status" "PluginStatus" NOT NULL DEFAULT 'ENABLED',
    "last_error" TEXT,
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plugin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plugin_credential" (
    "id" TEXT NOT NULL,
    "plugin_id" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "cookie_enc" BYTEA,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plugin_credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "link" TEXT,
    "series_id" TEXT,
    "note_id" TEXT,
    "job_id" TEXT,
    "dedupe_key" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_setting" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "instance_name" TEXT NOT NULL DEFAULT 'Kiri',
    "registration_mode" "RegistrationMode" NOT NULL DEFAULT 'INVITE',
    "auto_sync_enabled" BOOLEAN NOT NULL DEFAULT false,
    "auto_sync_interval_minutes" INTEGER NOT NULL DEFAULT 1440,
    "verbose_plugin_logging" BOOLEAN NOT NULL DEFAULT false,
    "notification_retention_days" INTEGER NOT NULL DEFAULT 90,
    "job_log_retention_days" INTEGER NOT NULL DEFAULT 30,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_mapping" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "v1_table" TEXT NOT NULL,
    "v1_id" TEXT NOT NULL,
    "v2_model" TEXT NOT NULL,
    "v2_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "user_role_idx" ON "user"("role");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "session_user_id_idx" ON "session"("user_id");

-- CreateIndex
CREATE INDEX "session_expires_at_idx" ON "session"("expires_at");

-- CreateIndex
CREATE INDEX "account_user_id_idx" ON "account"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_provider_account_key" ON "account"("provider_id", "account_id");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE INDEX "verification_expires_at_idx" ON "verification"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "invite_token_hash_key" ON "invite"("token_hash");

-- CreateIndex
CREATE INDEX "invite_status_expires_idx" ON "invite"("status", "expires_at");

-- CreateIndex
CREATE INDEX "invite_created_by_idx" ON "invite"("created_by_id");

-- CreateIndex
CREATE INDEX "series_created_by_idx" ON "series"("created_by_id");

-- CreateIndex
CREATE INDEX "series_browse_idx" ON "series"("visibility", "is_adult", "sort_title");

-- CreateIndex
CREATE INDEX "series_media_type_idx" ON "series"("media_type");

-- CreateIndex
CREATE INDEX "series_book_club_idx" ON "series"("is_book_club");

-- CreateIndex
CREATE INDEX "series_mal_id_idx" ON "series"("mal_id");

-- CreateIndex
CREATE INDEX "series_updated_at_idx" ON "series"("updated_at");

-- CreateIndex
CREATE INDEX "series_search_gin_idx" ON "series" USING GIN ("search_vector");

-- CreateIndex
CREATE INDEX "series_tags_gin_idx" ON "series" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "library_series_idx" ON "library_entry"("series_id");

-- CreateIndex
CREATE INDEX "library_user_status_idx" ON "library_entry"("user_id", "status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "library_user_series_key" ON "library_entry"("user_id", "series_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_series_id_key" ON "source"("series_id");

-- CreateIndex
CREATE INDEX "source_plugin_idx" ON "source"("plugin_id");

-- CreateIndex
CREATE INDEX "source_autosync_idx" ON "source"("status", "auto_sync_mode", "last_synced_at");

-- CreateIndex
CREATE INDEX "chapter_series_order_idx" ON "chapter"("series_id", "sort_index");

-- CreateIndex
CREATE INDEX "chapter_series_status_idx" ON "chapter"("series_id", "status");

-- CreateIndex
CREATE INDEX "chapter_series_external_idx" ON "chapter"("series_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "chapter_series_slug_key" ON "chapter"("series_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "page_chapter_index_key" ON "page"("chapter_id", "index");

-- CreateIndex
CREATE INDEX "chapter_read_user_series_idx" ON "chapter_read"("user_id", "series_id");

-- CreateIndex
CREATE INDEX "chapter_read_series_chapter_idx" ON "chapter_read"("series_id", "chapter_id");

-- CreateIndex
CREATE UNIQUE INDEX "chapter_read_user_chapter_key" ON "chapter_read"("user_id", "chapter_id");

-- CreateIndex
CREATE INDEX "reading_position_series_idx" ON "reading_position"("series_id");

-- CreateIndex
CREATE INDEX "reading_position_recent_idx" ON "reading_position"("user_id", "updated_at");

-- CreateIndex
CREATE INDEX "reading_position_chapter_idx" ON "reading_position"("chapter_id");

-- CreateIndex
CREATE UNIQUE INDEX "reading_position_user_series_key" ON "reading_position"("user_id", "series_id");

-- CreateIndex
CREATE INDEX "note_anchor_idx" ON "note"("chapter_id", "page_index", "created_at");

-- CreateIndex
CREATE INDEX "note_series_recent_idx" ON "note"("series_id", "created_at");

-- CreateIndex
CREATE INDEX "note_thread_idx" ON "note"("parent_id");

-- CreateIndex
CREATE INDEX "note_author_idx" ON "note"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "job_queue_idx" ON "job"("status", "created_at");

-- CreateIndex
CREATE INDEX "job_source_status_idx" ON "job"("source_id", "status");

-- CreateIndex
CREATE INDEX "job_stale_idx" ON "job"("status", "heartbeat_at");

-- CreateIndex
CREATE INDEX "job_series_history_idx" ON "job"("series_id", "created_at");

-- CreateIndex
CREATE INDEX "plugin_status_idx" ON "plugin"("status");

-- CreateIndex
CREATE INDEX "plugin_hosts_gin_idx" ON "plugin" USING GIN ("hosts");

-- CreateIndex
CREATE INDEX "plugin_credential_host_idx" ON "plugin_credential"("host");

-- CreateIndex
CREATE UNIQUE INDEX "plugin_credential_plugin_host_key" ON "plugin_credential"("plugin_id", "host");

-- CreateIndex
CREATE INDEX "notification_user_recent_idx" ON "notification"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "notification_user_unread_idx" ON "notification"("user_id", "read_at", "created_at");

-- CreateIndex
CREATE INDEX "notification_series_idx" ON "notification"("series_id");

-- CreateIndex
CREATE INDEX "notification_retention_idx" ON "notification"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_dedupe_key" ON "notification"("user_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "audit_log_created_at_idx" ON "audit_log"("created_at");

-- CreateIndex
CREATE INDEX "audit_log_actor_idx" ON "audit_log"("actor_id");

-- CreateIndex
CREATE INDEX "audit_log_target_idx" ON "audit_log"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "import_mapping_run_idx" ON "import_mapping"("run_id");

-- CreateIndex
CREATE INDEX "import_mapping_target_idx" ON "import_mapping"("v2_model", "v2_id");

-- CreateIndex
CREATE UNIQUE INDEX "import_mapping_source_key" ON "import_mapping"("v1_table", "v1_id");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite" ADD CONSTRAINT "invite_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite" ADD CONSTRAINT "invite_redeemed_by_id_fkey" FOREIGN KEY ("redeemed_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "series" ADD CONSTRAINT "series_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_entry" ADD CONSTRAINT "library_entry_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_entry" ADD CONSTRAINT "library_entry_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source" ADD CONSTRAINT "source_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source" ADD CONSTRAINT "source_plugin_id_fkey" FOREIGN KEY ("plugin_id") REFERENCES "plugin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapter" ADD CONSTRAINT "chapter_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page" ADD CONSTRAINT "page_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapter_read" ADD CONSTRAINT "chapter_read_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapter_read" ADD CONSTRAINT "chapter_read_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapter_read" ADD CONSTRAINT "chapter_read_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reading_position" ADD CONSTRAINT "reading_position_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reading_position" ADD CONSTRAINT "reading_position_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reading_position" ADD CONSTRAINT "reading_position_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note" ADD CONSTRAINT "note_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note" ADD CONSTRAINT "note_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note" ADD CONSTRAINT "note_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note" ADD CONSTRAINT "note_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plugin_credential" ADD CONSTRAINT "plugin_credential_plugin_id_fkey" FOREIGN KEY ("plugin_id") REFERENCES "plugin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "series"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Full-text search vector for series, maintained by trigger. Prisma models the
-- column as Unsupported("tsvector"); a GENERATED column would be reported as
-- drift by `prisma migrate dev`, a trigger is invisible to it.
CREATE OR REPLACE FUNCTION series_search_vector_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."search_vector" :=
    setweight(to_tsvector('simple', coalesce(NEW."title", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW."original_title", '')), 'B') ||
    setweight(to_tsvector('simple', array_to_string(coalesce(NEW."tags", '{}'), ' ')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW."synopsis", '')), 'C');
  RETURN NEW;
END
$$;

CREATE TRIGGER series_search_vector_trigger
BEFORE INSERT OR UPDATE OF "title", "original_title", "synopsis", "tags" ON "series"
FOR EACH ROW EXECUTE FUNCTION series_search_vector_update();
