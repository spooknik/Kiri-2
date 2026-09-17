/**
 * Admin invites: creation hands back the one-time URL, revocation is
 * idempotent-safe, and both leave an audit entry.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestUser,
  mockCurrentUser,
  resetDatabase,
  routeContext,
} from "../../../test/factories";
import { DELETE as deleteInviteRoute } from "@/app/api/admin/invites/[id]/route";
import { GET as listInvitesRoute, POST as createInviteRoute } from "@/app/api/admin/invites/route";
import { InviteStatus } from "@/generated/prisma/client";
import { createInviteView, listInviteViews, revokeInviteById } from "@/lib/admin/invites";
import type { InviteView } from "@/lib/contracts/admin";
import { hashInviteToken } from "@/lib/invites";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: vi.fn(),
}));

const ORIGIN = "http://localhost:3000";

function postRequest(body: unknown): NextRequest {
  return new NextRequest(`${ORIGIN}/api/admin/invites`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await resetDatabase();
});

describe("createInviteView", () => {
  it("returns a redeemable url and stores only the hash", async () => {
    const admin = await createTestUser({ role: "admin", displayName: "Owner" });

    const view = await createInviteView(admin, {
      email: "New.Member@Example.com",
      role: "member",
      expiresInDays: 14,
    });

    expect(view.url).toMatch(/^http:\/\/localhost:3000\/register\?invite=/);
    expect(view).toMatchObject({
      email: "new.member@example.com",
      role: "member",
      status: "PENDING",
      createdBy: { id: admin.id, displayName: "Owner" },
      redeemedBy: null,
    });
    expect(view.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const token = new URL(view.url ?? "").searchParams.get("invite") ?? "";
    const row = await prisma.invite.findUniqueOrThrow({ where: { id: view.id } });
    expect(row.tokenHash).toBe(hashInviteToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("audits the creation without the token", async () => {
    const admin = await createTestUser({ role: "admin" });

    const view = await createInviteView(admin, { email: null, role: "admin", expiresInDays: 3 });

    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: "invite.create" } });
    expect(entry.actorId).toBe(admin.id);
    expect(entry.targetId).toBe(view.id);
    expect(entry.metadata).toMatchObject({ role: "admin", email: null });
    expect(JSON.stringify(entry.metadata)).not.toContain("invite=");
  });
});

describe("listInviteViews", () => {
  it("joins creator and redeemer, newest first", async () => {
    const admin = await createTestUser({ role: "admin", displayName: "Owner" });
    const redeemer = await createTestUser({ displayName: "Redeemer" });

    const first = await createInviteView(admin, { email: null, role: "member", expiresInDays: 14 });
    const second = await createInviteView(admin, {
      email: "b@example.com",
      role: "member",
      expiresInDays: 14,
    });
    await prisma.invite.update({
      where: { id: first.id },
      data: {
        status: InviteStatus.ACCEPTED,
        redeemedById: redeemer.id,
        redeemedAt: new Date(),
      },
    });

    const views = await listInviteViews();

    expect(views.map((view) => view.id)).toEqual([second.id, first.id]);
    expect(views[1]).toMatchObject({
      status: "ACCEPTED",
      createdBy: { displayName: "Owner" },
      redeemedBy: { id: redeemer.id, displayName: "Redeemer" },
    });
    // The url is only ever returned by the POST that minted the invite.
    expect(views[0]?.url).toBeUndefined();
  });
});

describe("revokeInviteById", () => {
  it("revokes a pending invite and audits it", async () => {
    const admin = await createTestUser({ role: "admin" });
    const view = await createInviteView(admin, { email: null, role: "member", expiresInDays: 14 });

    await revokeInviteById(admin, view.id);

    const row = await prisma.invite.findUniqueOrThrow({ where: { id: view.id } });
    expect(row.status).toBe(InviteStatus.REVOKED);
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: "invite.revoke" } });
    expect(entry.targetId).toBe(view.id);
  });

  it("409s on a second revoke and 404s on an unknown id", async () => {
    const admin = await createTestUser({ role: "admin" });
    const view = await createInviteView(admin, { email: null, role: "member", expiresInDays: 14 });
    await revokeInviteById(admin, view.id);

    await expect(revokeInviteById(admin, view.id)).rejects.toMatchObject({ status: 409 });
    await expect(
      revokeInviteById(admin, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("routes", () => {
  it("POST returns the invite view with its url, GET lists it, DELETE is 204", async () => {
    const admin = await createTestUser({ role: "admin" });
    mockCurrentUser(admin);

    const created = await createInviteRoute(
      postRequest({ email: "invitee@example.com" }),
      routeContext({}),
    );
    expect(created.status).toBe(200);
    const view = (await created.json()) as InviteView;
    expect(view.url).toContain("/register?invite=");
    // The schema defaults fill in role and expiry.
    expect(view.role).toBe("member");

    const listed = await listInvitesRoute(
      new NextRequest(`${ORIGIN}/api/admin/invites`),
      routeContext({}),
    );
    const invites = (await listed.json()) as InviteView[];
    expect(invites.map((invite) => invite.id)).toEqual([view.id]);

    const deleted = await deleteInviteRoute(
      new NextRequest(`${ORIGIN}/api/admin/invites/${view.id}`, { method: "DELETE" }),
      routeContext({ id: view.id }),
    );
    expect(deleted.status).toBe(204);
    const row = await prisma.invite.findUniqueOrThrow({ where: { id: view.id } });
    expect(row.status).toBe(InviteStatus.REVOKED);
  });

  it("is closed to members", async () => {
    const member = await createTestUser();
    mockCurrentUser(member);

    const response = await createInviteRoute(postRequest({}), routeContext({}));

    expect(response.status).toBe(403);
    expect(await prisma.invite.count()).toBe(0);
  });
});
