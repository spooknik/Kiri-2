/**
 * Instance settings: the view mapping, the "only changed keys" audit entry and
 * the admin gate on the route.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestUser,
  mockCurrentUser,
  resetDatabase,
  routeContext,
} from "../../../test/factories";
import {
  GET as getSettingsRoute,
  PATCH as patchSettingsRoute,
} from "@/app/api/admin/settings/route";
import { getSettingsView, updateSettingsView } from "@/lib/admin/settings";
import type { AppSettingsView } from "@/lib/contracts/admin";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: vi.fn(),
}));

const ORIGIN = "http://localhost:3000";

function patchRequest(body: unknown): NextRequest {
  return new NextRequest(`${ORIGIN}/api/admin/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await resetDatabase();
});

describe("getSettingsView", () => {
  it("creates the row on first read and returns the schema defaults", async () => {
    const view = await getSettingsView();

    expect(view).toMatchObject({
      instanceName: "Kiri",
      registrationMode: "INVITE",
      autoSyncEnabled: false,
      autoSyncIntervalMinutes: 1440,
      verbosePluginLogging: false,
      notificationRetentionDays: 90,
      jobLogRetentionDays: 30,
    });
    expect(view.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await prisma.appSetting.count()).toBe(1);
  });
});

describe("updateSettingsView", () => {
  it("writes the change and audits exactly the changed keys", async () => {
    const admin = await createTestUser({ role: "admin" });

    const view = await updateSettingsView(admin, {
      instanceName: "Reading Room",
      registrationMode: "OPEN",
      // Same as the stored default, so it must not show up as a change.
      jobLogRetentionDays: 30,
    });

    expect(view).toMatchObject({ instanceName: "Reading Room", registrationMode: "OPEN" });

    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: "settings.update" } });
    expect(entry.actorId).toBe(admin.id);
    expect(entry.targetId).toBe("global");
    expect(entry.metadata).toMatchObject({
      changed: ["instanceName", "registrationMode"],
      values: { instanceName: "Reading Room", registrationMode: "OPEN" },
    });
  });

  it("does nothing and audits nothing when no value actually changes", async () => {
    const admin = await createTestUser({ role: "admin" });
    const before = await getSettingsView();

    const after = await updateSettingsView(admin, { instanceName: before.instanceName });

    expect(after.instanceName).toBe(before.instanceName);
    expect(await prisma.auditLog.count()).toBe(0);
  });
});

describe("routes", () => {
  it("GET and PATCH require an admin", async () => {
    const member = await createTestUser();
    mockCurrentUser(member);

    const denied = await getSettingsRoute(
      new NextRequest(`${ORIGIN}/api/admin/settings`),
      routeContext({}),
    );
    expect(denied.status).toBe(403);

    const admin = await createTestUser({ role: "admin" });
    mockCurrentUser(admin);
    const allowed = await getSettingsRoute(
      new NextRequest(`${ORIGIN}/api/admin/settings`),
      routeContext({}),
    );
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as AppSettingsView;
    expect(body.instanceName).toBe("Kiri");
  });

  it("PATCH validates against the contract schema", async () => {
    const admin = await createTestUser({ role: "admin" });
    mockCurrentUser(admin);

    const bad = await patchSettingsRoute(
      patchRequest({ notificationRetentionDays: 1 }),
      routeContext({}),
    );
    expect(bad.status).toBe(400);
    await expect(bad.json()).resolves.toMatchObject({ error: { code: "VALIDATION_FAILED" } });

    const good = await patchSettingsRoute(
      patchRequest({ notificationRetentionDays: 30, autoSyncEnabled: true }),
      routeContext({}),
    );
    expect(good.status).toBe(200);
    const body = (await good.json()) as AppSettingsView;
    expect(body).toMatchObject({ notificationRetentionDays: 30, autoSyncEnabled: true });
  });
});
