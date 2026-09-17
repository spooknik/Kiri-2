/**
 * Installing plugins end to end: upload -> POST /api/plugins -> the job runner
 * -> a real `node <entry> hello` -> a `Plugin` row and a directory in
 * `DATA_ROOT/plugins`.
 *
 * Nothing is mocked except `@/lib/auth/session` (the project's standard way of
 * driving route handlers as a given user). The plugin installed is the real
 * `packages/source-template`, zipped the way GitHub would ship it.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestUser,
  mockCurrentUser,
  resetDatabase,
  routeContext,
} from "../../../test/factories";
import { buildTemplateZip, dropInPlugin, SDK_DIR } from "../../../test/plugin-fixtures";

import { GET as extensionTokenRoute } from "@/app/api/admin/plugins/extension-token/route";
import { POST as credentialsRoute } from "@/app/api/plugins/credentials/route";
import { GET as hostsRoute } from "@/app/api/plugins/hosts/route";
import {
  DELETE as deletePluginRoute,
  PATCH as patchPluginRoute,
} from "@/app/api/plugins/[id]/route";
import { GET as listPluginsRoute, POST as installRoute } from "@/app/api/plugins/route";

import type { SessionUser } from "@/lib/auth/types";
import type { EnqueuedJobResponse } from "@/lib/contracts/content";
import type { ExtensionTokenResponse, PluginView } from "@/lib/contracts/plugins";
import { pluginsDir } from "@/lib/content/store";
import { resetEnvCache } from "@/lib/env";
import "@/lib/jobs/handlers";
import { processJobsUntilIdle, stopJobRunner } from "@/lib/jobs/runner";
import { stopAutoSyncScheduler } from "@/lib/plugins/auto-sync";
import { scanPlugins } from "@/lib/plugins/registry";
import { clearResolveCache } from "@/lib/plugins/resolve";
import { prisma } from "@/lib/prisma";
import { completeUpload, createUploadSession, writeChunk } from "@/lib/uploads/sessions";

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: vi.fn(),
}));

const ORIGIN = "http://localhost:3000";
let dataRoot: string;

beforeAll(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "kiri-plugin-install-"));
  process.env.DATA_ROOT = dataRoot;
  process.env.KIRI_SDK_DIR = SDK_DIR;
  // The sandbox is exercised on its own in sync.int.test.ts; installs here are
  // about the pipeline, not the permission model.
  process.env.KIRI_PLUGIN_SANDBOX = "off";
  resetEnvCache();
});

afterAll(() => {
  stopJobRunner();
  stopAutoSyncScheduler();
  delete process.env.KIRI_SDK_DIR;
  delete process.env.KIRI_PLUGIN_SANDBOX;
  // Windows can still hold the SDK junction inside an installed plugin open;
  // a temp directory that outlives one run is not worth failing a suite over.
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
  rmSync(pluginsDir(), { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

async function uploadZip(user: SessionUser, filename: string, data: Buffer): Promise<string> {
  const session = await createUploadSession(user.id, { filename, size: data.length });
  await writeChunk(user.id, session.id, 0, new Uint8Array(data));
  await completeUpload(user.id, session.id);
  return session.id;
}

async function postInstall(user: SessionUser, body: Record<string, unknown>): Promise<Response> {
  mockCurrentUser(user);
  return installRoute(
    new NextRequest(`${ORIGIN}/api/plugins`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    routeContext({}),
  );
}

interface InstalledJob {
  status: string;
  errorCode: string | null;
  error: string | null;
  outputLog: string | null;
  result: unknown;
}

/** Install a zip through the real route + runner and return the finished job. */
async function install(
  admin: SessionUser,
  zip: Buffer,
  options: { filename?: string; acceptRelaxedSandbox?: boolean } = {},
): Promise<InstalledJob> {
  const uploadId = await uploadZip(admin, options.filename ?? "plugin.zip", zip);
  const response = await postInstall(admin, {
    type: "upload",
    uploadId,
    ...(options.acceptRelaxedSandbox ? { acceptRelaxedSandbox: true } : {}),
  });
  expect(response.status).toBe(202);
  const { jobId } = (await response.json()) as EnqueuedJobResponse;

  await processJobsUntilIdle({ timeoutMs: 120_000 });

  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  return {
    status: job.status,
    errorCode: job.errorCode,
    error: job.error,
    outputLog: job.outputLog,
    result: job.resultJson,
  };
}

/* -------------------------------------------------------------------------- */
/* Installing                                                                 */
/* -------------------------------------------------------------------------- */

