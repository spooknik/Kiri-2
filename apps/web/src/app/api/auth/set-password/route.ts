/**
 * POST /api/auth/set-password — give the signed-in user their first
 * password.
 *
 * V1 imports and users provisioned by the Cloudflare Access bridge have
 * `mustSetPassword = true` and no credential `Account` row. better-auth's
 * browser-exposed `changePassword` (`POST /api/auth/change-password`) always
 * requires `currentPassword` and 400s `CREDENTIAL_ACCOUNT_NOT_FOUND` for
 * them; the endpoint that doesn't need one —
 * `setPassword` (`node_modules/better-auth/dist/api/routes/update-user.mjs`)
 * — is declared `createAuthEndpoint.serverOnly`, so it's reachable only
 * through `auth.api.setPassword` from server code, never the browser client.
 *
 * `auth.api.setPassword` already resolves the caller from the request itself
 * (via `sensitiveSessionMiddleware`, an authoritative, non-cookie-cached
 * session lookup) and would refuse a second call with `PASSWORD_ALREADY_SET`
 * once a credential account exists. This route pre-checks both halves of
 * that condition itself so an account that's already set up gets one clear
 * 403 pointing at change-password, rather than leaking better-auth's 400.
 */
import { z } from "zod";
import { forbidden, withAuth } from "@/lib/api";
import { AUDIT_TARGETS, recordAudit } from "@/lib/audit";
import { limitAuthAttempt } from "@/lib/auth/rate-limits";
import { auth } from "@/lib/auth/server";
import { prisma } from "@/lib/prisma";
import { rateLimitedResponse } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  newPassword: z.string().min(10).max(200),
});

const ALREADY_SET_MESSAGE =
  "This account already has a password. Use change password to update it.";

export const POST = withAuth({ body: bodySchema }, async ({ req, user, body }) => {
  // Sets a credential, so it is limited like the sign-in endpoints — per user
  // (a session that keeps retrying) and per client.
  const limit = limitAuthAttempt({
    scope: "/set-password",
    subject: user.id,
    headers: req.headers,
  });
  if (!limit.allowed) {
    return rateLimitedResponse(limit.retryAfterMs);
  }

  if (!user.mustSetPassword) {
    throw forbidden(ALREADY_SET_MESSAGE);
  }

  const ctx = await auth.$context;
  const existingCredential = await ctx.internalAdapter.findCredentialAccount(user.id);
  if (existingCredential) {
    throw forbidden(ALREADY_SET_MESSAGE);
  }

  // Forward the same request headers withAuth already authenticated with, so
  // setPassword's own session lookup resolves the same user without relying
  // on next/headers() (which has no request scope when this handler is
  // invoked directly, as the integration tests do).
  await auth.api.setPassword({
    body: { newPassword: body.newPassword },
    headers: req.headers,
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { mustSetPassword: false },
  });

  await recordAudit({
    actorId: user.id,
    action: "user.set_password",
    targetType: AUDIT_TARGETS.user,
    targetId: user.id,
  });

  return { ok: true };
});
