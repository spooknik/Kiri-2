/**
 * Audit trail: recording, the actor join, cursor pagination and the admin-only
 * listing route.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestUser, mockCurrentUser, resetDatabase, routeContext } from "../../test/factories";
import { GET as auditRoute } from "@/app/api/admin/audit/route";
import { AUDIT_ACTIONS, listAudit, recordAudit } from "@/lib/audit";
import type { AuditPage } from "@/lib/contracts/admin";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: vi.fn(),
}));

const ORIGIN = "http://localhost:3000";
const BASE = new Date("2026-02-01T00:00:00.000Z").getTime();

async function seedEntry(actorId: string | null, index: number): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId,
      action: AUDIT_ACTIONS.settingsUpdate,
      targetType: "settings",
      targetId: "global",
      metadata: { changed: [`key${index}`] },
      createdAt: new Date(BASE + index * 60_000),
    },
  });
}

beforeEach(async () => {
  await resetDatabase();
});

describe("recordAudit", () => {
  it("stores the actor, target and metadata", async () => {
    const admin = await createTestUser({ role: "admin", displayName: "Owner" });

    await recordAudit({
      actorId: admin.id,
      action: AUDIT_ACTIONS.userRole,
      targetType: "user",
      targetId: admin.id,
      metadata: { from: "member", to: "admin" },
    });

    const page = await listAudit({ limit: 50 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      action: "user.role",
      targetType: "user",
      targetId: admin.id,
      actor: { id: admin.id, displayName: "Owner" },
      metadata: { from: "member", to: "admin" },
    });
    expect(page.items[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("defaults metadata to an object and tolerates a system actor", async () => {
    await recordAudit({ actorId: null, action: "system.boot", targetType: "instance" });

    const page = await listAudit({ limit: 50 });
    expect(page.items[0]).toMatchObject({ actor: null, targetId: null, metadata: {} });
  });

  it("never throws when the write fails", async () => {
    await expect(
      recordAudit({
        actorId: "00000000-0000-4000-8000-000000000000",
        action: "user.role",
        targetType: "user",
      }),
    ).resolves.toBeUndefined();
    expect(await prisma.auditLog.count()).toBe(0);
  });
});

describe("listAudit", () => {
  it("pages newest first", async () => {
    const admin = await createTestUser({ role: "admin" });
    for (let i = 1; i <= 5; i += 1) await seedEntry(admin.id, i);

    const first = await listAudit({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.items[0]?.metadata).toMatchObject({ changed: ["key5"] });
    expect(first.nextCursor).toBeTruthy();

    const second = await listAudit({ limit: 2, cursor: first.nextCursor ?? "" });
    expect(second.items[0]?.metadata).toMatchObject({ changed: ["key3"] });

    const third = await listAudit({ limit: 5, cursor: second.nextCursor ?? "" });
    expect(third.items).toHaveLength(1);
    expect(third.nextCursor).toBeNull();
  });

  it("rejects a cursor it did not mint", async () => {
    await expect(listAudit({ limit: 50, cursor: "%%%" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("route", () => {
  it("is admin only and honours the limit", async () => {
    const admin = await createTestUser({ role: "admin" });
    for (let i = 1; i <= 3; i += 1) await seedEntry(admin.id, i);

    const member = await createTestUser();
    mockCurrentUser(member);
    const denied = await auditRoute(new NextRequest(`${ORIGIN}/api/admin/audit`), routeContext({}));
    expect(denied.status).toBe(403);

    mockCurrentUser(admin);
    const response = await auditRoute(
      new NextRequest(`${ORIGIN}/api/admin/audit?limit=2`),
      routeContext({}),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as AuditPage;
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBeTruthy();
  });
});