describe("POST /api/plugins", () => {
  it("installs the template plugin from an uploaded zip", async () => {
    const admin = await createTestUser({ role: "admin" });
    const zip = buildTemplateZip({ wrapIn: "source-template-main" });

    const job = await install(admin, zip, { filename: "source-template.zip" });
    expect(job.status).toBe("SUCCEEDED");

    const row = await prisma.plugin.findUniqueOrThrow({ where: { id: "template" } });
    expect(row.status).toBe("ENABLED");
    expect(row.name).toBe("Template Source");
    expect(row.hosts).toContain("localhost");
    expect(row.capabilities).toEqual(["network"]);
    expect(row.installSource).toBe("upload:source-template.zip");
    expect(row.descriptorHash).toMatch(/^[0-9a-f]{64}$/);

    // The wrapper folder GitHub adds is stripped, so the descriptor is at the
    // root of the installed directory.
    const dir = path.join(pluginsDir(), "template");
    expect(existsSync(path.join(dir, "kiri-plugin.json"))).toBe(true);
    expect(existsSync(path.join(dir, "src", "index.mjs"))).toBe(true);
    // …and the SDK is linked in, which is what makes the entry importable.
    expect(existsSync(path.join(dir, "node_modules", "@kiri", "source-sdk", "package.json"))).toBe(
      true,
    );

    expect(job.outputLog ?? "").toContain("hello ok");
    expect(job.result).toMatchObject({ pluginId: "template", dependenciesInstalled: false });
  });

  it("notifies every admin that a plugin arrived", async () => {
    const admin = await createTestUser({ role: "admin" });
    const otherAdmin = await createTestUser({ role: "admin" });
    await createTestUser({ role: "member" });

    await install(admin, buildTemplateZip());

    const notifications = await prisma.notification.findMany({
      where: { type: "PLUGIN_INSTALLED" },
    });
    expect(notifications.map((row) => row.userId).sort()).toEqual([admin.id, otherAdmin.id].sort());
  });

  it("refuses a member", async () => {
    const member = await createTestUser({ role: "member" });
    const uploadId = await uploadZip(member, "plugin.zip", buildTemplateZip());
    const response = await postInstall(member, { type: "upload", uploadId });
    expect(response.status).toBe(403);
  });

  it("fails the job when the plugin needs an SDK this Kiri does not ship", async () => {
    const admin = await createTestUser({ role: "admin" });
    const job = await install(admin, buildTemplateZip({ id: "old-source", sdk: "^1.0.0" }));

    expect(job.status).toBe("FAILED");
    expect(job.errorCode).toBe("SDK_INCOMPATIBLE");
    expect(await prisma.plugin.count()).toBe(0);
  });

  it("fails the job when the archive has no descriptor at its root", async () => {
    const admin = await createTestUser({ role: "admin" });
    // Two top-level folders, so nothing is stripped and the root has no
    // kiri-plugin.json.
    const zip = buildTemplateZip({ wrapIn: "a/b" });
    const job = await install(admin, zip);

    expect(job.status).toBe("FAILED");
    expect(job.errorCode).toBe("DESCRIPTOR_MISSING");
  });

  it("refuses a relaxed sandbox unless the admin accepted it", async () => {
    const admin = await createTestUser({ role: "admin" });
    const zip = buildTemplateZip({ id: "relaxed-source", sandbox: "relaxed" });

    const refused = await install(admin, zip);
    expect(refused.status).toBe("FAILED");
    expect(refused.errorCode).toBe("SANDBOX_NOT_ACCEPTED");
    expect(await prisma.plugin.count()).toBe(0);

    const accepted = await install(admin, zip, { acceptRelaxedSandbox: true });
    expect(accepted.status).toBe("SUCCEEDED");
    expect(
      await prisma.plugin.findUniqueOrThrow({ where: { id: "relaxed-source" } }),
    ).toMatchObject({ status: "ENABLED" });
  });

  it("re-attaches a source the V1 importer parked for this plugin", async () => {
    const admin = await createTestUser({ role: "admin" });
    const series = await prisma.series.create({
      data: { title: "Parked", sortTitle: "parked", createdById: admin.id },
    });
    await prisma.source.create({
      data: {
        seriesId: series.id,
        pluginId: null,
        normalizedUrl: "http://localhost:1/series/parked/",
        status: "NEEDS_PLUGIN",
        configJson: { v1Site: "template" },
      },
    });

    const job = await install(admin, buildTemplateZip());
    expect(job.status).toBe("SUCCEEDED");

    const source = await prisma.source.findUniqueOrThrow({ where: { seriesId: series.id } });
    expect(source.pluginId).toBe("template");
    expect(source.status).toBe("PENDING");
    expect(job.result).toMatchObject({ sourcesReattached: 1 });
  });
});

