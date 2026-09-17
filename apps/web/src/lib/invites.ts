/**
 * Single-use invite tokens.
 *
 * The raw token only ever exists in the invite URL (and in the response to the
 * admin who created it). The database stores its SHA-256 hash, so a database
 * dump cannot be turned into working invites.
 */
import { createHash, randomBytes } from "node:crypto";
import { InviteStatus, type Invite } from "@/generated/prisma/client";
import type { UserRole } from "@/lib/auth/types";
import { getEnv } from "@/lib/env";
import { prisma } from "@/lib/prisma";

export const DEFAULT_INVITE_EXPIRY_DAYS = 14;
const MAX_INVITE_EXPIRY_DAYS = 365;

/** SHA-256 of the raw token, hex encoded. Matches `Invite.tokenHash`. */
export function hashInviteToken(rawToken: string): string {
  return createHash("sha256").update(rawToken.trim()).digest("hex");
}

/** The link an invited person opens. The raw token never touches the database. */
export function buildInviteUrl(rawToken: string): string {
  const base = getEnv().PUBLIC_URL.replace(/\/+$/, "");
  return `${base}/register?invite=${encodeURIComponent(rawToken)}`;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface CreateInviteInput {
  /** Pin the invite to one address. Omit for an open link. */
  email?: string | null;
  role?: UserRole;
  expiresInDays?: number;
  createdById: string;
}

export interface CreatedInvite {
  invite: Invite;
  /** Shown once; not recoverable afterwards. */
  token: string;
  url: string;
}

export async function createInvite(input: CreateInviteInput): Promise<CreatedInvite> {
  const days = clampExpiryDays(input.expiresInDays);
  const token = randomBytes(32).toString("base64url");
  const invite = await prisma.invite.create({
    data: {
      tokenHash: hashInviteToken(token),
      email: input.email ? normalizeEmail(input.email) : null,
      role: input.role ?? "member",
      expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
      createdById: input.createdById,
    },
  });
  return { invite, token, url: buildInviteUrl(token) };
}

export type InviteRejection =
  "NOT_FOUND" | "REVOKED" | "ALREADY_USED" | "EXPIRED" | "EMAIL_MISMATCH";

export type InviteValidation =
  { ok: true; invite: Invite } | { ok: false; reason: InviteRejection; message: string };

/**
 * Look a raw token up and decide whether it may still be redeemed.
 * When `email` is given, an invite pinned to a different address is rejected.
 * Expired PENDING invites are flipped to EXPIRED as a side effect.
 */
export async function validateInviteToken(
  rawToken: string,
  email?: string | null,
): Promise<InviteValidation> {
  const trimmed = rawToken?.trim();
  if (!trimmed) {
    return { ok: false, reason: "NOT_FOUND", message: "This invite link is not valid." };
  }
  const invite = await prisma.invite.findUnique({ where: { tokenHash: hashInviteToken(trimmed) } });
  if (!invite) {
    return { ok: false, reason: "NOT_FOUND", message: "This invite link is not valid." };
  }
  if (invite.status === InviteStatus.REVOKED) {
    return { ok: false, reason: "REVOKED", message: "This invite has been revoked." };
  }
  if (invite.status === InviteStatus.ACCEPTED) {
    return { ok: false, reason: "ALREADY_USED", message: "This invite has already been used." };
  }
  if (invite.expiresAt.getTime() <= Date.now()) {
    if (invite.status === InviteStatus.PENDING) {
      await prisma.invite.updateMany({
        where: { id: invite.id, status: InviteStatus.PENDING },
        data: { status: InviteStatus.EXPIRED },
      });
    }
    return { ok: false, reason: "EXPIRED", message: "This invite has expired." };
  }
  if (invite.status !== InviteStatus.PENDING) {
    return { ok: false, reason: "EXPIRED", message: "This invite has expired." };
  }
  if (invite.email && email && invite.email !== normalizeEmail(email)) {
    return {
      ok: false,
      reason: "EMAIL_MISMATCH",
      message: "This invite was issued for a different email address.",
    };
  }
  return { ok: true, invite };
}

/**
 * Atomically flip a PENDING invite to ACCEPTED. Returns false when another
 * request got there first, which is what makes an invite single use.
 */
export async function consumeInvite(inviteId: string, redeemedById?: string): Promise<boolean> {
  const result = await prisma.invite.updateMany({
    where: { id: inviteId, status: InviteStatus.PENDING },
    data: {
      status: InviteStatus.ACCEPTED,
      redeemedAt: new Date(),
      ...(redeemedById ? { redeemedById } : {}),
    },
  });
  return result.count === 1;
}

/**
 * Record who redeemed an invite. Split from {@link consumeInvite} because
 * sign-up consumes the invite before the user row exists.
 */
export async function attachInviteRedeemer(tokenHash: string, userId: string): Promise<void> {
  await prisma.invite.updateMany({
    where: { tokenHash, status: InviteStatus.ACCEPTED, redeemedById: null },
    data: { redeemedById: userId, redeemedAt: new Date() },
  });
}

export async function revokeInvite(inviteId: string): Promise<Invite | null> {
  const result = await prisma.invite.updateMany({
    where: { id: inviteId, status: InviteStatus.PENDING },
    data: { status: InviteStatus.REVOKED },
  });
  if (result.count === 0) return null;
  return prisma.invite.findUnique({ where: { id: inviteId } });
}

export interface ListInvitesOptions {
  status?: InviteStatus;
  /** Newest first. */
  take?: number;
}

export async function listInvites(options: ListInvitesOptions = {}): Promise<Invite[]> {
  return prisma.invite.findMany({
    where: options.status ? { status: options.status } : undefined,
    orderBy: { createdAt: "desc" },
    take: options.take ?? 100,
  });
}

/** A still-redeemable invite pinned to this exact address, if any. */
export async function findPendingInviteForEmail(email: string): Promise<Invite | null> {
  return prisma.invite.findFirst({
    where: {
      email: normalizeEmail(email),
      status: InviteStatus.PENDING,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
}

function clampExpiryDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days)) return DEFAULT_INVITE_EXPIRY_DAYS;
  return Math.min(Math.max(Math.floor(days), 1), MAX_INVITE_EXPIRY_DAYS);
}
