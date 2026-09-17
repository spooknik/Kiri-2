/**
 * The whole content-source path, end to end and for real: resolve a URL
 * against the installed template plugin, bind it to a series, run
 * `node <entry> sync` as a subprocess against a local fixture site, ingest the
 * manifest it writes, and check the notifications that follow.
 *
 * The only mock is `@/lib/auth/session`. The plugin is
 * `packages/source-template`, the site is its `fixture-site` served over HTTP,
 * and the job runner is the real one.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startFixtureServer, type FixtureServer } from "@kiri/source-sdk/testing";
import {
  createTestUser,
  mockCurrentUser,
  resetDatabase,
  routeContext,
} from "../../../test/factories";
import { dropInPlugin, FIXTURE_SITE, SDK_DIR } from "../../../test/plugin-fixtures";

import { POST as resolveRoute } from "@/app/api/plugins/resolve/route";
import {
  DELETE as unbindRoute,
  GET as getSourceRoute,
  PATCH as patchSourceRoute,
  PUT as putSourceRoute,
} from "@/app/api/series/[id]/source/route";
import { PUT as putCredentialRoute } from "@/app/api/series/[id]/source/credential/route";
import { POST as syncRoute } from "@/app/api/series/[id]/source/sync/route";

import type { SessionUser } from "@/lib/auth/types";
import type { EnqueuedJobResponse } from "@/lib/contracts/content";
import type { ResolveUrlResponse, SourceView } from "@/lib/contracts/plugins";
import { libraryDir, pluginsDir } from "@/lib/content/store";
import { resetEnvCache } from "@/lib/env";
import "@/lib/jobs/handlers";
import { cancelJob } from "@/lib/jobs/queue";
import { processJobsUntilIdle, stopJobRunner, triggerJobProcessing } from "@/lib/jobs/runner";
import { linkSdk } from "@/lib/plugins/sdk-link";
import { runAutoSyncSweep, stopAutoSyncScheduler } from "@/lib/plugins/auto-sync";
import { scanPlugins } from "@/lib/plugins/registry";
import { clearResolveCache } from "@/lib/plugins/resolve";
import { prisma } from "@/lib/prisma";
import { updateAppSettings } from "@/lib/settings";

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: vi.fn(),
}));

const ORIGIN = "http://localhost:3000";
const SERIES_PATH = "/series/starlight-express/";

let dataRoot: string;
let site: FixtureServer;
let challengeSite: FixtureServer;

beforeAll(async () => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "kiri-plugin-sync-"));
  process.env.DATA_ROOT = dataRoot;
  process.env.KIRI_SDK_DIR = SDK_DIR;
  process.env.KIRI_PLUGIN_SANDBOX = "off";
  resetEnvCache();

  site = await startFixtureServer(FIXTURE_SITE);
  // A second copy of the same site that answers with Cloudflare's marker
  // header, so a 403 there is a bot challenge rather than a plain block.
  challengeSite = await startFixtureServer(FIXTURE_SITE, {
    headers: { "cf-mitigated": "challenge" },
  });

  // Install the template the "drop a folder in" way and link the SDK by hand:
  // this file is about syncing, not about the installer (install.int.test.ts
  // covers that path).
  const dir = dropInPlugin(pluginsDir(), { id: "template" });
  await linkSdk(dir);
}, 60_000);

afterAll(async () => {
  stopJobRunner();
  stopAutoSyncScheduler();
  await site.close();
  await challengeSite.close();
  delete process.env.KIRI_SDK_DIR;
  delete process.env.KIRI_PLUGIN_SANDBOX;
  // Windows holds the junction we created under the plugin directory open a
  // little longer than the test does; a temp directory that survives one run
  // is not worth failing a suite over.
  try {
    rmSync(dataRoot, { recursive: true, force: true });
  } catch {
    /* the OS will clean it up */
  }
  resetEnvCache();
});

