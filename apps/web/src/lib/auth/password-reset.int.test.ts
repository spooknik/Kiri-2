/**
 * Password reset links: the admin route, the container-CLI route, and
 * redemption through better-auth's own `/api/auth/reset-password`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestUser,
  mockCurrentUser,
  resetDatabase,
  routeContext,
} from "../../../test/factories";
import { POST as adminReset } from "@/app/api/admin/users/[id]/password-reset/route";
import { POST as authPost } from "@/app/api/auth/[...all]/route";
import { POST as cliReset } from "@/app/api/cli/password-reset/route";
import { AUDIT_ACTIONS } from "@/lib/audit";
import { CLI_SIGNATURE_HEADER, signCliRequest } from "@/lib/auth/cli-signature";
import { RESET_PASSWORD_PREFIX } from "@/lib/auth/reset-token";
import { getEnv } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { resetRateLimits } from "@/lib/rate-limit";

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: vi.fn(),
}));

const ORIGIN = "http://localhost:3000";
const NEW_PASSWORD = "brand-new-password-123";

function tokenFrom(url: string): string {
  return new URL(url).searchParams.get("token") ?? "";
}

async function issueAsAdmin(adminId: string, targetId: string) {
  const admin = await prisma.user.findUniqueOrThrow({ where: { id: adminId } });
  mockCurrentUser({
    id: admin.id,
    email: admin.email,
    displayName: admin.displayName,
    role: "admin",
    showAdult: false,
    showSpoilers: false,
    mustSetPassword: false,
  });
  return adminReset(
    new NextRequest(`${ORIGIN}/api/admin/users/${targetId}/password-reset`, { method: "POST" }),
    routeContext({ id: targetId }),
  );
}

async function redeem(token: string, newPassword = NEW_PASSWORD) {
  return authPost(
    new Request(`${ORIGIN}/api/auth/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, newPassword }),
    }),
  );
}

async function signIn(email: string, password: string) {
  return authPost(
    new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
}

function cliRequest(body: string, signature: string | null) {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature) headers.set(CLI_SIGNATURE_HEADER, signature);
  return new NextRequest(`${ORIGIN}/api/cli/password-reset`, { method: "POST", headers, body });
}

beforeEach(async () => {
  await resetDatabase();
  resetRateLimits();
});

describe("admin password reset", () => {
  it("issues a link that sets a password, clears mustSetPassword and signs the user out", async () => {
    const admin = await createTestUser({ role: "admin" });
    const target = await createTestUser();
    await prisma.user.update({ where: { id: target.id }, data: { mustSetPassword: true } });
    await prisma.session.create({
      data: { token: "old-session", userId: target.id, expiresAt: new Date(Date.now() + 60_000) },
    });

    const response = await issueAsAdmin(admin.id, target.id);
    expect(response.status).toBe(200);
    const { url } = (await response.json()) as { url: string; expiresAt: string };
    const token = tokenFrom(url);
    expect(url).toContain("/reset-password?token=");

    // Only a hash is stored.
    const rows = await prisma.verification.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.identifier.startsWith(RESET_PASSWORD_PREFIX)).toBe(true);
    expect(rows[0]!.identifier).not.toContain(token);

    expect((await redeem(token)).status).toBe(200);
    expect(await prisma.session.count({ where: { userId: target.id } })).toBe(0);
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(updated.mustSetPassword).toBe(false);
    expect((await signIn(target.email, NEW_PASSWORD)).status).toBe(200);

    // Single use.
    expect((await redeem(token, "another-password-456")).status).toBe(400);

    const actions = (await prisma.auditLog.findMany()).map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([AUDIT_ACTIONS.passwordResetIssue, AUDIT_ACTIONS.passwordReset]),
    );
  });

  it("replaces an earlier link when a new one is issued", async () => {
    const admin = await createTestUser({ role: "admin" });
    const target = await createTestUser();

    const first = tokenFrom(
      ((await (await issueAsAdmin(admin.id, target.id)).json()) as { url: string }).url,
    );
    const second = tokenFrom(
      ((await (await issueAsAdmin(admin.id, target.id)).json()) as { url: string }).url,
    );

    expect((await redeem(first)).status).toBe(400);
    expect((await redeem(second)).status).toBe(200);
  });

  it("refuses an admin's own account", async () => {
    const admin = await createTestUser({ role: "admin" });
    const response = await issueAsAdmin(admin.id, admin.id);
    expect(response.status).toBe(400);
    expect(await prisma.verification.count()).toBe(0);
  });

  it("is admin only", async () => {
    const memberUser = await createTestUser();
    const target = await createTestUser();
    mockCurrentUser(memberUser);
    const response = await adminReset(
      new NextRequest(`${ORIGIN}/api/admin/users/${target.id}/password-reset`, { method: "POST" }),
      routeContext({ id: target.id }),
    );
    expect(response.status).toBe(403);
  });
});

describe("CLI password reset", () => {
  it("issues a link for any account, admins included, with a valid signature", async () => {
    const admin = await createTestUser({ role: "admin", email: "owner@example.com" });
    const body = JSON.stringify({ email: "Owner@Example.com" });
    const signature = signCliRequest(getEnv().APP_SECRET, Math.floor(Date.now() / 1000), body);

    const response = await cliReset(cliRequest(body, signature), routeContext({}));
    expect(response.status).toBe(200);
    const json = (await response.json()) as { email: string; url: string };
    expect(json.email).toBe("owner@example.com");

    expect((await redeem(tokenFrom(json.url))).status).toBe(200);
    expect((await signIn(admin.email, NEW_PASSWORD)).status).toBe(200);
  });

  it("rejects a missing or wrong signature", async () => {
    await createTestUser({ email: "owner@example.com" });
    const body = JSON.stringify({ email: "owner@example.com" });
    const now = Math.floor(Date.now() / 1000);

    expect((await cliReset(cliRequest(body, null), routeContext({}))).status).toBe(401);
    const forged = signCliRequest("some-other-secret-that-is-long-enough!!", now, body);
    expect((await cliReset(cliRequest(body, forged), routeContext({}))).status).toBe(401);
    expect(await prisma.verification.count()).toBe(0);
  });

  it("404s an unknown email", async () => {
    const body = JSON.stringify({ email: "nobody@example.com" });
    const signature = signCliRequest(getEnv().APP_SECRET, Math.floor(Date.now() / 1000), body);
    expect((await cliReset(cliRequest(body, signature), routeContext({}))).status).toBe(404);
  });
});
