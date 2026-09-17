/**
 * The V1 importer against a real Kiri 1.x database and a real data directory.
 *
 * A second database (`kiri_v1_test`) is created on the same embedded cluster
 * the V2 integration tests use and loaded with `test/fixtures/v1-schema.sql`
 * (the concatenated 1.x migrations). It is then seeded with raw SQL — no
 * generated client for V1 exists, and using one would hide exactly the column
 * names this importer has to get right.
 *
 * The four cases mirror how the import is actually used: dry run, real run,
 * re-run (idempotence), and `--link` into a second data root.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetDatabase } from "../../../test/factories";
import { libraryDir } from "@/lib/content/store";
import { decryptSecret } from "@/lib/crypto";
import { resetEnvCache } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { runV1Import } from "./importer";
import type { V1ImportReport } from "@/lib/contracts/import-v1";

const V1_DATABASE = "kiri_v1_test";
const FIXTURE = path.resolve(__dirname, "../../../test/fixtures/v1-schema.sql");

let v1Url = "";
let v1DataDir = "";
let dataRoot = "";
let linkDataRoot = "";

/* -------------------------------------------------------------------------- */
/* Cluster helpers                                                            */
/* -------------------------------------------------------------------------- */

function replaceDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * Split the fixture into single statements. `ALTER TYPE … ADD VALUE` may not
 * run inside a transaction block, and pg wraps a multi-statement simple query
 * in one, so the file has to be fed in one statement at a time.
 */
