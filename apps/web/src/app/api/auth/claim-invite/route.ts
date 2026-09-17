/**
 * Set a password on an account that was imported from Kiri V1.
 *
 * V1 had no passwords, so the importer creates users with
 * `mustSetPassword = true` and no credential `Account` row, plus one invite
 * pinned to their address. Running that through the normal sign-up endpoint
 * would fail with "user already exists", so this route redeems the invite
 * against the *existing* user instead of creating a second one.
 *
 * better-auth pieces used (all from `auth.$context`):
 * - `password.hash` / `password.config.minPasswordLength` — same hashing and
 *   policy as `/sign-up/email`, so the credential works with `/sign-in/email`.
 * - `internalAdapter.findUserByEmail` / `findCredentialAccount` / `linkAccount`.
 * - `internalAdapter.createSession` via src/lib/auth/session-cookie.ts.
 *
 * Unauthenticated and credential-setting, so it is rate limited (per invite
 * token and per client) and goes through `withPublic`, which caps the request
 * body like every other JSON route.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { InviteStatus } from "@/generated/prisma/client";
import { withPublic } from "@/lib/api";
import { limitAuthAttempt } from "@/lib/auth/rate-limits";
import { normalizeRole } from "@/lib/auth/registration";
import { auth } from "@/lib/auth/server";
import { issueSession } from "@/lib/auth/session-cookie";
import { consumeInvite, hashInviteToken, normalizeEmail, validateInviteToken } from "@/lib/invites";
import { prisma } from "@/lib/prisma";
import { rateLimitedResponse } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  token: z.string().min(1),
  password: z.string().min(1),
});

function fail(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

export const POST = withPublic({ body: bodySchema }, async ({ req, body }) => {
  // Keyed on the token *hash* so the raw token never becomes a bucket name,
  // plus the usual per-client and global buckets.
  const limit = limitAuthAttempt({
    scope: "/claim-invite",
    subject: hashInviteToken(body.token),
    headers: req.headers,
  });
  if (!limit.allowed) {
    return rateLimitedResponse(limit.retryAfterMs);
  }

  const validation = await validateInviteToken(body.token);
  if (!validation.ok) {
    return fail(400, `INVITE_${validation.reason}`, validation.message);
  }
  const invite = validation.invite;
  if (!invite.email) {
    return fail(
      400,
      "INVITE_NOT_CLAIMABLE",
      "This invite is not tied to an existing account. Use the sign-up form instead.",
    );
  }

  const ctx = await auth.$context;
  const minLength = ctx.password.config.minPasswordLength;
  if (body.password.length < minLength) {
    return fail(
      400,
      "PASSWORD_TOO_SHORT",
      `Password must be at least ${minLength} characters long.`,
    );
  }

  const email = normalizeEmail(invite.email);
  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    return fail(
      404,
      "NO_ACCOUNT",
      "No imported account matches this invite. Use the sign-up form instead.",
    );
  }
  if (!existing.mustSetPassword) {
    return fail(
      409,
      "PASSWORD_ALREADY_SET",
      "This account already has a password. Sign in instead.",
    );
  }
  const credential = await ctx.internalAdapter.findCredentialAccount(existing.id);
  if (credential?.password) {
    return fail(
      409,
      "PASSWORD_ALREADY_SET",
      "This account already has a password. Sign in instead.",
    );
  }

  // Burn the invite before touching credentials so a replayed request cannot
  // set the password twice.
  if (!(await consumeInvite(invite.id, existing.id))) {
    return fail(409, "INVITE_ALREADY_USED", "This invite has already been used.");
  }

  const hash = await ctx.password.hash(body.password);
  if (credential) {
    await ctx.internalAdapter.updateAccount(credential.id, { password: hash });
  } else {
    await ctx.internalAdapter.linkAccount({
      userId: existing.id,
      providerId: "credential",
      accountId: existing.id,
      password: hash,
    });
  }
  const user = await prisma.user.update({
    where: { id: existing.id },
    data: { mustSetPassword: false, role: normalizeRole(invite.role) },
  });
  await prisma.invite.updateMany({
    where: { id: invite.id, status: InviteStatus.ACCEPTED },
    data: { redeemedById: user.id },
  });

  const session = await issueSession(user.id, req);
  const response = NextResponse.json({
    ok: true,
    user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
  });
  response.headers.append("set-cookie", session.setCookie);
  return response;
});
