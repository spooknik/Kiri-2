/**
 * Auth integration tests: sign-up gating, session resolution, invite claiming
 * and the Cloudflare Access bridge, all driven by calling the route handlers
 * with plain `Request` objects (no HTTP server).
 *
 * These live in one file on purpose. Vitest runs test *files* in parallel, and
 * every case here truncates the shared test database, so splitting them up
 * makes them race each other. Cases inside a file run sequentially.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";
import { cookieHeaderFrom, truncateAuthTables } from "../../../test/db-helpers";
import { InviteStatus, RegistrationMode } from "@/generated/prisma/client";
import { POST as authPost } from "@/app/api/auth/[...all]/route";
import { GET as cfBridge, resetCfJwksCache } from "@/app/api/auth/cf/route";
import { POST as claimInvite } from "@/app/api/auth/claim-invite/route";
import { getUserFromHeaders, toSessionUser } from "@/lib/auth/session";
import { issueSession } from "@/lib/auth/session-cookie";
import { AUTH_RATE_LIMITS } from "@/lib/auth/rate-limits";
import { resetEnvCache } from "@/lib/env";
import { resetRateLimits } from "@/lib/rate-limit";
import {
  createInvite,
  hashInviteToken,
  listInvites,
  revokeInvite,
  validateInviteToken,
} from "@/lib/invites";
import { prisma } from "@/lib/prisma";
import { updateAppSettings } from "@/lib/settings";

const ORIGIN = "http://localhost:3000";
const STRONG_PASSWORD = "correct-horse-battery";

interface SignUpBody {
  name: string;
  displayName: string;
  email: string;
  password: string;
  inviteToken?: string;
}

function member(email: string, extra: Partial<SignUpBody> = {}): SignUpBody {
  const local = email.split("@")[0] ?? email;
  return { name: local, displayName: local, email, password: STRONG_PASSWORD, ...extra };
}

async function signUp(body: SignUpBody) {
  const response = await authPost(
    new Request(`${ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { response, status: response.status, json, headers: response.headers };
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

/** Create the first (admin) account through the real sign-up endpoint. */
async function seedAdminBySignUp(email = "owner@example.com"): Promise<string> {
  const result = await signUp(member(email));
  expect(result.status).toBe(200);
  const admin = await prisma.user.findUniqueOrThrow({ where: { email } });
  return admin.id;
}

beforeEach(async () => {
  await truncateAuthTables();
  // Sign-in/sign-up are rate limited per email, per client and globally
  // (src/lib/auth/rate-limits.ts). The buckets live in module state, so a file
  // that drives dozens of auth requests has to start each case from full.
  resetRateLimits();
});

// ---------------------------------------------------------------------------
// Sign-up gating
// ---------------------------------------------------------------------------

