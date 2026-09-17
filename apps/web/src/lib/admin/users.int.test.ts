/**
 * Admin user management: the self-protection and last-admin guard rails, and
 * the session revocation that makes a ban take effect immediately.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestUser,
  mockCurrentUser,
  resetDatabase,
  routeContext,
} from "../../../test/factories";
import { PATCH as patchUserRoute } from "@/app/api/admin/users/[id]/route";
import { GET as listUsersRoute } from "@/app/api/admin/users/route";
import { listAdminUsers, updateAdminUser } from "@/lib/admin/users";
import type { AdminUserView } from "@/lib/contracts/admin";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: vi.fn(),
}));

const ORIGIN = "http://localhost:3000";

async function seedSession(userId: string, token: string): Promise<void> {
  await prisma.session.create({
    data: { userId, token, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
}

function patchRequest(id: string, body: unknown): NextRequest {
  return new NextRequest(`${ORIGIN}/api/admin/users/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await resetDatabase();
});

describe("listAdminUsers", () => {
  it("orders by creation and carries the series counts", async () => {
    const admin = await createTestUser({ role: "admin", displayName: "Owner" });
    const member = await createTestUser({ displayName: "Member" });

    const series = await prisma.series.create({
      data: { title: "Solo Leveling", sortTitle: "solo leveling", createdById: admin.id },
    });
    await prisma.libraryEntry.create({
      data: { userId: member.id, seriesId: series.id, status: "READING" },
    });

    const users = await listAdminUsers();

    expect(users.map((user) => user.displayName)).toEqual(["Owner", "Member"]);
    expect(users[0]).toMatchObject({ role: "admin", seriesCreated: 1, seriesTracked: 0 });
    expect(users[1]).toMatchObject({ role: "member", seriesCreated: 0, seriesTracked: 1 });
  });
});

describe("updateAdminUser", () => {
  it("refuses to change your own role", async () => {
    const admin = await createTestUser({ role: "admin" });
    await createTestUser({ role: "admin" });

    await expect(updateAdminUser(admin, admin.id, { role: "member" })).rejects.toMatchObject({
      status: 400,
    });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(row.role).toBe("admin");
  });

  it("refuses to ban yourself", async () => {
    const admin = await createTestUser({ role: "admin" });
    await createTestUser({ role: "admin" });

    await expect(updateAdminUser(admin, admin.id, { banned: true })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("demotes one of two admins but refuses to demote the last one", async () => {
    const first = await createTestUser({ role: "admin" });
    const second = await createTestUser({ role: "admin" });

    const demoted = await updateAdminUser(second, first.id, { role: "member" });
    expect(demoted.role).toBe("member");

    // `second` is now the only admin left. (The admin gate on the actor lives
    // in the route; the library only guards the target.)
    await expect(updateAdminUser(first, second.id, { role: "member" })).rejects.toMatchObject({
      status: 400,
    });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: second.id } });
    expect(row.role).toBe("admin");
  });

  it("refuses to ban the last remaining admin", async () => {
    const admin = await createTestUser({ role: "admin" });
    const member = await createTestUser();

    await expect(updateAdminUser(member, admin.id, { banned: true })).rejects.toMatchObject({
      status: 400,
    });
    expect(await prisma.user.count({ where: { banned: true } })).toBe(0);
  });

  it("counts a banned admin as gone when guarding the last admin", async () => {
    const first = await createTestUser({ role: "admin" });
    const second = await createTestUser({ role: "admin" });
    await updateAdminUser(first, second.id, { banned: true });

    // Only `first` is an active admin now, so demoting them is refused.
    await expect(updateAdminUser(second, first.id, { role: "member" })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("promotes a member and records the role change", async () => {
    const admin = await createTestUser({ role: "admin" });
    const member = await createTestUser();

    const updated = await updateAdminUser(admin, member.id, { role: "admin" });

    expect(updated.role).toBe("admin");
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: "user.role" } });
    expect(entry.actorId).toBe(admin.id);
    expect(entry.targetId).toBe(member.id);
    expect(entry.metadata).toMatchObject({ from: "member", to: "admin" });
  });

  it("bans a member, revokes every session and audits it", async () => {
    const admin = await createTestUser({ role: "admin" });
    const member = await createTestUser();
    await seedSession(member.id, "member-session-1");
    await seedSession(member.id, "member-session-2");
    await seedSession(admin.id, "admin-session");

    const updated = await updateAdminUser(admin, member.id, {
      banned: true,
      banReason: "spamming notes",
    });

    expect(updated).toMatchObject({ banned: true, banReason: "spamming notes" });
    expect(await prisma.session.count({ where: { userId: member.id } })).toBe(0);
    // Other people stay signed in.
    expect(await prisma.session.count({ where: { userId: admin.id } })).toBe(1);

    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: "user.ban" } });
    expect(entry.targetId).toBe(member.id);
  });

  it("unbanning clears the reason and audits it", async () => {
    const admin = await createTestUser({ role: "admin" });
    const member = await createTestUser();
    await updateAdminUser(admin, member.id, { banned: true, banReason: "temporary" });

    const updated = await updateAdminUser(admin, member.id, { banned: false });

    expect(updated).toMatchObject({ banned: false, banReason: null });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: member.id } });
    expect(row.banExpires).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "user.unban" } })).toBe(1);
  });

  it("404s for an unknown user", async () => {
    const admin = await createTestUser({ role: "admin" });
    await expect(
      updateAdminUser(admin, "00000000-0000-4000-8000-000000000000", { role: "admin" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("routes", () => {
  it("GET is admin only", async () => {
    const member = await createTestUser();
    mockCurrentUser(member);

    const denied = await listUsersRoute(
      new NextRequest(`${ORIGIN}/api/admin/users`),
      routeContext({}),
    );
    expect(denied.status).toBe(403);

    const admin = await createTestUser({ role: "admin" });
    mockCurrentUser(admin);
    const allowed = await listUsersRoute(
      new NextRequest(`${ORIGIN}/api/admin/users`),
      routeContext({}),
    );
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as AdminUserView[];
    expect(body).toHaveLength(2);
  });

  it("PATCH surfaces the self-protection as a 400", async () => {
    const admin = await createTestUser({ role: "admin" });
    await createTestUser({ role: "admin" });
    mockCurrentUser(admin);

    const response = await patchUserRoute(
      patchRequest(admin.id, { role: "member" }),
      routeContext({ id: admin.id }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST", message: expect.stringContaining("your own role") },
    });
  });

  it("PATCH bans through the route and returns the updated view", async () => {
    const admin = await createTestUser({ role: "admin" });
    const member = await createTestUser();
    await seedSession(member.id, "doomed-session");
    mockCurrentUser(admin);

    const response = await patchUserRoute(
      patchRequest(member.id, { banned: true, banReason: "abuse" }),
      routeContext({ id: member.id }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as AdminUserView;
    expect(body).toMatchObject({ banned: true, banReason: "abuse" });
    expect(await prisma.session.count({ where: { userId: member.id } })).toBe(0);
  });
});
