/**
 * Admin-issued password reset links.
 *
 * Kiri sends no email, so better-auth's public "forgot password" request is
 * never enabled. Instead a reset token is minted here — by an admin for
 * another user (`POST /api/admin/users/:id/password-reset`) or by someone with
 * a shell in the container (`reset-password.mjs` → `POST /api/cli/password-reset`)
 * — and the link is handed over by hand, exactly like an invite.
 *
 * Redemption is better-auth's own `POST /api/auth/reset-password`: it consumes
 * the token (single use), sets or creates the credential, and — with
 * `revokeSessionsOnPasswordReset` — signs the user out everywhere. Only a hash
 * of the token is stored (./reset-token.ts).
 */
import { randomBytes } from "node:crypto";
import { notFound } from "@/lib/api";
import { AUDIT_ACTIONS, AUDIT_TARGETS, recordAudit } from "@/lib/audit";
import { RESET_PASSWORD_PREFIX } from "@/lib/auth/reset-token";
import { auth } from "@/lib/auth/server";
import { getEnv } from "@/lib/env";
import { prisma } from "@/lib/prisma";

export const PASSWORD_RESET_EXPIRY_HOURS = 72;

export function buildPasswordResetUrl(rawToken: string): string {
  const base = getEnv().PUBLIC_URL.replace(/\/+$/, "");
  return `${base}/reset-password?token=${encodeURIComponent(rawToken)}`;
}

export interface CreatePasswordResetInput {
  userId: string;
  /** The admin who asked for it; null when it came from the container CLI. */
  actorId: string | null;
  via: "admin" | "cli";
}

export interface CreatedPasswordReset {
  /** Shown once; only a hash is stored. */
  url: string;
  expiresAt: Date;
  email: string;
}

/**
 * Mint a single-use reset link for `userId`, replacing any link issued to
 * them before.
 */
export async function createPasswordReset(
  input: CreatePasswordResetInput,
): Promise<CreatedPasswordReset> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, email: true },
  });
  if (!user) throw notFound("User");

  // Only the newest link works. Stored identifiers keep the prefix (see
  // hashResetIdentifier), and the value is the user id.
  await prisma.verification.deleteMany({
    where: { value: user.id, identifier: { startsWith: RESET_PASSWORD_PREFIX } },
  });

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRY_HOURS * 60 * 60 * 1000);
  const ctx = await auth.$context;
  await ctx.internalAdapter.createVerificationValue({
    identifier: `${RESET_PASSWORD_PREFIX}${token}`,
    value: user.id,
    expiresAt,
  });

  await recordAudit({
    actorId: input.actorId,
    action: AUDIT_ACTIONS.passwordResetIssue,
    targetType: AUDIT_TARGETS.user,
    targetId: user.id,
    metadata: { via: input.via, expiresAt: expiresAt.toISOString() },
  });

  return { url: buildPasswordResetUrl(token), expiresAt, email: user.email };
}