/* -------------------------------------------------------------------------- */
/* Listing, enabling, uninstalling                                            */
/* -------------------------------------------------------------------------- */

describe("plugin management", () => {
  async function seedInstalled(): Promise<SessionUser> {
    const admin = await createTestUser({ role: "admin" });
    const job = await install(admin, buildTemplateZip());
    expect(job.status).toBe("SUCCEEDED");
    return admin;
  }

  it("lists plugins for any signed-in user", async () => {
    await seedInstalled();
    const member = await createTestUser({ role: "member" });
    mockCurrentUser(member);

    const response = await listPluginsRoute(
      new NextRequest(`${ORIGIN}/api/plugins`),
      routeContext({}),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as PluginView[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: "template", status: "ENABLED", sourceCount: 0 });
  });

  it("keeps the install source and last error to admins", async () => {
    const admin = await seedInstalled();
    await prisma.plugin.update({
      where: { id: "template" },
      data: { lastError: "ENOENT /srv/kiri/data/plugins/template/src/index.mjs" },
    });

    const list = async (): Promise<PluginView[]> => {
      const response = await listPluginsRoute(
        new NextRequest(`${ORIGIN}/api/plugins`),
        routeContext({}),
      );
      expect(response.status).toBe(200);
      return (await response.json()) as PluginView[];
    };

    mockCurrentUser(await createTestUser({ role: "member" }));
    const asMember = await list();
    expect(asMember[0]).toMatchObject({ id: "template", installSource: null, lastError: null });
    // The series form still needs to know which sites this plugin recognises.
    expect(asMember[0]?.hosts).toContain("localhost");

    mockCurrentUser(admin);
    const asAdmin = await list();
    expect(asAdmin[0]?.installSource).toBe("upload:plugin.zip");
    expect(asAdmin[0]?.lastError).toContain("ENOENT");
  });

  it("disables and re-enables a plugin", async () => {
    const admin = await seedInstalled();
    mockCurrentUser(admin);

    const disable = await patchPluginRoute(
      new NextRequest(`${ORIGIN}/api/plugins/template`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "DISABLED" }),
      }),
      routeContext({ id: "template" }),
    );
    expect(disable.status).toBe(200);
    expect((await disable.json()) as PluginView).toMatchObject({ status: "DISABLED" });

    // A boot scan must not quietly re-enable what an admin turned off.
    await scanPlugins();
    expect(await prisma.plugin.findUniqueOrThrow({ where: { id: "template" } })).toMatchObject({
      status: "DISABLED",
    });

    const enable = await patchPluginRoute(
      new NextRequest(`${ORIGIN}/api/plugins/template`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "ENABLED" }),
      }),
      routeContext({ id: "template" }),
    );
    expect((await enable.json()) as PluginView).toMatchObject({ status: "ENABLED" });
  });

  it("uninstalls: files gone, series parked as NEEDS_PLUGIN, chapters untouched", async () => {
    const admin = await seedInstalled();
    const series = await prisma.series.create({
      data: { title: "Bound", sortTitle: "bound", createdById: admin.id },
    });
    await prisma.source.create({
      data: {
        seriesId: series.id,
        pluginId: "template",
        normalizedUrl: "http://localhost:1/series/bound/",
        status: "READY",
      },
    });
    await prisma.chapter.create({
      data: { seriesId: series.id, slug: "chapter-1", title: "Chapter 1", sortIndex: 0 },
    });

    mockCurrentUser(admin);
    const response = await deletePluginRoute(
      new NextRequest(`${ORIGIN}/api/plugins/template`, { method: "DELETE" }),
      routeContext({ id: "template" }),
    );
    expect(response.status).toBe(204);

    expect(await prisma.plugin.count()).toBe(0);
    expect(existsSync(path.join(pluginsDir(), "template"))).toBe(false);

    const source = await prisma.source.findUniqueOrThrow({ where: { seriesId: series.id } });
    expect(source.pluginId).toBeNull();
    expect(source.status).toBe("NEEDS_PLUGIN");
    expect(source.configJson).toMatchObject({ v1Site: "template" });
    // The library is the user's, not the plugin's.
    expect(await prisma.chapter.count({ where: { seriesId: series.id } })).toBe(1);

    const audit = await prisma.auditLog.findMany({ where: { action: "plugin.uninstall" } });
    expect(audit).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Boot scan                                                                  */
/* -------------------------------------------------------------------------- */

describe("scanPlugins", () => {
  it("adopts a hand-copied plugin directory", async () => {
    dropInPlugin(pluginsDir(), { id: "dropin-source", hosts: ["dropin.invalid"] });

    const result = await scanPlugins();
    expect(result.ok).toBe(1);
    expect(result.added).toBe(1);

    const row = await prisma.plugin.findUniqueOrThrow({ where: { id: "dropin-source" } });
    expect(row.status).toBe("ENABLED");
    expect(row.installSource).toBe("dropin");
    expect(row.hosts).toEqual(["dropin.invalid"]);
  });

  it("ignores a directory whose descriptor does not name it", async () => {
    // Descriptor says "wrong-id", directory says "misnamed".
    dropInPlugin(pluginsDir(), { id: "misnamed" });
    const dir = path.join(pluginsDir(), "misnamed");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      path.join(dir, "kiri-plugin.json"),
      JSON.stringify({ ...JSON.parse(String(await readDescriptorRaw(dir))), id: "wrong-id" }),
    );

    const result = await scanPlugins();
    expect(result.invalid).toBe(1);
    // No row is invented for a directory that was never installed.
    expect(await prisma.plugin.count()).toBe(0);
  });

  it("marks a vanished plugin BROKEN and parks its series, without deleting the row", async () => {
    const admin = await createTestUser({ role: "admin" });
    dropInPlugin(pluginsDir(), { id: "dropin-source", hosts: ["dropin.invalid"] });
    await scanPlugins();

    const series = await prisma.series.create({
      data: { title: "Dropped", sortTitle: "dropped", createdById: admin.id },
    });
    await prisma.source.create({
      data: {
        seriesId: series.id,
        pluginId: "dropin-source",
        normalizedUrl: "http://dropin.invalid/series/x/",
        status: "READY",
      },
    });

    rmSync(path.join(pluginsDir(), "dropin-source"), { recursive: true, force: true });
    const result = await scanPlugins();

    expect(result.missing).toBe(1);
    const row = await prisma.plugin.findUniqueOrThrow({ where: { id: "dropin-source" } });
    expect(row.status).toBe("BROKEN");
    expect(row.lastError).toContain("missing");
    expect(await prisma.source.findUniqueOrThrow({ where: { seriesId: series.id } })).toMatchObject(
      {
        status: "NEEDS_PLUGIN",
      },
    );

    // Putting the directory back heals both.
    dropInPlugin(pluginsDir(), { id: "dropin-source", hosts: ["dropin.invalid"] });
    await scanPlugins();
    expect(await prisma.plugin.findUniqueOrThrow({ where: { id: "dropin-source" } })).toMatchObject(
      {
        status: "ENABLED",
        lastError: null,
      },
    );
    expect(await prisma.source.findUniqueOrThrow({ where: { seriesId: series.id } })).toMatchObject(
      {
        status: "PENDING",
      },
    );
  });
});

async function readDescriptorRaw(dir: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path.join(dir, "kiri-plugin.json"), "utf8");
}

