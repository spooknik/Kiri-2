-- Kiri 1.x database schema, for tests only.
--
-- GENERATED ONCE by concatenating, in order, every migration in
--   <kiri-1.x checkout>/prisma/migrations/*/migration.sql
-- (0001_init … 0017_add_rip_cookie_updated_at). Do not hand-edit: regenerate
-- from that directory if V1 ever gains another migration.
--
-- Two things Prisma's CLI does around the migration files are reproduced here
-- so the result is byte-for-byte what `prisma migrate deploy` leaves behind:
--   1. the `_prisma_migrations` bookkeeping table (created by the CLI, not by
--      any migration) — migration 0015 DELETEs from it, so it must exist;
--   2. one applied row per migration at the end, which is what the importer's
--      preflight checks for ("0017_add_rip_cookie_updated_at applied").
--
-- Used by src/lib/import-v1/importer.int.test.ts, which creates a throwaway
-- `kiri_v1_test` database on the embedded test cluster and applies this file.

CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                    VARCHAR(36) PRIMARY KEY NOT NULL,
    "checksum"              VARCHAR(64) NOT NULL,
    "finished_at"           TIMESTAMPTZ,
    "migration_name"        VARCHAR(255) NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        TIMESTAMPTZ,
    "started_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count"   INTEGER NOT NULL DEFAULT 0
);

-- ===========================================================================
-- 0001_init/migration.sql
-- ===========================================================================
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('MANGA', 'MANHWA', 'MANHUA', 'LIGHT_NOVEL', 'BOOK');

-- CreateEnum
CREATE TYPE "ReadingStatus" AS ENUM ('READING', 'COMPLETED', 'ON_HOLD', 'DROPPED', 'PLAN_TO_READ');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "series" (
    "id" TEXT NOT NULL,
    "mal_id" INTEGER,
    "title" TEXT NOT NULL,
    "image_url" TEXT,
    "synopsis" TEXT,
    "media_type" "MediaType" NOT NULL DEFAULT 'MANGA',
    "total_chapters" INTEGER,
    "total_volumes" INTEGER,
    "link" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_series" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "series_id" TEXT NOT NULL,
    "status" "ReadingStatus" NOT NULL DEFAULT 'PLAN_TO_READ',
    "current_chapter" INTEGER NOT NULL DEFAULT 0,
    "rating" INTEGER,
    "notes" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_series_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "series_mal_id_key" ON "series"("mal_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_series_user_id_series_id_key" ON "user_series"("user_id", "series_id");

-- AddForeignKey
ALTER TABLE "series" ADD CONSTRAINT "series_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_series" ADD CONSTRAINT "user_series_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_series" ADD CONSTRAINT "user_series_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "series"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- 0002_reader_and_rips/migration.sql
-- ===========================================================================
-- CreateEnum
CREATE TYPE "RipStatus" AS ENUM ('UNSUPPORTED', 'PENDING', 'RUNNING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "RipJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "RipJobKind" AS ENUM ('SYNC', 'VERIFY');

-- CreateTable
CREATE TABLE "series_rips" (
    "id" TEXT NOT NULL,
    "series_id" TEXT NOT NULL,
    "site" TEXT,
    "normalized_url" TEXT,
    "output_dir" TEXT,
    "manifest_path" TEXT,
    "status" "RipStatus" NOT NULL DEFAULT 'UNSUPPORTED',
    "last_error" TEXT,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "series_rips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rip_jobs" (
    "id" TEXT NOT NULL,
    "series_rip_id" TEXT NOT NULL,
    "kind" "RipJobKind" NOT NULL DEFAULT 'SYNC',
    "status" "RipJobStatus" NOT NULL DEFAULT 'QUEUED',
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "output_log" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rip_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reader_progress" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "series_id" TEXT NOT NULL,
    "chapter_slug" TEXT,
    "page_index" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reader_progress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "series_rips_series_id_key" ON "series_rips"("series_id");

-- CreateIndex
CREATE INDEX "rip_jobs_status_created_at_idx" ON "rip_jobs"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "reader_progress_user_id_series_id_key" ON "reader_progress"("user_id", "series_id");

-- AddForeignKey
ALTER TABLE "series_rips" ADD CONSTRAINT "series_rips_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rip_jobs" ADD CONSTRAINT "rip_jobs_series_rip_id_fkey" FOREIGN KEY ("series_rip_id") REFERENCES "series_rips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reader_progress" ADD CONSTRAINT "reader_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reader_progress" ADD CONSTRAINT "reader_progress_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- 0003_media_type_to_string/migration.sql
-- ===========================================================================
-- AlterTable: Convert media_type from enum to text
ALTER TABLE "series" ALTER COLUMN "media_type" SET DATA TYPE TEXT USING "media_type"::TEXT;
ALTER TABLE "series" ALTER COLUMN "media_type" SET DEFAULT 'MANGA';

-- DropEnum
DROP TYPE "MediaType";

-- ===========================================================================
-- 0004_add_is_adult/migration.sql
-- ===========================================================================
-- AlterTable: Add is_adult column to series
ALTER TABLE "series" ADD COLUMN "is_adult" BOOLEAN NOT NULL DEFAULT false;

-- ===========================================================================
-- 0005_add_rip_cookie/migration.sql
-- ===========================================================================
-- AlterTable
ALTER TABLE "series_rips" ADD COLUMN "cookie" TEXT;

-- ===========================================================================
-- 0006_add_rip_user_agent/migration.sql
-- ===========================================================================
-- AlterTable
ALTER TABLE "series_rips" ADD COLUMN "user_agent" TEXT;

-- ===========================================================================
-- 0007_add_series_metadata_fields/migration.sql
-- ===========================================================================
-- AlterTable: add optional metadata fields for series
ALTER TABLE "series" ADD COLUMN "original_title" TEXT;
ALTER TABLE "series" ADD COLUMN "publication_year" INTEGER;
ALTER TABLE "series" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- ===========================================================================
-- 0008_add_is_book_club/migration.sql
-- ===========================================================================
-- AlterTable: Add is_book_club column to series
ALTER TABLE "series" ADD COLUMN "is_book_club" BOOLEAN NOT NULL DEFAULT false;

-- ===========================================================================
-- 0009_add_notifications/migration.sql
-- ===========================================================================
-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('BOOK_CLUB_ADDED', 'RIP_COMPLETED', 'RIP_FAILED', 'NEW_CHAPTER');

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "link" TEXT,
    "series_id" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_created_at_idx" ON "notifications"("user_id", "read_at", "created_at");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "series"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- 0010_add_media_optimizer/migration.sql
-- ===========================================================================
-- AlterEnum
ALTER TYPE "RipJobKind" ADD VALUE 'OPTIMIZE';

-- AlterTable
ALTER TABLE "users"
ADD COLUMN "optimizer_format" TEXT NOT NULL DEFAULT 'WEBP',
ADD COLUMN "optimizer_quality" INTEGER NOT NULL DEFAULT 80;

-- AlterTable
ALTER TABLE "rip_jobs"
ADD COLUMN "config_json" TEXT;

-- ===========================================================================
-- 0011_add_pdf_import_job_kind/migration.sql
-- ===========================================================================
-- AlterEnum
ALTER TYPE "RipJobKind" ADD VALUE 'PDF_IMPORT';

-- ===========================================================================
-- 0012_add_rip_job_cancelled_status/migration.sql
-- ===========================================================================
-- AlterEnum
ALTER TYPE "RipJobStatus" ADD VALUE 'CANCELLED';

-- ===========================================================================
-- 0013_add_auto_sync/migration.sql
-- ===========================================================================
-- CreateEnum
CREATE TYPE "AutoSyncMode" AS ENUM ('INHERIT', 'DISABLED', 'CUSTOM');

-- AlterTable
ALTER TABLE "series_rips"
ADD COLUMN "auto_sync_mode" "AutoSyncMode" NOT NULL DEFAULT 'INHERIT',
ADD COLUMN "auto_sync_interval_minutes" INTEGER,
ADD COLUMN "auto_sync_requested_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "app_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "auto_sync_enabled" BOOLEAN NOT NULL DEFAULT false,
    "auto_sync_interval_minutes" INTEGER NOT NULL DEFAULT 1440,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id")
);

-- ===========================================================================
-- 0014_add_verbose_rip_logging/migration.sql
-- ===========================================================================
-- AlterTable
ALTER TABLE "app_settings"
ADD COLUMN "verbose_rip_logging" BOOLEAN NOT NULL DEFAULT false;

-- ===========================================================================
-- 0015_drop_site_credentials/migration.sql
-- ===========================================================================
-- The `site_credentials` feature was reverted from the codebase (reset to
-- commit 6874d1d), but its table and migration record were left applied in
-- existing databases. Drop both so the database matches the current schema.
-- All statements are idempotent / no-ops on databases that never had it
-- (e.g. fresh installs), so this migration is safe everywhere.

DROP TABLE IF EXISTS "site_credentials";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0014_add_site_credentials';

-- ===========================================================================
-- 0016_add_site_credentials/migration.sql
-- ===========================================================================
-- CreateTable
CREATE TABLE "site_credentials" (
    "id" TEXT NOT NULL,
    "site" TEXT NOT NULL,
    "cookie" TEXT,
    "user_agent" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "site_credentials_site_key" ON "site_credentials"("site");

-- ===========================================================================
-- 0017_add_rip_cookie_updated_at/migration.sql
-- ===========================================================================
-- AlterTable
ALTER TABLE "series_rips" ADD COLUMN "cookie_updated_at" TIMESTAMP(3);

-- ===========================================================================
-- Applied-migration bookkeeping (written by the Prisma CLI, not by a migration)
-- ===========================================================================
INSERT INTO "_prisma_migrations"
  ("id", "checksum", "migration_name", "finished_at", "applied_steps_count")
VALUES
  (gen_random_uuid()::text, 'fixture', '0001_init', now(), 1),
  (gen_random_uuid()::text, 'fixture', '0002_reader_and_rips', now(), 1),
  (gen_random_uuid()::text, 'fixture', '0003_media_type_to_string', now(), 1),
  (gen_random_uuid()::text, 'fixture', '0004_add_is_adult', now(), 1),
  (gen_random_uuid()::text, 'fixture', '0005_add_rip_cookie', now(), 1),
  (gen_random_uuid()::text, 'fixture', '0006_add_rip_user_agent', now(), 1),
  (gen_random_uuid()::text, 'fixture', '0007_add_series_metadata_fields', now(), 1),
  (gen_random_uuid()::text, 'fixture', '0008_add_is_book_club', now(), 1),
  (gen_random_uuid()::text, 'fixture', '0009_add_notifications', now(), 1),
  (gen_random_uuid()::text, 'fixture', '0010_add_media_optimizer', now(), 1),
  (gen_random_uuid()::text, 'fixture', '0011_add_pdf_import_job_kind', now(), 1),
  (gen_random_uuid()::text, 'fixture', '0012_add_rip_job_cancelled_status', now(), 1),
  (gen_random_uuid()::text, 'fixture', '0013_add_auto_sync', now(), 1),
  (gen_random_uuid()::text, 'fixture', '0014_add_verbose_rip_logging', now(), 1),
  (gen_random_uuid()::text, 'fixture', '0015_drop_site_credentials', now(), 1),
  (gen_random_uuid()::text, 'fixture', '0016_add_site_credentials', now(), 1),
  (gen_random_uuid()::text, 'fixture', '0017_add_rip_cookie_updated_at', now(), 1);