describe("sign-up gating", () => {
  it("makes the very first account an admin", async () => {
    const result = await signUp(member("owner@example.com"));
    expect(result.status).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: "owner@example.com" } });
    expect(user.role).toBe("admin");
    expect(user.displayName).toBe("owner");
    expect(user.mustSetPassword).toBe(false);
    expect(result.headers.get("set-cookie")).toContain("better-auth.session_token=");
  });

  it("refuses a second account without an invite while registration is INVITE", async () => {
    await seedAdminBySignUp();

    const result = await signUp(member("intruder@example.com"));
    expect(result.status).toBe(403);
    expect(JSON.stringify(result.json)).toMatch(/invite only/i);
    expect(await prisma.user.count()).toBe(1);
  });

  it("accepts a valid invite, applies its role and marks it ACCEPTED", async () => {
    const adminId = await seedAdminBySignUp();
    const { token, invite } = await createInvite({ role: "admin", createdById: adminId });

    const result = await signUp(member("second@example.com", { inviteToken: token }));
    expect(result.status).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: "second@example.com" } });
    expect(user.role).toBe("admin");

    const redeemed = await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(redeemed.status).toBe(InviteStatus.ACCEPTED);
    expect(redeemed.redeemedById).toBe(user.id);
    expect(redeemed.redeemedAt).not.toBeNull();
  });

  it("refuses to reuse an invite", async () => {
    const adminId = await seedAdminBySignUp();
    const { token } = await createInvite({ createdById: adminId });

    expect((await signUp(member("first@example.com", { inviteToken: token }))).status).toBe(200);
    expect((await signUp(member("second@example.com", { inviteToken: token }))).status).toBe(403);
    expect(await prisma.user.count()).toBe(2);
  });

  it("refuses an expired invite", async () => {
    const adminId = await seedAdminBySignUp();
    const { token, invite } = await createInvite({ createdById: adminId });
    await prisma.invite.update({
      where: { id: invite.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const result = await signUp(member("late@example.com", { inviteToken: token }));
    expect(result.status).toBe(403);
    expect(JSON.stringify(result.json)).toMatch(/expired/i);
    const stored = await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(stored.status).toBe(InviteStatus.EXPIRED);
  });

  it("refuses a revoked invite", async () => {
    const adminId = await seedAdminBySignUp();
    const { token, invite } = await createInvite({ createdById: adminId });
    await prisma.invite.update({
      where: { id: invite.id },
      data: { status: InviteStatus.REVOKED },
    });

    const result = await signUp(member("nope@example.com", { inviteToken: token }));
    expect(result.status).toBe(403);
    expect(JSON.stringify(result.json)).toMatch(/revoked/i);
  });

  it("refuses an invite pinned to a different email", async () => {
    const adminId = await seedAdminBySignUp();
    const { token, invite } = await createInvite({
      email: "Pinned@Example.com",
      createdById: adminId,
    });
    expect(invite.email).toBe("pinned@example.com");

    const result = await signUp(member("someone-else@example.com", { inviteToken: token }));
    expect(result.status).toBe(403);
    expect(JSON.stringify(result.json)).toMatch(/different email/i);

    const stored = await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(stored.status).toBe(InviteStatus.PENDING);
  });

  it("refuses an unknown invite token", async () => {
    await seedAdminBySignUp();
    const result = await signUp(member("ghost@example.com", { inviteToken: "not-a-real-token" }));
    expect(result.status).toBe(403);
  });

  it("allows anyone through when registration is OPEN", async () => {
    await seedAdminBySignUp();
    await updateAppSettings({ registrationMode: RegistrationMode.OPEN });

    expect((await signUp(member("walkin@example.com"))).status).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "walkin@example.com" } });
    expect(user.role).toBe("member");
  });

  it("refuses everyone when registration is CLOSED, but honours a valid invite", async () => {
    const adminId = await seedAdminBySignUp();
    await updateAppSettings({ registrationMode: RegistrationMode.CLOSED });

    expect((await signUp(member("walkin@example.com"))).status).toBe(403);

    const { token } = await createInvite({ createdById: adminId });
    expect((await signUp(member("invited@example.com", { inviteToken: token }))).status).toBe(200);
  });

  it("stores only the hash of the invite token", async () => {
    const adminId = await seedAdminBySignUp();
    const { token, invite } = await createInvite({ createdById: adminId });
    expect(invite.tokenHash).toBe(hashInviteToken(token));
    expect(invite.tokenHash).not.toContain(token);
    expect(token.length).toBeGreaterThan(20);
  });

  it("refuses a sign-up that tries to set profile fields directly", async () => {
    // showAdult / mustSetPassword / role are declared `input: false`, so
    // better-auth rejects the request rather than silently dropping them.
    for (const smuggled of [{ showAdult: true }, { mustSetPassword: true }, { role: "admin" }]) {
      const result = await signUp({
        ...member("owner@example.com"),
        ...(smuggled as Partial<SignUpBody>),
      });
      expect(result.status).toBe(400);
      expect(JSON.stringify(result.json)).toMatch(/not allowed to be set/i);
    }
    expect(await prisma.user.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Invite lifecycle
// ---------------------------------------------------------------------------

describe("invites", () => {
  it("creates a link under PUBLIC_URL and lists newest first", async () => {
    const adminId = await seedAdminBySignUp();
    const first = await createInvite({ createdById: adminId });
    const second = await createInvite({ email: "b@example.com", createdById: adminId });

    expect(first.url).toBe(`${ORIGIN}/register?invite=${encodeURIComponent(first.token)}`);

    const listed = await listInvites();
    expect(listed.map((i) => i.id)).toEqual([second.invite.id, first.invite.id]);
  });

  it("clamps the expiry and defaults to the member role", async () => {
    const adminId = await seedAdminBySignUp();
    const { invite } = await createInvite({ createdById: adminId, expiresInDays: 100_000 });
    expect(invite.role).toBe("member");
    const days = (invite.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThan(366);
  });

  it("revokes a pending invite and refuses to revoke it twice", async () => {
    const adminId = await seedAdminBySignUp();
    const { token, invite } = await createInvite({ createdById: adminId });

    const revoked = await revokeInvite(invite.id);
    expect(revoked?.status).toBe(InviteStatus.REVOKED);
    expect(await revokeInvite(invite.id)).toBeNull();

    const validation = await validateInviteToken(token);
    expect(validation.ok).toBe(false);
  });

  it("rejects a pinned invite validated against the wrong email", async () => {
    const adminId = await seedAdminBySignUp();
    const { token } = await createInvite({ email: "pinned@example.com", createdById: adminId });

    expect((await validateInviteToken(token, "pinned@example.com")).ok).toBe(true);
    const wrong = await validateInviteToken(token, "other@example.com");
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toBe("EMAIL_MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// Session resolution
// ---------------------------------------------------------------------------

describe("getUserFromHeaders", () => {
  async function signUpAda() {
    const result = await signUp({
      name: "Ada",
      displayName: "Ada L",
      email: "ada@example.com",
      password: STRONG_PASSWORD,
    });
    expect(result.status).toBe(200);
    return cookieHeaderFrom(result.response);
  }

  it("returns null without a cookie", async () => {
    expect(await getUserFromHeaders(new Headers())).toBeNull();
  });

  it("returns null for a forged cookie", async () => {
    await signUpAda();
    const headers = new Headers({ cookie: "better-auth.session_token=nonsense.deadbeef" });
    expect(await getUserFromHeaders(headers)).toBeNull();
  });

  it("maps the better-auth session onto a SessionUser", async () => {
    const cookie = await signUpAda();
    const user = await getUserFromHeaders(new Headers({ cookie }));

    expect(user).toEqual({
      id: expect.any(String),
      email: "ada@example.com",
      displayName: "Ada L",
      role: "admin",
      showAdult: false,
      showSpoilers: false,
      mustSetPassword: false,
    });
  });

  it("accepts a cookie minted by issueSession", async () => {
    await signUpAda();
    const stored = await prisma.user.findUniqueOrThrow({ where: { email: "ada@example.com" } });
    const issued = await issueSession(stored.id);
    expect(issued.cookieName).toBe("better-auth.session_token");

    const cookie = issued.setCookie.split(";")[0] ?? "";
    const user = await getUserFromHeaders(new Headers({ cookie }));
    expect(user?.id).toBe(stored.id);
    expect(user?.role).toBe("admin");
  });
});

describe("toSessionUser", () => {
  it("falls back to name and then email for the display name", () => {
    expect(
      toSessionUser({ id: "1", email: "a@b.c", name: "Nom", displayName: null }).displayName,
    ).toBe("Nom");
    expect(toSessionUser({ id: "1", email: "a@b.c" }).displayName).toBe("a@b.c");
  });

  it("treats any role other than admin as member", () => {
    expect(toSessionUser({ id: "1", email: "a@b.c", role: "superuser" }).role).toBe("member");
    expect(toSessionUser({ id: "1", email: "a@b.c", role: "admin" }).role).toBe("admin");
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("credential endpoint rate limiting", () => {
  it("locks one email out after repeated failures, leaving others alone", async () => {
    const adminId = await seedAdminBySignUp("victim@example.com");
    const { token } = await createInvite({ role: "member", createdById: adminId });
    expect((await signUp(member("bystander@example.com", { inviteToken: token }))).status).toBe(
      200,
    );

    for (let attempt = 0; attempt < AUTH_RATE_LIMITS.identity.capacity; attempt += 1) {
      const response = await signIn("victim@example.com", "not-the-password");
      expect(response.status).not.toBe(429);
    }

    const denied = await signIn("victim@example.com", "not-the-password");
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(JSON.stringify(await denied.json().catch(() => null))).toMatch(/too many/i);

    // A different account is unaffected: the per-email bucket is what ran out,
    // and the shared client/global buckets are far from empty.
    expect((await signIn("bystander@example.com", STRONG_PASSWORD)).status).toBe(200);
  });

  it("refuses the correct password too once the bucket is empty", async () => {
    await seedAdminBySignUp("owner@example.com");

    for (let attempt = 0; attempt < AUTH_RATE_LIMITS.identity.capacity; attempt += 1) {
      await signIn("owner@example.com", "not-the-password");
    }

    // Not a "wrong password" 401: the request never reaches the credential check.
    expect((await signIn("owner@example.com", STRONG_PASSWORD)).status).toBe(429);
  });

  it("limits sign-up separately from sign-in", async () => {
    await seedAdminBySignUp("owner@example.com");

    for (let attempt = 0; attempt < AUTH_RATE_LIMITS.identity.capacity; attempt += 1) {
      await signIn("owner@example.com", "not-the-password");
    }

    // Sign-in for that address is exhausted, but the sign-up bucket is its own.
    expect((await signIn("owner@example.com", STRONG_PASSWORD)).status).toBe(429);
    expect((await signUp(member("owner@example.com"))).status).not.toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Claiming an invite for a V1-imported account
// ---------------------------------------------------------------------------

describe("POST /api/auth/claim-invite", () => {
  const IMPORTED_PASSWORD = "imported-user-secret";

  /** What the V1 importer leaves behind: a user with no credential account. */
  async function seedImportedUser(email: string) {
    return prisma.user.create({
      data: { email, name: "Legacy", displayName: "Legacy Reader", mustSetPassword: true },
    });
  }

  async function claim(token: string, password: string) {
    const response = await claimInvite(
      new NextRequest(`${ORIGIN}/api/auth/claim-invite`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      }),
      { params: Promise.resolve({}) },
    );
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { response, status: response.status, json };
  }

  it("sets the password on the imported user and signs them in", async () => {
    const adminId = await seedAdminBySignUp();
    const legacy = await seedImportedUser("legacy@example.com");
    const { token, invite } = await createInvite({
      email: "legacy@example.com",
      role: "member",
      createdById: adminId,
    });

    const result = await claim(token, IMPORTED_PASSWORD);
    expect(result.status).toBe(200);

    // No duplicate user.
    expect(await prisma.user.count({ where: { email: "legacy@example.com" } })).toBe(1);
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(updated.mustSetPassword).toBe(false);

    // Credential account created with a hash, not the plaintext.
    const account = await prisma.account.findFirstOrThrow({
      where: { userId: legacy.id, providerId: "credential" },
    });
    expect(account.password).toBeTruthy();
    expect(account.password).not.toContain(IMPORTED_PASSWORD);

    // Invite consumed and attributed.
    const redeemed = await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(redeemed.status).toBe(InviteStatus.ACCEPTED);
    expect(redeemed.redeemedById).toBe(legacy.id);

    // The response carries a usable session.
    const sessionUser = await getUserFromHeaders(
      new Headers({ cookie: cookieHeaderFrom(result.response) }),
    );
    expect(sessionUser?.id).toBe(legacy.id);
    expect(sessionUser?.displayName).toBe("Legacy Reader");

    // And the new password works on the normal sign-in endpoint.
    expect((await signIn("legacy@example.com", IMPORTED_PASSWORD)).status).toBe(200);
  });

  it("applies the invite role", async () => {
    const adminId = await seedAdminBySignUp();
    await seedImportedUser("promoted@example.com");
    const { token } = await createInvite({
      email: "promoted@example.com",
      role: "admin",
      createdById: adminId,
    });

    expect((await claim(token, IMPORTED_PASSWORD)).status).toBe(200);
    const updated = await prisma.user.findUniqueOrThrow({
      where: { email: "promoted@example.com" },
    });
    expect(updated.role).toBe("admin");
  });

  it("rejects a second claim with the same token", async () => {
    const adminId = await seedAdminBySignUp();
    await seedImportedUser("legacy@example.com");
    const { token } = await createInvite({ email: "legacy@example.com", createdById: adminId });

    expect((await claim(token, IMPORTED_PASSWORD)).status).toBe(200);
    const second = await claim(token, "another-long-password");
    expect(second.status).toBe(400);
    expect(JSON.stringify(second.json)).toMatch(/already been used/i);
  });

  it("rejects a password shorter than the policy", async () => {
    const adminId = await seedAdminBySignUp();
    await seedImportedUser("legacy@example.com");
    const { token } = await createInvite({ email: "legacy@example.com", createdById: adminId });

    const result = await claim(token, "short");
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.json)).toMatch(/at least 10/i);
  });

  it("rejects an account that already has a password", async () => {
    const adminId = await seedAdminBySignUp();
    const { token } = await createInvite({ email: "owner@example.com", createdById: adminId });

    expect((await claim(token, IMPORTED_PASSWORD)).status).toBe(409);
  });

  it("rejects an invite that is not pinned to an address", async () => {
    const adminId = await seedAdminBySignUp();
    const { token } = await createInvite({ createdById: adminId });

    const result = await claim(token, IMPORTED_PASSWORD);
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.json)).toMatch(/sign-up form/i);
  });

  it("rejects an unknown token", async () => {
    await seedAdminBySignUp();
    expect((await claim("nope", IMPORTED_PASSWORD)).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Cloudflare Access bridge
// ---------------------------------------------------------------------------

describe("GET /api/auth/cf", () => {
  const TEAM = "kiri-test.cloudflareaccess.com";
  const AUD = "aud-fixture-0123456789";
  const JWKS_URL = `https://${TEAM}/cdn-cgi/access/certs`;
  const savedEnv = { ...process.env };

  let privateKey: CryptoKey;
  let jwks: { keys: unknown[] };

  async function mintToken(overrides: { email?: string; audience?: string; issuer?: string } = {}) {
    return new SignJWT({ email: overrides.email ?? "cf-user@example.com" })
      .setProtectedHeader({ alg: "ES256", kid: "test-key" })
      .setIssuedAt()
      .setIssuer(overrides.issuer ?? `https://${TEAM}`)
      .setAudience(overrides.audience ?? AUD)
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  function call(init: { token?: string; emailHeader?: string; next?: string } = {}) {
    const headers = new Headers();
    if (init.token) headers.set("cf-access-jwt-assertion", init.token);
    if (init.emailHeader) headers.set("cf-access-authenticated-user-email", init.emailHeader);
    const suffix = init.next ? `?next=${encodeURIComponent(init.next)}` : "";
    return cfBridge(new Request(`${ORIGIN}/api/auth/cf${suffix}`, { headers }));
  }

  async function seedAdminRow(email = "owner@example.com") {
    return prisma.user.create({
      data: { email, name: "Owner", displayName: "Owner", role: "admin" },
    });
  }

  beforeEach(async () => {
    resetCfJwksCache();
    const pair = await generateKeyPair("ES256", { extractable: true });
    privateKey = pair.privateKey;
    jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "ES256" }] };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url === JWKS_URL) {
          return new Response(JSON.stringify(jwks), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    process.env.AUTH_CF_ACCESS = "1";
    process.env.CF_ACCESS_TEAM_DOMAIN = TEAM;
    process.env.CF_ACCESS_AUD = AUD;
    delete process.env.AUTH_CF_TRUST_HEADER;
    resetEnvCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...savedEnv };
    resetEnvCache();
  });

  it("is disabled unless AUTH_CF_ACCESS=1", async () => {
    process.env.AUTH_CF_ACCESS = "0";
    resetEnvCache();
    expect((await call({ token: await mintToken() })).status).toBe(404);
  });

  it("signs in an existing user from a verified assertion", async () => {
    const user = await seedAdminRow("cf-user@example.com");
    const response = await call({ token: await mintToken(), next: "/series/42" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/series/42`);

    const sessionUser = await getUserFromHeaders(
      new Headers({ cookie: cookieHeaderFrom(response) }),
    );
    expect(sessionUser?.id).toBe(user.id);
    expect(sessionUser?.role).toBe("admin");
  });

  it("rejects an assertion minted for another audience", async () => {
    await seedAdminRow("cf-user@example.com");
    const response = await call({ token: await mintToken({ audience: "some-other-aud" }) });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects an assertion from another issuer", async () => {
    await seedAdminRow("cf-user@example.com");
    const response = await call({ token: await mintToken({ issuer: "https://evil.example.com" }) });
    expect(response.status).toBe(401);
  });

  it("rejects a request with no assertion", async () => {
    await seedAdminRow("cf-user@example.com");
    expect((await call()).status).toBe(401);
  });

  it("accepts the assertion from the CF_Authorization cookie", async () => {
    const user = await seedAdminRow("cf-user@example.com");
    const token = await mintToken();
    const response = await cfBridge(
      new Request(`${ORIGIN}/api/auth/cf`, { headers: { cookie: `CF_Authorization=${token}` } }),
    );
    expect(response.status).toBe(302);
    const sessionUser = await getUserFromHeaders(
      new Headers({ cookie: cookieHeaderFrom(response) }),
    );
    expect(sessionUser?.id).toBe(user.id);
  });

  it("does not trust the email header unless AUTH_CF_TRUST_HEADER=1", async () => {
    delete process.env.CF_ACCESS_TEAM_DOMAIN;
    delete process.env.CF_ACCESS_AUD;
    resetEnvCache();
    await seedAdminRow("cf-user@example.com");

    expect((await call({ emailHeader: "cf-user@example.com" })).status).toBe(401);

    // Header mode is refused outright unless the public origin is https
    // (src/lib/env.ts): the header is only trustworthy behind an https edge.
    process.env.AUTH_CF_TRUST_HEADER = "1";
    process.env.PUBLIC_URL = "https://kiri.example.com";
    resetEnvCache();
    expect((await call({ emailHeader: "CF-User@Example.com" })).status).toBe(302);
  });

  it("makes the very first Cloudflare identity the admin", async () => {
    expect((await call({ token: await mintToken() })).status).toBe(302);
    const created = await prisma.user.findUniqueOrThrow({
      where: { email: "cf-user@example.com" },
    });
    expect(created.role).toBe("admin");
    expect(created.displayName).toBe("cf-user");
  });

  it("refuses to provision an unknown identity while registration is INVITE", async () => {
    await seedAdminRow();
    expect((await call({ token: await mintToken() })).status).toBe(403);
    expect(await prisma.user.count({ where: { email: "cf-user@example.com" } })).toBe(0);
  });

  it("provisions an unknown identity that has a pending pinned invite", async () => {
    const admin = await seedAdminRow();
    const { invite } = await createInvite({
      email: "cf-user@example.com",
      role: "admin",
      createdById: admin.id,
    });

    expect((await call({ token: await mintToken() })).status).toBe(302);

    const created = await prisma.user.findUniqueOrThrow({
      where: { email: "cf-user@example.com" },
    });
    expect(created.role).toBe("admin");
    const redeemed = await prisma.invite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(redeemed.status).toBe(InviteStatus.ACCEPTED);
    expect(redeemed.redeemedById).toBe(created.id);
  });

  it("provisions an unknown identity while registration is OPEN", async () => {
    await seedAdminRow();
    await updateAppSettings({ registrationMode: RegistrationMode.OPEN });

    expect((await call({ token: await mintToken() })).status).toBe(302);
    const created = await prisma.user.findUniqueOrThrow({
      where: { email: "cf-user@example.com" },
    });
    expect(created.role).toBe("member");
  });

  it("refuses a banned user", async () => {
    await prisma.user.create({
      data: {
        email: "cf-user@example.com",
        name: "Banned",
        displayName: "Banned",
        banned: true,
        banReason: "spam",
      },
    });
    expect((await call({ token: await mintToken() })).status).toBe(403);
  });
});
