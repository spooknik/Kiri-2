/**
 * POST /api/auth/set-password integration test.
 *
 * Exercises the real better-auth stack: a genuine DB-backed session cookie
 * (via `issueSession`) drives `auth.api.setPassword`'s own session lookup,
 * while `getCurrentUser` (the `withAuth` gate) is mocked per the pattern in
 * src/lib/auth/auth-flows.int.test.ts / test/factories.ts, matched to the
 * same user so both checks agree on who's calling.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestUser,
  mockCurrentUser,
  resetDatabase,
  routeContext,
} from "../../../../../test/factories";
import { cookieHeaderFrom } from "../../../../../test/db-helpers";
import { POST as authPost } from "@/app/api/auth/[...all]/route";
import { issueSession } from "@/lib/auth/session-cookie";
import { resetRateLimits } from "@/lib/rate-limit";
import { toSessionUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { POST as setPasswordRoute } from "./route";

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: vi.fn(),
}));

const ORIGIN = "http://localhost:3000";
const STRONG_PASSWORD = "correct-horse-battery";

/** What the V1 importer / Cloudflare Access bridge leaves behind. */
async function seedMustSetPasswordUser() {
  const user = await createTestUser();
  await prisma.user.update({ where: { id: user.id }, data: { mustSetPassword: true } });
  return { ...user, mustSetPassword: true };
}

async function callSetPassword(cookie: string, newPassword: string) {
  const response = await setPasswordRoute(
    new NextRequest(`${ORIGIN}/api/auth/set-password`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ newPassword }),
    }),
    routeContext({}),
  );
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { response, status: response.status, json };
}

async function signUp(email: string, password: string) {
  return authPost(
    new Request(`${ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "User", displayName: "User", email, password }),
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

beforeEach(async () => {
  await resetDatabase();
  // Auth endpoints share module-level rate-limit buckets; start each case full.
  resetRateLimits();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/auth/set-password", () => {
  it("lets a mustSetPassword user without a credential account set one, then sign in with it", async () => {
    const user = await seedMustSetPasswordUser();
    const issued = await issueSession(user.id);
    const cookie = issued.setCookie.split(";")[0] ?? "";
    mockCurrentUser(user);

    const result = await callSetPassword(cookie, "brand-new-secret");
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ ok: true });

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.mustSetPassword).toBe(false);

    const account = await prisma.account.findFirstOrThrow({
      where: { userId: user.id, providerId: "credential" },
    });
    expect(account.password).toBeTruthy();
    expect(account.password).not.toContain("brand-new-secret");

    const auditEntry = await prisma.auditLog.findFirstOrThrow({
      where: { actorId: user.id, action: "user.set_password" },
    });
    expect(auditEntry.targetId).toBe(user.id);

    // The new password works on the real sign-in endpoint.
    const signInResponse = await signIn(user.email, "brand-new-secret");
    expect(signInResponse.status).toBe(200);
  });

  it("refuses a user who already has a credential account", async () => {
    const email = "already-set@example.com";
    const signUpResult = await signUp(email, STRONG_PASSWORD);
    expect(signUpResult.status).toBe(200);
    const cookie = cookieHeaderFrom(signUpResult);
    const row = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(row.mustSetPassword).toBe(false);
    mockCurrentUser(toSessionUser(row));

    const result = await callSetPassword(cookie, "another-long-password");
    expect(result.status).toBe(403);
    expect(JSON.stringify(result.json)).toMatch(/change password/i);

    // Nothing about the existing credential changed.
    const account = await prisma.account.findFirstOrThrow({
      where: { userId: row.id, providerId: "credential" },
    });
    expect(account.password).toBeTruthy();
  });

  it("rejects a password shorter than the policy", async () => {
    const user = await seedMustSetPasswordUser();
    mockCurrentUser(user);

    const result = await callSetPassword("", "short");
    expect(result.status).toBe(400);

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.mustSetPassword).toBe(true);
  });
});