function splitStatements(sql: string): string[] {
  return sql
    .split("\n")
    .map((line) => (line.trimStart().startsWith("--") ? "" : line))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function withClient<T>(url: string, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/* -------------------------------------------------------------------------- */
/* V1 seed                                                                    */
/* -------------------------------------------------------------------------- */

const NOW = Date.now();
const daysAgo = (n: number): Date => new Date(NOW - n * 24 * 60 * 60 * 1000);

/** Ids are plain text in V1 (the column has no default), so they can be readable. */
const V1 = {
  alice: "u-alice",
  bob: "u-bob",
  carol: "u-carol",
  solo: "s-solo",
  manual: "s-manual",
  pdf: "s-pdf",
  ripped: "s-ripped",
  adult: "s-adult",
} as const;

async function seedV1(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO "users" ("id", "email", "display_name", "optimizer_format", "optimizer_quality", "created_at")
     VALUES ($1,'alice@example.com','Alice','WEBP',80,$4),
            ($2,'BOB@Example.com ','Bob','AVIF',70,$5),
            ($3,'carol@example.com','Carol','WEBP',60,$6)`,
    [V1.alice, V1.bob, V1.carol, daysAgo(400), daysAgo(300), daysAgo(200)],
  );

  await client.query(
    `INSERT INTO "series"
       ("id","mal_id","title","original_title","publication_year","tags","image_url","synopsis",
        "media_type","is_adult","is_book_club","total_chapters","total_volumes","link",
        "created_by_id","created_at")
     VALUES
       ($1, 121496, 'Solo Leveling', '나 혼자만 레벨업', 2018, ARRAY['action','fantasy'],
        '/api/series/s-solo/cover', 'A weak hunter gets stronger.', 'MANHWA', false, false,
        179, 14, 'https://example.test/solo', $6, $7),
       ($2, NULL, 'Manual Uploads', NULL, NULL, ARRAY[]::TEXT[], NULL, NULL,
        'Doujinshi', false, false, NULL, NULL, NULL, $6, $7),
       ($3, NULL, 'PDF Book', NULL, 1999, ARRAY['scanned'], NULL, NULL,
        'BOOK', false, false, NULL, NULL, NULL, $6, $7),
       ($4, NULL, 'Ripped Series', NULL, NULL, ARRAY[]::TEXT[], 'https://cdn.example.test/c.jpg',
        NULL, 'MANGA', false, false, NULL, NULL, 'https://mangadex.test/title/x', $6, $7),
       ($5, NULL, 'Adult Club', NULL, NULL, ARRAY['mature'], NULL, NULL,
        'MANHUA', true, true, NULL, NULL, NULL, $8, $7)`,
    [V1.solo, V1.manual, V1.pdf, V1.ripped, V1.adult, V1.alice, daysAgo(100), V1.bob],
  );

  await client.query(
    `INSERT INTO "user_series"
       ("id","user_id","series_id","status","current_chapter","rating","notes","updated_at","joined_at")
     VALUES ('us-1',$1,$4,'READING',12,8,'great',$7,$7),
            ('us-2',$2,$4,'PLAN_TO_READ',0,NULL,NULL,$7,$7),
            ('us-3',$1,$5,'READING',3,NULL,NULL,$7,$7),
            ('us-4',$3,$6,'COMPLETED',40,10,NULL,$7,$7)`,
    [V1.alice, V1.bob, V1.carol, V1.solo, V1.ripped, V1.adult, daysAgo(10)],
  );

  await client.query(
    `INSERT INTO "series_rips"
       ("id","series_id","site","normalized_url","output_dir","manifest_path","status","cookie",
        "user_agent","cookie_updated_at","last_error","last_synced_at","auto_sync_mode",
        "auto_sync_interval_minutes","auto_sync_requested_at","created_at","updated_at")
     VALUES
       ('rip-manual',$1,'manual',NULL,'/srv/kiri/data/rips/manual/s-manual',
        '/srv/kiri/data/rips/manual/s-manual/manifest.json','READY',NULL,NULL,NULL,NULL,$5,
        'INHERIT',NULL,NULL,$5,$5),
       ('rip-pdf',$2,'pdf',NULL,'/srv/kiri/data/rips/pdf/s-pdf',
        '/srv/kiri/data/rips/pdf/s-pdf/manifest.json','READY',NULL,NULL,NULL,NULL,$5,
        'DISABLED',NULL,NULL,$5,$5),
       ('rip-mangadex',$3,'mangadex','https://mangadex.test/title/x',
        '/srv/kiri/data/rips/mangadex/ripped-series',
        '/srv/kiri/data/rips/mangadex/ripped-series/manifest.json','READY',
        'cf_clearance=fresh-value; __cf_bm=volatile','UA/fresh',$6,NULL,$5,'CUSTOM',720,NULL,$5,$5),
       ('rip-adult',$4,'mangadex','https://mangadex.test/title/y',
        '/srv/kiri/data/rips/mangadex/adult-club',
        '/srv/kiri/data/rips/mangadex/adult-club/manifest.json','FAILED',
        'cf_clearance=stale-value','UA/stale',$7,'Cloudflare challenge',NULL,'INHERIT',NULL,NULL,$5,$5)`,
    [V1.manual, V1.pdf, V1.ripped, V1.adult, daysAgo(5), daysAgo(1), daysAgo(40)],
  );

  await client.query(
    `INSERT INTO "rip_jobs"
       ("id","series_rip_id","kind","status","config_json","started_at","finished_at","output_log",
        "error","created_at","updated_at")
     VALUES ('job-1','rip-mangadex','SYNC','SUCCEEDED',NULL,$1,$1,'lots of noisy log output',NULL,$1,$1),
            ('job-2','rip-adult','SYNC','FAILED',NULL,$1,$1,'more noise','Cloudflare challenge',$1,$1),
            ('job-3','rip-mangadex','VERIFY','QUEUED',NULL,NULL,NULL,NULL,NULL,$1,$1)`,
    [daysAgo(5)],
  );

  await client.query(
    `INSERT INTO "reader_progress"
       ("id","user_id","series_id","chapter_slug","page_index","updated_at","created_at")
     VALUES ('rp-1',$1,$3,'chapter-1',3,$5,$5),
            ('rp-2',$2,$3,'chapter-999',0,$5,$5),
            ('rp-3',$1,$4,'manual-1',1,$5,$5)`,
    [V1.alice, V1.bob, V1.ripped, V1.manual, daysAgo(3)],
  );

  await client.query(
    `INSERT INTO "notifications"
       ("id","user_id","type","title","message","link","series_id","read_at","created_at")
     VALUES ('n-fresh',$1,'RIP_COMPLETED','Sync finished','Ripped Series is ready',
             '/series/' || $3, $3, NULL, $5),
            ('n-read',$2,'NEW_CHAPTER','New chapter','Chapter 12 is out','/series/' || $3, $3, $5, $5),
            ('n-old',$2,'RIP_FAILED','Sync failed','It broke','/series/' || $3, $3, NULL, $6),
            ('n-club',$1,'BOOK_CLUB_ADDED','Added to book club','Adult Club', NULL, $4, NULL, $5)`,
    [V1.alice, V1.bob, V1.ripped, V1.adult, daysAgo(2), daysAgo(60)],
  );

  await client.query(
    `INSERT INTO "app_settings"
       ("id","auto_sync_enabled","auto_sync_interval_minutes","verbose_rip_logging","updated_at")
     VALUES ('global', true, 720, true, $1)`,
    [daysAgo(1)],
  );

  await client.query(
    `INSERT INTO "site_credentials" ("id","site","cookie","user_agent","updated_at","created_at")
     VALUES ('cred-1','mangadex','cf_clearance=site-value','UA/site',$1,$1)`,
    [daysAgo(1)],
  );
}

/* -------------------------------------------------------------------------- */
/* V1 data directory                                                          */
/* -------------------------------------------------------------------------- */

interface ManifestChapterSpec {
  slug: string;
  title: string;
  images: number;
  source?: string;
  chapterOrder?: number;
}

async function tinyPng(seed: number): Promise<Buffer> {
  return sharp({
    create: { width: 4 + seed, height: 6, channels: 3, background: { r: seed * 20, g: 30, b: 40 } },
  })
    .png()
    .toBuffer();
}

async function writeRip(
  root: string,
  site: string,
  slug: string,
  title: string,
  chapters: ManifestChapterSpec[],
): Promise<string> {
  const dir = path.join(root, "rips", site, slug);
  await mkdir(dir, { recursive: true });
  const manifestChapters = [];
  for (const [position, chapter] of chapters.entries()) {
    const chapterDirectory = path.join(dir, chapter.slug);
    await mkdir(chapterDirectory, { recursive: true });
    const images = [];
    for (let index = 1; index <= chapter.images; index += 1) {
      const png = await tinyPng(index + position);
      const file = `${String(index).padStart(3, "0")}.png`;
      await writeFile(path.join(chapterDirectory, file), png);
      images.push({ index, file, bytes: png.byteLength, url: `https://cdn.test/${file}` });
    }
    manifestChapters.push({
      slug: chapter.slug,
      title: chapter.title,
      status: "completed",
      chapterOrder: chapter.chapterOrder ?? position + 1,
      images,
      ...(chapter.source ? { source: chapter.source } : {}),
    });
  }
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        site,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        series: { title, slug },
        chapters: manifestChapters,
      },
      null,
      2,
    ),
  );
  return dir;
}

