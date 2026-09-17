/**
 * Who is allowed to create an account.
 *
 * Sign-up (`POST /api/auth/sign-up/email`) is gated by three rules, checked in
 * this order:
 *
 *  1. **First run** — an empty `user` table lets anyone through and the account
 *     becomes the instance admin. This is what `/setup` uses.
 *  2. **Invite** — a raw token in the request body. The token is hashed and
 *     matched against `Invite.tokenHash`; the invite must be PENDING, unexpired
 *     and, when it pins an email, must match the address being registered. The
 *     invite is consumed here (atomically, so it stays single-use) and its role
 *     is applied to the new account.
 *  3. **Open registration** — `AppSetting.registrationMode = OPEN`.
 *
 * Anything else is refused. The decision is enforced from
 * `databaseHooks.user.create.before` in src/lib/auth/server.ts so that every
 * sign-up path goes through it, including direct `auth.api.signUpEmail` calls.
 */
import { RegistrationMode } from "@/generated/prisma/client";
import type { UserRole } from "@/lib/auth/types";
import {
  consumeInvite,
  findPendingInviteForEmail,
  hashInviteToken,
  validateInviteToken,
} from "@/lib/invites";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/settings";

/** Body field carrying the raw invite token on `POST /api/auth/sign-up/email`. */
export const INVITE_TOKEN_FIELD = "inviteToken";

export type RegistrationDenialCode =
  "INVITE_REQUIRED" | "REGISTRATION_CLOSED" | "INVITE_INVALID" | "INVITE_RACE";

export class RegistrationDeniedError extends Error {
  readonly code: RegistrationDenialCode;
  readonly status = 403 as const;

  constructor(code: RegistrationDenialCode, message: string) {
    super(message);
    this.name = "RegistrationDeniedError";
    this.code = code;
  }
}

export interface SignUpDecision {
  /** Role the new account gets. */
  role: UserRole;
  /** True when this is the very first account on the instance. */
  firstUser: boolean;
  /** Hash of the consumed invite, so the caller can attach the redeemer later. */
  consumedInviteHash: string | null;
}

export interface SignUpRequest {
  email: string;
  inviteToken?: string | null | undefined;
}

/**
 * Decide whether a sign-up may proceed, consuming the invite when one is used.
 * Throws {@link RegistrationDeniedError} when the sign-up must be refused.
 */
export async function resolveSignUp(request: SignUpRequest): Promise<SignUpDecision> {
  const userCount = await prisma.user.count();
  if (userCount === 0) {
    return { role: "admin", firstUser: true, consumedInviteHash: null };
  }

  const rawToken = request.inviteToken?.trim();
  if (rawToken) {
    const validation = await validateInviteToken(rawToken, request.email);
    if (validation.ok) {
      const claimed = await consumeInvite(validation.invite.id);
      if (!claimed) {
        throw new RegistrationDeniedError("INVITE_RACE", "This invite has already been used.");
      }
      return {
        role: normalizeRole(validation.invite.role),
        firstUser: false,
        consumedInviteHash: hashInviteToken(rawToken),
      };
    }
    // An unusable token is only forgiven when registration is open anyway.
    const settings = await getAppSettings();
    if (settings.registrationMode !== RegistrationMode.OPEN) {
      throw new RegistrationDeniedError("INVITE_INVALID", validation.message);
    }
    return { role: "member", firstUser: false, consumedInviteHash: null };
  }

  const settings = await getAppSettings();
  if (settings.registrationMode === RegistrationMode.OPEN) {
    return { role: "member", firstUser: false, consumedInviteHash: null };
  }
  if (settings.registrationMode === RegistrationMode.INVITE) {
    throw new RegistrationDeniedError(
      "INVITE_REQUIRED",
      "This instance is invite only. Ask an admin for an invite link.",
    );
  }
  throw new RegistrationDeniedError(
    "REGISTRATION_CLOSED",
    "Registration is closed on this instance.",
  );
}

/**
 * Whether a brand new account may be created for a Cloudflare Access identity.
 * Mirrors {@link resolveSignUp} minus the password flow: first run, a pinned
 * pending invite for that address, or open registration.
 */
export async function resolveCloudflareProvisioning(
  email: string,
): Promise<{ allowed: false } | { allowed: true; role: UserRole; inviteId: string | null }> {
  const userCount = await prisma.user.count();
  if (userCount === 0) {
    return { allowed: true, role: "admin", inviteId: null };
  }
  const settings = await getAppSettings();
  if (settings.registrationMode === RegistrationMode.OPEN) {
    return { allowed: true, role: "member", inviteId: null };
  }
  const invite = await findPendingInviteForEmail(email);
  if (invite) {
    return { allowed: true, role: normalizeRole(invite.role), inviteId: invite.id };
  }
  return { allowed: false };
}

export function normalizeRole(role: string | null | undefined): UserRole {
  return role === "admin" ? "admin" : "member";
}

/**
 * What the /register screen should show for a given raw invite token.
 * An invite pinned to an address that already belongs to a passwordless
 * imported account ("claim") must go to /api/auth/claim-invite instead of the
 * sign-up endpoint, which would fail with "user already exists".
 */
export type InviteScreen =
  | { kind: "invalid"; message: string }
  | { kind: "signup"; email: string | null; role: UserRole }
  | { kind: "claim"; email: string };

export async function describeInvite(rawToken: string): Promise<InviteScreen> {
  const validation = await validateInviteToken(rawToken);
  if (!validation.ok) {
    return { kind: "invalid", message: validation.message };
  }
  const invite = validation.invite;
  if (!invite.email) {
    return { kind: "signup", email: null, role: normalizeRole(invite.role) };
  }
  const user = await prisma.user.findUnique({
    where: { email: invite.email },
    select: { id: true, mustSetPassword: true },
  });
  if (user?.mustSetPassword) {
    const credentials = await prisma.account.count({
      where: { userId: user.id, providerId: "credential" },
    });
    if (credentials === 0) {
      return { kind: "claim", email: invite.email };
    }
  }
  if (user) {
    return {
      kind: "invalid",
      message: "An account already exists for this address. Sign in instead.",
    };
  }
  return { kind: "signup", email: invite.email, role: normalizeRole(invite.role) };
}