/* -------------------------------------------------------------------------- */
/* Cookie bridge                                                              */
/* -------------------------------------------------------------------------- */

describe("the cookie-bridge endpoints", () => {
  async function token(admin: SessionUser): Promise<ExtensionTokenResponse> {
    mockCurrentUser(admin);
    const response = await extensionTokenRoute(
      new NextRequest(`${ORIGIN}/api/admin/plugins/extension-token`),
      routeContext({}),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as ExtensionTokenResponse;
  }

  function get(url: string, headers: Record<string, string> = {}): NextRequest {
    return new NextRequest(url, { headers });
  }

  it("gives admins a token and refuses members", async () => {
    const admin = await createTestUser({ role: "admin" });
    const value = await token(admin);
    expect(value.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(value.ingestUrl).toContain("/api/plugins/credentials");
    expect(value.hostsUrl).toContain("/api/plugins/hosts");

    mockCurrentUser(await createTestUser({ role: "member" }));
    const refused = await extensionTokenRoute(
      new NextRequest(`${ORIGIN}/api/admin/plugins/extension-token`),
      routeContext({}),
    );
    expect(refused.status).toBe(403);
  });

  it("lists only the hosts of enabled cookie-capable plugins", async () => {
    const admin = await createTestUser({ role: "admin" });
    dropInPlugin(pluginsDir(), {
      id: "cookie-source",
      hosts: ["cookiesite.invalid", "*.cookiesite.invalid"],
      capabilities: ["network", "cookie"],
    });
    dropInPlugin(pluginsDir(), { id: "plain-source", hosts: ["plainsite.invalid"] });
    await scanPlugins();

    const { token: value } = await token(admin);
    const response = await hostsRoute(
      get(`${ORIGIN}/api/plugins/hosts`, { authorization: `Bearer ${value}` }),
      routeContext({}),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { hosts: { host: string; pluginId: string }[] };
    expect(body.hosts.map((entry) => entry.host).sort()).toEqual([
      "*.cookiesite.invalid",
      "cookiesite.invalid",
    ]);
    expect(body.hosts.every((entry) => entry.pluginId === "cookie-source")).toBe(true);
  });

  it("refuses a wrong or missing token with 401", async () => {
    const noToken = await hostsRoute(get(`${ORIGIN}/api/plugins/hosts`), routeContext({}));
    expect(noToken.status).toBe(401);

    const wrongToken = await hostsRoute(
      get(`${ORIGIN}/api/plugins/hosts`, { authorization: "Bearer definitely-not-the-token" }),
      routeContext({}),
    );
    expect(wrongToken.status).toBe(401);

    const ingest = await credentialsRoute(
      new NextRequest(`${ORIGIN}/api/plugins/credentials`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer nope" },
        body: JSON.stringify({ host: "cookiesite.invalid", cookie: "cf_clearance=abc" }),
      }),
      routeContext({}),
    );
    expect(ingest.status).toBe(401);
  });

  it("stores a captured cookie against the plugin that claims the host", async () => {
    const admin = await createTestUser({ role: "admin" });
    dropInPlugin(pluginsDir(), {
      id: "cookie-source",
      hosts: ["cookiesite.invalid"],
      capabilities: ["network", "cookie"],
    });
    await scanPlugins();
    const { token: value } = await token(admin);

    const response = await credentialsRoute(
      new NextRequest(`${ORIGIN}/api/plugins/credentials`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${value}` },
        body: JSON.stringify({
          host: "CookieSite.invalid",
          // The volatile Cloudflare cookies must not survive the round trip.
          cookie: "cf_clearance=fresh; __cf_bm=volatile",
          userAgent: "Mozilla/5.0 (Test)",
        }),
      }),
      routeContext({}),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      pluginId: "cookie-source",
      host: "cookiesite.invalid",
    });

    const stored = await prisma.pluginCredential.findFirstOrThrow({
      where: { pluginId: "cookie-source" },
    });
    expect(stored.host).toBe("cookiesite.invalid");
    expect(stored.userAgent).toBe("Mozilla/5.0 (Test)");
    const { decryptSecret } = await import("@/lib/crypto");
    expect(decryptSecret(stored.cookieEnc as Uint8Array)).toBe("cf_clearance=fresh");
  });

  it("clears a NEEDS_CREDENTIAL flag on the plugin's waiting sources", async () => {
    const admin = await createTestUser({ role: "admin" });
    dropInPlugin(pluginsDir(), {
      id: "cookie-source",
      hosts: ["cookiesite.invalid"],
      capabilities: ["network", "cookie"],
    });
    await scanPlugins();

    const series = await prisma.series.create({
      data: { title: "Gated", sortTitle: "gated", createdById: admin.id },
    });
    await prisma.source.create({
      data: {
        seriesId: series.id,
        pluginId: "cookie-source",
        normalizedUrl: "https://cookiesite.invalid/series/gated/",
        status: "FAILED",
        lastErrorCode: "NEEDS_CREDENTIAL",
      },
    });

    const { token: value } = await token(admin);
    await credentialsRoute(
      new NextRequest(`${ORIGIN}/api/plugins/credentials`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${value}` },
        body: JSON.stringify({ host: "cookiesite.invalid", cookie: "cf_clearance=fresh" }),
      }),
      routeContext({}),
    );

    expect(await prisma.source.findUniqueOrThrow({ where: { seriesId: series.id } })).toMatchObject(
      {
        lastErrorCode: null,
      },
    );
  });

  it("404s an unknown host so the extension stops sending", async () => {
    const admin = await createTestUser({ role: "admin" });
    const { token: value } = await token(admin);

    const response = await credentialsRoute(
      new NextRequest(`${ORIGIN}/api/plugins/credentials`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${value}` },
        body: JSON.stringify({ host: "nobody-claims-this.invalid", cookie: "a=1" }),
      }),
      routeContext({}),
    );
    expect(response.status).toBe(404);
  });
});