beforeEach(async () => {
  await resetDatabase();
  clearResolveCache();
  site.clearFailures();
  challengeSite.clearFailures();
  await scanPlugins();
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function seriesUrl(server: FixtureServer = site): string {
  return `${server.baseUrl}${SERIES_PATH}`;
}

async function seedSeries(user: SessionUser, title = "Starlight Express"): Promise<string> {
  const series = await prisma.series.create({
    data: { title, sortTitle: title.toLowerCase(), createdById: user.id },
  });
  return series.id;
}

function json(url: string, method: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function configure(
  user: SessionUser,
  seriesId: string,
  url: string,
): Promise<{ status: number; body: unknown }> {
  mockCurrentUser(user);
  const response = await putSourceRoute(
    json(`${ORIGIN}/api/series/${seriesId}/source`, "PUT", { url }),
    routeContext({ id: seriesId }),
  );
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function requestSync(
  user: SessionUser,
  seriesId: string,
  kind: "sync" | "verify" = "sync",
): Promise<string> {
  mockCurrentUser(user);
  const response = await syncRoute(
    json(`${ORIGIN}/api/series/${seriesId}/source/sync`, "POST", { kind }),
    routeContext({ id: seriesId }),
  );
  expect(response.status).toBe(202);
  return ((await response.json()) as EnqueuedJobResponse).jobId;
}

async function drain(): Promise<void> {
  await processJobsUntilIdle({ timeoutMs: 120_000 });
}

async function jobOf(jobId: string) {
  return prisma.job.findUniqueOrThrow({ where: { id: jobId } });
}

/** Assertion failures on a job are useless without its log; attach it. */
function describeJob(job: {
  status: string;
  errorCode: string | null;
  error: string | null;
  outputLog: string | null;
}): string {
  return `${job.status} (${job.errorCode ?? "-"}): ${job.error ?? "-"}
${job.outputLog ?? ""}`;
}

/** Configure + first sync, the normal path a user takes. */
async function bindAndSync(user: SessionUser, seriesId: string, url = seriesUrl()): Promise<void> {
  const configured = await configure(user, seriesId, url);
  expect(configured.status).toBe(200);
  await drain();
}

/* -------------------------------------------------------------------------- */
/* Resolve                                                                    */
/* -------------------------------------------------------------------------- */

describe("POST /api/plugins/resolve", () => {
  it("finds the plugin that claims the host and normalises the URL", async () => {
    const user = await createTestUser();
    mockCurrentUser(user);

    const response = await resolveRoute(
      json(`${ORIGIN}/api/plugins/resolve`, "POST", { url: `${seriesUrl()}?utm_source=x` }),
      routeContext({}),
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as ResolveUrlResponse;
    expect(body).toMatchObject({
      handled: true,
      pluginId: "template",
      pluginName: "Template Source",
      slug: "starlight-express",
      title: "Starlight Express",
      mediaType: "MANGA",
      needsCookie: false,
      existingSeriesId: null,
    });
    expect(body.normalizedUrl).toBe(seriesUrl());
  });

  it("answers handled: false for a host no plugin claims", async () => {
    const user = await createTestUser();
    mockCurrentUser(user);

    const response = await resolveRoute(
      json(`${ORIGIN}/api/plugins/resolve`, "POST", { url: "https://nobody.invalid/series/1" }),
      routeContext({}),
    );
    const body = (await response.json()) as ResolveUrlResponse;
    expect(body.handled).toBe(false);
    expect(body.pluginId).toBeNull();
  });

  it("reports a series that already uses the link", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);
    await bindAndSync(user, seriesId);

    mockCurrentUser(user);
    const response = await resolveRoute(
      json(`${ORIGIN}/api/plugins/resolve`, "POST", { url: seriesUrl() }),
      routeContext({}),
    );
    expect(((await response.json()) as ResolveUrlResponse).existingSeriesId).toBe(seriesId);
  });

  it("does not spawn anything for an unclaimed host", async () => {
    const user = await createTestUser();
    mockCurrentUser(user);
    const before = site.requests.length;

    await resolveRoute(
      json(`${ORIGIN}/api/plugins/resolve`, "POST", { url: "https://nobody.invalid/x" }),
      routeContext({}),
    );
    expect(site.requests.length).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/* Configure + sync                                                           */
/* -------------------------------------------------------------------------- */

describe("binding a source and syncing it", () => {
  it("downloads the fixture series and ingests three chapters", async () => {
    const user = await createTestUser();
    const seriesId = await seedSeries(user);

    const configured = await configure(user, seriesId, seriesUrl());
    expect(configured.status).toBe(200);
    // Binding a URL starts the first sync immediately, so by the time the
    // response is built the source is already PENDING or RUNNING.
    expect((configured.body as SourceView).activeJobId).not.toBeNull();
    expect(["PENDING", "RUNNING"]).toContain((configured.body as SourceView).status);

    await drain();

    const job = await prisma.job.findFirstOrThrow({
      where: { seriesId, kind: "SOURCE_SYNC" },
      orderBy: { createdAt: "desc" },
    });
    expect(describeJob(job)).toContain("SUCCEEDED");
    expect(job.resultJson).toMatchObject({
      chaptersCreated: 3,
      newChapters: 3,
      pluginResult: { chaptersTotal: 3, chaptersCompleted: 3, pagesDownloaded: 9 },
    });

    const chapters = await prisma.chapter.findMany({
      where: { seriesId },
      orderBy: { sortIndex: "asc" },
      include: { pages: true },
    });
    expect(chapters).toHaveLength(3);
    expect(chapters.map((chapter) => chapter.slug)).toEqual([
      "chapter-1",
      "chapter-2",
      "chapter-3",
    ]);
    expect(chapters.every((chapter) => chapter.status === "COMPLETED")).toBe(true);
    expect(chapters.every((chapter) => chapter.pages.length === 3)).toBe(true);
    expect(chapters.every((chapter) => chapter.origin === "PLUGIN")).toBe(true);

    // The files really are on disk where the reader will look for them.
    const first = chapters[0]?.pages[0];
    expect(first).toBeDefined();
    expect(existsSync(path.join(libraryDir(seriesId), "chapter-1", first?.file ?? ""))).toBe(true);
    expect(existsSync(path.join(libraryDir(seriesId), "manifest.json"))).toBe(true);

    const source = await prisma.source.findUniqueOrThrow({ where: { seriesId } });
    expect(source.status).toBe("READY");
    expect(source.lastSyncedAt).not.toBeNull();
    expect(source.lastError).toBeNull();
  });

  it("notifies everyone tracking the series about new chapters, once", async () => {
    const owner = await createTestUser();
    const reader = await createTestUser();
    const stranger = await createTestUser();
    const seriesId = await seedSeries(owner);
    for (const user of [owner, reader]) {
      await prisma.libraryEntry.create({ data: { userId: user.id, seriesId } });
    }

    await bindAndSync(owner, seriesId);

    const newChapter = await prisma.notification.findMany({ where: { type: "NEW_CHAPTER" } });
    expect(newChapter).toHaveLength(6); // 3 chapters x 2 trackers
    expect(newChapter.some((row) => row.userId === stranger.id)).toBe(false);
    expect(new Set(newChapter.map((row) => row.dedupeKey)).size).toBe(3);

    // A manual sync also tells the person who asked for it.
    expect(
      await prisma.notification.count({ where: { type: "SYNC_COMPLETED", userId: owner.id } }),
    ).toBe(1);
  });

  it("says nothing on a second sync that finds nothing new", async () => {
    const owner = await createTestUser();
    const seriesId = await seedSeries(owner);
    await prisma.libraryEntry.create({ data: { userId: owner.id, seriesId } });
    await bindAndSync(owner, seriesId);

    const before = await prisma.notification.count({ where: { type: "NEW_CHAPTER" } });
    await prisma.notification.deleteMany({ where: { type: "SYNC_COMPLETED" } });

    const jobId = await requestSync(owner, seriesId);
    await drain();

    const job = await jobOf(jobId);
    expect(describeJob(job)).toContain("SUCCEEDED");
    expect(job.resultJson).toMatchObject({ chaptersCreated: 0, newChapters: 0 });
    expect(await prisma.notification.count({ where: { type: "NEW_CHAPTER" } })).toBe(before);
    expect(await prisma.chapter.count({ where: { seriesId } })).toBe(3);
  });

  it("re-verifies what is on disk without moving lastSyncedAt", async () => {
    const owner = await createTestUser();
    const seriesId = await seedSeries(owner);
    await bindAndSync(owner, seriesId);

    const before = await prisma.source.findUniqueOrThrow({ where: { seriesId } });
    const jobId = await requestSync(owner, seriesId, "verify");
    await drain();

    const job = await jobOf(jobId);
    expect(job.kind).toBe("SOURCE_VERIFY");
    expect(describeJob(job)).toContain("SUCCEEDED");
    expect(job.resultJson).toMatchObject({ kind: "verify" });

    const after = await prisma.source.findUniqueOrThrow({ where: { seriesId } });
    expect(after.status).toBe("READY");
    expect(after.lastSyncedAt?.getTime()).toBe(before.lastSyncedAt?.getTime());
  });

  it("keeps the job successful when only one chapter fails", async () => {
    const owner = await createTestUser();
    const seriesId = await seedSeries(owner);
    // A page that always 500s: the SDK fails that chapter and carries on, and
    // `sync` still exits 0 (docs/PLUGINS.md, "a failing chapter does not abort
    // the run").
    site.fail(`${SERIES_PATH}chapters/2/p02.png`, 500);

    await bindAndSync(owner, seriesId);

    const job = await prisma.job.findFirstOrThrow({
      where: { seriesId, kind: "SOURCE_SYNC" },
      orderBy: { createdAt: "desc" },
    });
    expect(describeJob(job)).toContain("SUCCEEDED");
    expect(job.resultJson).toMatchObject({ pluginResult: { chaptersFailed: 1 } });

    const chapters = await prisma.chapter.findMany({
      where: { seriesId },
      orderBy: { slug: "asc" },
    });
    const failed = chapters.find((chapter) => chapter.slug === "chapter-2");
    expect(failed?.status).toBe("FAILED");
    expect(chapters.filter((chapter) => chapter.status === "COMPLETED")).toHaveLength(2);
    // A partially failed sync is still a successful run: the source is READY
    // and the two good chapters are readable.
    expect(await prisma.source.findUniqueOrThrow({ where: { seriesId } })).toMatchObject({
      status: "READY",
    });
  });

  it("refuses a URL another visible series already reads", async () => {
    const owner = await createTestUser();
    const first = await seedSeries(owner, "First");
    await bindAndSync(owner, first);

    const second = await seedSeries(owner, "Second");
    const conflict = await configure(owner, second, seriesUrl());

    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      error: { code: "CONFLICT", details: { existingSeriesId: first } },
    });
  });

  it("refuses a URL no plugin handles", async () => {
    const owner = await createTestUser();
    const seriesId = await seedSeries(owner);
    const refused = await configure(owner, seriesId, "https://nobody.invalid/series/1");
    expect(refused.status).toBe(400);
    expect(await prisma.source.count({ where: { seriesId } })).toBe(0);
  });

  it("refuses to bind or sync a series the user cannot edit", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const seriesId = await seedSeries(owner);
    await bindAndSync(owner, seriesId);

    const refusedBind = await configure(other, seriesId, seriesUrl());
    expect(refusedBind.status).toBe(403);

    mockCurrentUser(other);
    const refusedSync = await syncRoute(
      json(`${ORIGIN}/api/series/${seriesId}/source/sync`, "POST", { kind: "sync" }),
      routeContext({ id: seriesId }),
    );
    expect(refusedSync.status).toBe(403);

    // …but they can still see it, because they can see the series.
    const view = await getSourceRoute(
      new NextRequest(`${ORIGIN}/api/series/${seriesId}/source`),
      routeContext({ id: seriesId }),
    );
    expect(view.status).toBe(200);
    expect((await view.json()) as SourceView).toMatchObject({ status: "READY" });
  });

  it("refuses a second sync while one is already running", async () => {
    const owner = await createTestUser();
    const seriesId = await seedSeries(owner);
    await bindAndSync(owner, seriesId);

    await requestSync(owner, seriesId);
    mockCurrentUser(owner);
    const second = await syncRoute(
      json(`${ORIGIN}/api/series/${seriesId}/source/sync`, "POST", { kind: "sync" }),
      routeContext({ id: seriesId }),
    );
    expect(second.status).toBe(409);
    await drain();
  });
});

/* -------------------------------------------------------------------------- */
/* Credentials                                                                */
/* -------------------------------------------------------------------------- */

describe("NEEDS_CREDENTIAL", () => {
  it("flags the source and asks the series creator for a cookie", async () => {
    const owner = await createTestUser();
    const seriesId = await seedSeries(owner);
    await bindAndSync(owner, seriesId, seriesUrl(challengeSite));

    // Now the site answers the series metadata with a Cloudflare challenge.
    challengeSite.fail(`${SERIES_PATH}series.json`, 403);
    const jobId = await requestSync(owner, seriesId);
    await drain();

    const job = await jobOf(jobId);
    expect(job.status).toBe("FAILED");
    expect(job.errorCode).toBe("NEEDS_CREDENTIAL");

    const source = await prisma.source.findUniqueOrThrow({ where: { seriesId } });
    expect(source.status).toBe("FAILED");
    expect(source.lastErrorCode).toBe("NEEDS_CREDENTIAL");

    const notification = await prisma.notification.findFirstOrThrow({
      where: { type: "NEEDS_CREDENTIAL", userId: owner.id },
    });
    expect(notification.dedupeKey).toBe(`needs-credential:${seriesId}`);
    expect(notification.message).toContain("Cookie Bridge");
  });

  it("stores a pasted cookie without ever handing it back", async () => {
    const owner = await createTestUser();
    const seriesId = await seedSeries(owner);
    await bindAndSync(owner, seriesId);
    await prisma.source.update({
      where: { seriesId },
      data: { lastErrorCode: "NEEDS_CREDENTIAL" },
    });

    mockCurrentUser(owner);
    const response = await putCredentialRoute(
      json(`${ORIGIN}/api/series/${seriesId}/source/credential`, "PUT", {
        // A bare token, with a volatile cookie mixed in.
        cookie: "cf_clearance=abc; __cf_bm=volatile",
        userAgent: "Mozilla/5.0 (Test)",
      }),
      routeContext({ id: seriesId }),
    );
    expect(response.status).toBe(200);

    const view = (await response.json()) as SourceView;
    expect(view.hasSeriesCookie).toBe(true);
    expect(view.cookieUpdatedAt).not.toBeNull();
    // Pasting a cookie is the answer to the nag, so the nag goes away.
    expect(view.lastErrorCode).toBeNull();
    expect(JSON.stringify(view)).not.toContain("cf_clearance");

    const stored = await prisma.source.findUniqueOrThrow({ where: { seriesId } });
    const { decryptSecret } = await import("@/lib/crypto");
    expect(decryptSecret(stored.cookieEnc as Uint8Array)).toBe("cf_clearance=abc");
  });
});

/* -------------------------------------------------------------------------- */
/* Cancellation                                                               */
/* -------------------------------------------------------------------------- */

describe("cancelling a sync", () => {
  /** A plugin that says hello, reports progress, then never finishes. */
  function dropInStallingPlugin(): void {
    const dir = path.join(pluginsDir(), "stall-source");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(
      path.join(dir, "kiri-plugin.json"),
      JSON.stringify({
        id: "stall-source",
        name: "Stalling Source",
        version: "1.0.0",
        sdk: "*",
        entry: "./src/index.mjs",
        hosts: ["stall.invalid"],
      }),
    );
    writeFileSync(
      path.join(dir, "src", "index.mjs"),
      [
        `process.stdout.write(JSON.stringify({t:"hello",v:1,plugin:"stall-source",version:"1.0.0",sdk:"2.0.0-alpha.0"})+"\\n");`,
        `process.stdout.write(JSON.stringify({t:"progress",phase:"discover",current:0,total:1})+"\\n");`,
        `setInterval(() => {}, 1000);`,
      ].join("\n"),
    );
  }

  it("stops the job promptly instead of waiting for the idle timeout", async () => {
    const owner = await createTestUser();
    dropInStallingPlugin();
    await scanPlugins();

    const seriesId = await seedSeries(owner, "Stalling");
    const source = await prisma.source.create({
      data: {
        seriesId,
        pluginId: "stall-source",
        normalizedUrl: "https://stall.invalid/series/x/",
        status: "PENDING",
      },
    });
    const jobId = await requestSync(owner, seriesId);

    // Let the runner claim it and get as far as spawning the child.
    triggerJobProcessing();
    const startedAt = Date.now();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const job = await jobOf(jobId);
      if (job.status === "RUNNING" && job.progressJson && "phase" in (job.progressJson as object)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    await cancelJob(owner, jobId);
    await drain();

    const job = await jobOf(jobId);
    expect(job.status).toBe("CANCELLED");
    // The idle timeout is 300 s. Finishing in seconds means the subprocess was
    // actually killed rather than left to time out.
    expect(Date.now() - startedAt).toBeLessThan(60_000);
    expect(source.status).toBe("PENDING");
  }, 90_000);
});

/* -------------------------------------------------------------------------- */
/* Settings, unbinding and the scheduler                                      */
/* -------------------------------------------------------------------------- */

describe("source settings", () => {
  it("stores plugin settings and auto-sync preferences", async () => {
    const owner = await createTestUser();
    const seriesId = await seedSeries(owner);
    await bindAndSync(owner, seriesId);

    mockCurrentUser(owner);
    const response = await patchSourceRoute(
      json(`${ORIGIN}/api/series/${seriesId}/source`, "PATCH", {
        autoSyncMode: "CUSTOM",
        autoSyncIntervalMinutes: 180,
        settings: { language: "en" },
      }),
      routeContext({ id: seriesId }),
    );
    expect(response.status).toBe(200);

    const view = (await response.json()) as SourceView;
    expect(view.autoSyncMode).toBe("CUSTOM");
    expect(view.autoSyncIntervalMinutes).toBe(180);
    expect(view.effectiveIntervalMinutes).toBe(180);
    expect(view.settings).toEqual({ language: "en" });
  });

  it("unbinds without touching the chapters", async () => {
    const owner = await createTestUser();
    const seriesId = await seedSeries(owner);
    await bindAndSync(owner, seriesId);

    mockCurrentUser(owner);
    const response = await unbindRoute(
      new NextRequest(`${ORIGIN}/api/series/${seriesId}/source`, { method: "DELETE" }),
      routeContext({ id: seriesId }),
    );
    expect(response.status).toBe(204);

    expect(await prisma.source.count({ where: { seriesId } })).toBe(0);
    expect(await prisma.chapter.count({ where: { seriesId } })).toBe(3);

    // The blank view is still a view.
    const view = await getSourceRoute(
      new NextRequest(`${ORIGIN}/api/series/${seriesId}/source`),
      routeContext({ id: seriesId }),
    );
    expect((await view.json()) as SourceView).toMatchObject({
      status: "UNCONFIGURED",
      plugin: null,
      normalizedUrl: null,
    });
  });
});

describe("the auto-sync sweep", () => {
  it("does nothing while auto-sync is globally off", async () => {
    const owner = await createTestUser();
    const seriesId = await seedSeries(owner);
    await bindAndSync(owner, seriesId);
    await prisma.source.update({
      where: { seriesId },
      data: { lastSyncedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    });

    expect(await runAutoSyncSweep()).toBe(0);
  });

  it("queues a due source once and stamps it so the next sweep skips it", async () => {
    const owner = await createTestUser();
    const seriesId = await seedSeries(owner);
    await bindAndSync(owner, seriesId);
    await updateAppSettings({ autoSyncEnabled: true, autoSyncIntervalMinutes: 60 });

    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await prisma.source.update({
      where: { seriesId },
      data: { lastSyncedAt: longAgo, createdAt: longAgo },
    });
    // The manual first sync already reported itself; this test is about what
    // the *automatic* one says.
    await prisma.notification.deleteMany({});

    expect(await runAutoSyncSweep()).toBe(1);
    const queued = await prisma.job.findFirstOrThrow({
      where: { seriesId, status: "QUEUED", kind: "SOURCE_SYNC" },
    });
    expect(queued.configJson).toMatchObject({ autoSync: true });
    expect(
      (await prisma.source.findUniqueOrThrow({ where: { seriesId } })).autoSyncRequestedAt,
    ).not.toBeNull();

    // Still queued, and freshly stamped: nothing more to do this hour.
    expect(await runAutoSyncSweep()).toBe(0);
    await drain();

    // An automatic run that found nothing new says nothing at all.
    expect(await prisma.notification.count({ where: { type: "SYNC_COMPLETED" } })).toBe(0);
  });

  it("skips a source whose plugin is disabled", async () => {
    const owner = await createTestUser();
    const seriesId = await seedSeries(owner);
    await bindAndSync(owner, seriesId);
    await updateAppSettings({ autoSyncEnabled: true, autoSyncIntervalMinutes: 60 });

    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await prisma.source.update({
      where: { seriesId },
      data: { lastSyncedAt: longAgo, createdAt: longAgo, autoSyncMode: "DISABLED" },
    });
    expect(await runAutoSyncSweep()).toBe(0);

    await prisma.source.update({ where: { seriesId }, data: { autoSyncMode: "INHERIT" } });
    await prisma.plugin.update({ where: { id: "template" }, data: { status: "DISABLED" } });
    expect(await runAutoSyncSweep()).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Sandbox                                                                    */
/* -------------------------------------------------------------------------- */

describe("with KIRI_PLUGIN_SANDBOX=on", () => {
  it("still syncs the template plugin under Node's permission model", async () => {
    process.env.KIRI_PLUGIN_SANDBOX = "on";
    resetEnvCache();
    try {
      const owner = await createTestUser();
      const seriesId = await seedSeries(owner, "Sandboxed");
      await bindAndSync(owner, seriesId);

      const job = await prisma.job.findFirstOrThrow({
        where: { seriesId, kind: "SOURCE_SYNC" },
        orderBy: { createdAt: "desc" },
      });
      expect(describeJob(job)).toContain("SUCCEEDED");
      expect(job.resultJson).toMatchObject({ sandboxed: true, chaptersCreated: 3 });
      expect(await prisma.chapter.count({ where: { seriesId } })).toBe(3);
    } finally {
      process.env.KIRI_PLUGIN_SANDBOX = "off";
      resetEnvCache();
    }
  }, 90_000);
});