async function buildV1DataDir(root: string): Promise<void> {
  // Local cover for the mal_id series.
  const coverDir = path.join(root, "covers", V1.solo);
  await mkdir(coverDir, { recursive: true });
  const jpeg = await sharp({
    create: { width: 60, height: 90, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .jpeg()
    .toBuffer();
  await writeFile(path.join(coverDir, "cover.jpg"), jpeg);

  await writeRip(root, "manual", V1.manual, "Manual Uploads", [
    { slug: "manual-1", title: "Uploaded chapter", images: 2, source: "manual" },
  ]);
  await writeRip(root, "pdf", V1.pdf, "PDF Book", [
    { slug: "pdf-1", title: "Scanned book", images: 1, source: "pdf" },
  ]);
  await writeRip(root, "mangadex", "ripped-series", "Ripped Series", [
    { slug: "chapter-1", title: "Chapter 1", images: 2 },
    { slug: "chapter-2", title: "Chapter 2", images: 1 },
  ]);
  // A rip directory that lost its manifest.
  await mkdir(path.join(root, "rips", "mangadex", "adult-club"), { recursive: true });
}

/* -------------------------------------------------------------------------- */
/* Setup                                                                      */
/* -------------------------------------------------------------------------- */

beforeAll(async () => {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) throw new Error("TEST_DATABASE_URL is not set (test/global-setup.ts)");

  dataRoot = mkdtempSync(path.join(tmpdir(), "kiri-v2-import-"));
  linkDataRoot = mkdtempSync(path.join(tmpdir(), "kiri-v2-link-"));
  v1DataDir = mkdtempSync(path.join(tmpdir(), "kiri-v1-data-"));
  process.env.DATA_ROOT = dataRoot;
  resetEnvCache();

  const adminUrl = replaceDatabase(testUrl, "postgres");
  await withClient(adminUrl, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS "${V1_DATABASE}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${V1_DATABASE}"`);
  });

  v1Url = replaceDatabase(testUrl, V1_DATABASE);
  const schema = await readFile(FIXTURE, "utf8");
  await withClient(v1Url, async (client) => {
    for (const statement of splitStatements(schema)) {
      await client.query(statement);
    }
    await seedV1(client);
  });

  await buildV1DataDir(v1DataDir);
  await resetDatabase();
}, 180_000);

afterAll(async () => {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (testUrl) {
    await withClient(replaceDatabase(testUrl, "postgres"), async (client) => {
      await client.query(`DROP DATABASE IF EXISTS "${V1_DATABASE}" WITH (FORCE)`);
    }).catch(() => {});
  }
  for (const dir of [dataRoot, linkDataRoot, v1DataDir]) {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may still hold a handle on a just-closed file; a leftover
        // temp dir is not worth failing the suite over.
      }
    }
  }
}, 60_000);

function importOptions(overrides: Partial<Parameters<typeof runV1Import>[0]> = {}) {
  return {
    databaseUrl: v1Url,
    dataDir: v1DataDir,
    mode: "copy" as const,
    dryRun: false,
    importJobs: "skip" as const,
    requestedById: null,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("runV1Import", () => {
  let dry: V1ImportReport;
  let real: V1ImportReport;

  it("dry run predicts the import and writes nothing", async () => {
    dry = await runV1Import(importOptions({ dryRun: true }));

    expect(dry.dryRun).toBe(true);
    expect(dry.counts.users).toMatchObject({ read: 3, created: 3 });
    expect(dry.counts.series).toMatchObject({ read: 5, created: 5 });
    expect(dry.counts.libraryEntries).toMatchObject({ read: 4, created: 4 });
    // manual + pdf produce no Source; the two mangadex rips do.
    expect(dry.counts.sources).toMatchObject({ read: 4, created: 2, skipped: 2 });
    expect(dry.counts.chapters.created).toBe(4);
    expect(dry.counts.pages.created).toBe(6);
    expect(dry.content).toMatchObject({ sources: 4, manifestsMissing: 1 });
    expect(dry.content.bytes).toBeGreaterThan(0);
    expect(dry.needsPlugin).toEqual([{ site: "mangadex", seriesCount: 2 }]);
    expect(dry.invites).toHaveLength(3);
    expect(dry.invites.every((invite) => invite.url.startsWith("(dry run"))).toBe(true);

    // Nothing was written: no rows, no invites, no files.
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.series.count()).toBe(0);
    expect(await prisma.invite.count()).toBe(0);
    expect(await prisma.importMapping.count()).toBe(0);
    await expect(lstat(path.join(dataRoot, "library"))).rejects.toThrow();
  }, 120_000);

  it("real run imports users, invites and the admin choice", async () => {
    real = await runV1Import(importOptions());

    expect(real.dryRun).toBe(false);
    const users = await prisma.user.findMany({ orderBy: { email: "asc" } });
    expect(users.map((user) => user.email)).toEqual([
      "alice@example.com",
      "bob@example.com",
      "carol@example.com",
    ]);
    for (const user of users) {
      expect(user.mustSetPassword).toBe(true);
      expect(user.emailVerified).toBe(false);
      expect(user.name).toBe(user.displayName);
    }
    // Alice created four of the five series, so she becomes the admin.
    const alice = users.find((user) => user.email === "alice@example.com");
    expect(alice?.role).toBe("admin");
    expect(alice?.displayName).toBe("Alice");
    expect(users.filter((user) => user.role === "member")).toHaveLength(2);

    const bob = users.find((user) => user.email === "bob@example.com");
    expect(bob?.optimizerFormat).toBe("AVIF");
    expect(bob?.optimizerQuality).toBe(70);

    // V1 has no passwords, so no credential rows travel across.
    expect(await prisma.account.count()).toBe(0);

    const invites = await prisma.invite.findMany();
    expect(invites).toHaveLength(3);
    expect(invites.every((invite) => invite.email !== null)).toBe(true);
    expect(real.invites.every((invite) => invite.url.includes("/register?invite="))).toBe(true);
    const expiry = new Date(real.invites[0]?.expiresAt ?? 0).getTime() - Date.now();
    expect(expiry).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
  }, 180_000);

  it("maps every series field", async () => {
    const solo = await prisma.series.findFirstOrThrow({ where: { title: "Solo Leveling" } });
    expect(solo.malId).toBe(121496);
    expect(solo.mediaType).toBe("MANHWA");
    expect(solo.visibility).toBe("SHARED");
    expect(solo.sortTitle).toBe("solo leveling");
    expect(solo.sourceUrl).toBe("https://example.test/solo");
    expect(solo.originalTitle).toBe("나 혼자만 레벨업");
    expect(solo.tags).toEqual(["action", "fantasy"]);
    expect(solo.externalIds).toMatchObject({ malId: 121496 });

    // Unknown media type -> OTHER, raw value kept as a tag.
    const manual = await prisma.series.findFirstOrThrow({ where: { title: "Manual Uploads" } });
    expect(manual.mediaType).toBe("OTHER");
    expect(manual.tags).toContain("Doujinshi");

    const adult = await prisma.series.findFirstOrThrow({ where: { title: "Adult Club" } });
    expect(adult.isAdult).toBe(true);
    expect(adult.isBookClub).toBe(true);

    // http(s) image_url is recorded, never fetched.
    const ripped = await prisma.series.findFirstOrThrow({ where: { title: "Ripped Series" } });
    expect(ripped.externalIds).toMatchObject({ remoteCover: "https://cdn.example.test/c.jpg" });
    expect(ripped.coverFile).toBeNull();
  });

  it("stores the local cover as WebP", async () => {
    const solo = await prisma.series.findFirstOrThrow({ where: { title: "Solo Leveling" } });
    expect(solo.coverFile).toBe("cover.webp");
    const file = path.join(dataRoot, "covers", solo.id, "cover.webp");
    const bytes = await readFile(file);
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString("ascii")).toBe("WEBP");
  });

  it("copies library entries verbatim", async () => {
    const solo = await prisma.series.findFirstOrThrow({ where: { title: "Solo Leveling" } });
    const alice = await prisma.user.findFirstOrThrow({ where: { email: "alice@example.com" } });
    const entry = await prisma.libraryEntry.findFirstOrThrow({
      where: { userId: alice.id, seriesId: solo.id },
    });
    expect(entry.status).toBe("READING");
    expect(entry.currentChapter).toBe(12);
    expect(entry.rating).toBe(8);
    expect(entry.notes).toBe("great");
    expect(await prisma.libraryEntry.count()).toBe(4);
  });

  it("creates sources only for plugin sites, as NEEDS_PLUGIN", async () => {
    const sources = await prisma.source.findMany({ include: { series: true } });
    expect(sources).toHaveLength(2);
    for (const source of sources) {
      expect(source.pluginId).toBeNull();
      expect(source.status).toBe("NEEDS_PLUGIN");
      expect(source.configJson).toMatchObject({ v1Site: "mangadex" });
    }

    const manual = await prisma.series.findFirstOrThrow({
      where: { title: "Manual Uploads" },
      include: { source: true },
    });
    expect(manual.source).toBeNull();
    const pdf = await prisma.series.findFirstOrThrow({
      where: { title: "PDF Book" },
      include: { source: true },
    });
    expect(pdf.source).toBeNull();
  });

  it("re-encrypts a fresh cookie and drops a stale one", async () => {
    const ripped = await prisma.series.findFirstOrThrow({
      where: { title: "Ripped Series" },
      include: { source: true },
    });
    expect(ripped.source?.cookieEnc).not.toBeNull();
    // Volatile Cloudflare cookies are stripped before encryption.
    expect(decryptSecret(ripped.source?.cookieEnc as Uint8Array)).toBe("cf_clearance=fresh-value");
    expect(ripped.source?.userAgent).toBe("UA/fresh");
    expect(ripped.source?.autoSyncMode).toBe("CUSTOM");
    expect(ripped.source?.autoSyncIntervalMinutes).toBe(720);
    expect(ripped.source?.slug).toBe("ripped-series");
    expect(ripped.source?.normalizedUrl).toBe("https://mangadex.test/title/x");

    const adult = await prisma.series.findFirstOrThrow({
      where: { title: "Adult Club" },
      include: { source: true },
    });
    expect(adult.source?.cookieEnc).toBeNull();
    expect(adult.source?.userAgent).toBeNull();
    expect(adult.source?.cookieUpdatedAt).toBeNull();
    expect(real.warnings.some((warning) => warning.code === "COOKIE_DROPPED_STALE")).toBe(true);
  });

  it("ingests chapters and pages with the right origins", async () => {
    const manual = await prisma.series.findFirstOrThrow({
      where: { title: "Manual Uploads" },
      include: { chapters: { include: { pages: true } } },
    });
    expect(manual.chapters).toHaveLength(1);
    expect(manual.chapters[0]?.origin).toBe("MANUAL");
    expect(manual.chapters[0]?.status).toBe("COMPLETED");
    expect(manual.chapters[0]?.pages).toHaveLength(2);
    expect(manual.chapters[0]?.pages[0]?.width).toBeGreaterThan(0);

    const pdf = await prisma.series.findFirstOrThrow({
      where: { title: "PDF Book" },
      include: { chapters: true },
    });
    expect(pdf.chapters[0]?.origin).toBe("PDF");

    const ripped = await prisma.series.findFirstOrThrow({
      where: { title: "Ripped Series" },
      include: { chapters: { orderBy: { sortIndex: "asc" } } },
    });
    expect(ripped.chapters.map((chapter) => chapter.slug)).toEqual(["chapter-1", "chapter-2"]);
    expect(ripped.chapters.every((chapter) => chapter.origin === "PLUGIN")).toBe(true);
    expect(ripped.chapterCount).toBe(2);

    expect(await prisma.chapter.count()).toBe(4);
    expect(await prisma.page.count()).toBe(6);

    // The copied files really landed in the content store.
    const page = await prisma.page.findFirstOrThrow({
      where: { chapter: { seriesId: ripped.id } },
    });
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: page.chapterId } });
    await expect(
      lstat(path.join(libraryDir(ripped.id), chapter.slug, page.file)),
    ).resolves.toBeDefined();
  });

  it("reports the series whose manifest is gone", () => {
    expect(real.content.manifestsMissing).toBe(1);
    expect(real.content.copied).toBe(3);
    expect(real.content.linked).toBe(0);
    expect(real.content.failed).toBe(0);
    expect(real.content.bytes).toBeGreaterThan(0);
    const missing = real.warnings.filter((warning) => warning.code === "MANIFEST_MISSING");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.v1Id).toBe("rip-adult");
  });

  it("resolves reading positions and reports the ones it cannot", async () => {
    const ripped = await prisma.series.findFirstOrThrow({ where: { title: "Ripped Series" } });
    const alice = await prisma.user.findFirstOrThrow({ where: { email: "alice@example.com" } });
    const bob = await prisma.user.findFirstOrThrow({ where: { email: "bob@example.com" } });

    const resolved = await prisma.readingPosition.findFirstOrThrow({
      where: { userId: alice.id, seriesId: ripped.id },
      include: { chapter: true },
    });
    expect(resolved.chapter?.slug).toBe("chapter-1");
    expect(resolved.pageIndex).toBe(3);

    const unresolved = await prisma.readingPosition.findFirstOrThrow({
      where: { userId: bob.id, seriesId: ripped.id },
    });
    expect(unresolved.chapterId).toBeNull();
    expect(real.warnings.some((warning) => warning.code === "POSITION_UNRESOLVED")).toBe(true);
    expect(await prisma.readingPosition.count()).toBe(3);
  });

  it("imports only fresh unread notifications, with rewritten links", async () => {
    const notifications = await prisma.notification.findMany({ orderBy: { title: "asc" } });
    expect(notifications).toHaveLength(2);
    expect(notifications.map((row) => row.type).sort()).toEqual([
      "BOOK_CLUB_ADDED",
      "SYNC_COMPLETED",
    ]);

    const ripped = await prisma.series.findFirstOrThrow({ where: { title: "Ripped Series" } });
    const sync = notifications.find((row) => row.type === "SYNC_COMPLETED");
    expect(sync?.link).toBe(`/series/${ripped.id}`);
    expect(sync?.seriesId).toBe(ripped.id);

    expect(real.counts.notifications.read).toBe(4);
    expect(real.counts.notifications.created).toBe(2);
    expect(real.counts.notifications.skipped).toBe(2);
  });

  it("copies app settings, renaming verbose_rip_logging", async () => {
    const settings = await prisma.appSetting.findUniqueOrThrow({ where: { id: "global" } });
    expect(settings.autoSyncEnabled).toBe(true);
    expect(settings.autoSyncIntervalMinutes).toBe(720);
    expect(settings.verbosePluginLogging).toBe(true);
  });

  it("skips a site credential with no plugin and says so", async () => {
    expect(await prisma.pluginCredential.count()).toBe(0);
    expect(real.counts.credentials).toMatchObject({ read: 1, created: 0, skipped: 1 });
    const warning = real.warnings.find(
      (candidate) => candidate.code === "CREDENTIAL_SKIPPED_NO_PLUGIN",
    );
    expect(warning?.message).toContain("mangadex");
  });

  it("never writes to the V1 database", async () => {
    await withClient(v1Url, async (client) => {
      const counts = await client.query<{ users: string; series: string; rips: string }>(
        `SELECT (SELECT count(*) FROM "users")::text AS users,
                (SELECT count(*) FROM "series")::text AS series,
                (SELECT count(*) FROM "series_rips")::text AS rips`,
      );
      expect(counts.rows[0]).toEqual({ users: "3", series: "5", rips: "4" });
    });
  });

  it("is idempotent: a second run adds nothing", async () => {
    const before = {
      users: await prisma.user.count(),
      series: await prisma.series.count(),
      entries: await prisma.libraryEntry.count(),
      sources: await prisma.source.count(),
      chapters: await prisma.chapter.count(),
      pages: await prisma.page.count(),
      notifications: await prisma.notification.count(),
      invites: await prisma.invite.count(),
    };

    const again = await runV1Import(importOptions());

    expect(await prisma.user.count()).toBe(before.users);
    expect(await prisma.series.count()).toBe(before.series);
    expect(await prisma.libraryEntry.count()).toBe(before.entries);
    expect(await prisma.source.count()).toBe(before.sources);
    expect(await prisma.chapter.count()).toBe(before.chapters);
    expect(await prisma.page.count()).toBe(before.pages);
    expect(await prisma.notification.count()).toBe(before.notifications);
    // No second invite for a user that already exists.
    expect(await prisma.invite.count()).toBe(before.invites);

    expect(again.counts.users.created).toBe(0);
    expect(again.counts.users.reused).toBe(3);
    expect(again.counts.series.created).toBe(0);
    expect(again.counts.series.reused).toBe(5);
    expect(again.counts.notifications.reused).toBe(2);
    expect(again.counts.chapters.created).toBe(0);
    expect(again.counts.pages.created).toBe(0);
    // The files are already there, so nothing is copied a second time.
    expect(again.content.bytes).toBe(0);
  }, 180_000);

  it("picks up a series edited in V1 between runs as `updated`", async () => {
    await withClient(v1Url, async (client) => {
      await client.query(`UPDATE "series" SET "title" = $1, "synopsis" = $2 WHERE "id" = $3`, [
        "Solo Leveling: Ragnarok",
        "The sequel.",
        V1.solo,
      ]);
    });

    const again = await runV1Import(importOptions());
    expect(again.counts.series.updated).toBe(1);
    expect(again.counts.series.reused).toBe(4);
    expect(again.counts.series.created).toBe(0);

    const solo = await prisma.series.findFirstOrThrow({ where: { malId: 121496 } });
    expect(solo.title).toBe("Solo Leveling: Ragnarok");
    expect(solo.sortTitle).toBe("solo leveling: ragnarok");
    expect(solo.synopsis).toBe("The sequel.");
    expect(await prisma.series.count()).toBe(5);
  }, 180_000);

  it("links instead of copying in --link mode", async () => {
    await resetDatabase();
    process.env.DATA_ROOT = linkDataRoot;
    resetEnvCache();

    const linked = await runV1Import(importOptions({ mode: "link" }));

    expect(linked.mode).toBe("link");
    expect(linked.content.linked).toBe(3);
    expect(linked.content.copied).toBe(0);

    const ripped = await prisma.series.findFirstOrThrow({
      where: { title: "Ripped Series" },
      include: { chapters: true },
    });
    const target = libraryDir(ripped.id);
    const info = await lstat(target);
    expect(info.isSymbolicLink() || info.isDirectory()).toBe(true);
    // Chapters are ingested through the link, so reading works immediately.
    expect(ripped.chapters).toHaveLength(2);
    expect(await prisma.page.count()).toBe(6);

    process.env.DATA_ROOT = dataRoot;
    resetEnvCache();
  }, 180_000);
});
