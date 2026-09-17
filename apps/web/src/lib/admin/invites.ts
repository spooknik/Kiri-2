/**
 * Invite views for the admin UI.
 *
 * Token creation and revocation stay in src/lib/invites.ts (the raw token is
 * hashed there and never stored); this module only adds the joins the admin
 * list needs and the audit entries an admin action must leave behind.
 */
import { conflict, notFound } from "@/lib/api";
import type { SessionUser, UserRole } from "@/lib/auth/types";
import { AUDIT_ACTIONS, AUDIT_TARGETS, recordAudit } from "@/lib/audit";
import type { CreateInviteInput, InviteStatus, InviteView } from "@/lib/contracts/admin";
import { createInvite, revokeInvite } from "@/lib/invites";
import { prisma } from "@/lib/prisma";

interface InviteRow {
  id: string;
  email: string | null;
  role: string;
  status: string;
  expiresAt: Date;
  createdAt: Date;
  createdBy: { id: string; displayName: string };
  redeemedBy: { id: string; displayName: string } | null;
}

function normalizeRole(role: string): UserRole {
  return role === "admin" ? "admin" : "member";
}

function toView(row: InviteRow): InviteView {
  return {
    id: row.id,
    email: row.email,
    role: normalizeRole(row.role),
    status: row.status as InviteStatus,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    createdBy: { id: row.createdBy.id, displayName: row.createdBy.displayName },
    redeemedBy: row.redeemedBy
      ? { id: row.redeemedBy.id, displayName: row.redeemedBy.displayName }
      : null,
  };
}

const userRef = { select: { id: true, displayName: true } } as const;

/** Newest first. The admin list is short by nature, so it is not paginated. */
export async function listInviteViews(take = 100): Promise<InviteView[]> {
  const rows = await prisma.invite.findMany({
    orderBy: { createdAt: "desc" },
    take,
    include: { createdBy: userRef, redeemedBy: userRef },
  });
  return rows.map(toView);
}

/**
 * Mint an invite. The returned view carries `url` — the only time the raw
 * token is ever visible — and the audit entry records everything but the token.
 */
export async function createInviteView(
  actor: SessionUser,
  input: CreateInviteInput,
): Promise<InviteView> {
  const created = await createInvite({
    email: input.email ?? null,
    role: input.role,
    expiresInDays: input.expiresInDays,
    createdById: actor.id,
  });

  await recordAudit({
    actorId: actor.id,
    action: AUDIT_ACTIONS.inviteCreate,
    targetType: AUDIT_TARGETS.invite,
    targetId: created.invite.id,
    metadata: {
      email: created.invite.email,
      role: created.invite.role,
      expiresAt: created.invite.expiresAt.toISOString(),
    },
  });

  return {
    ...toView({
      ...created.invite,
      createdBy: { id: actor.id, displayName: actor.displayName },
      redeemedBy: null,
    }),
    url: created.url,
  };
}

/** Revoke a pending invite. Already accepted or revoked ones are a 409. */
export async function revokeInviteById(actor: SessionUser, inviteId: string): Promise<void> {
  const existing = await prisma.invite.findUnique({ where: { id: inviteId } });
  if (!existing) throw notFound("Invite");

  const revoked = await revokeInvite(inviteId);
  if (!revoked) {
    throw conflict("Only a pending invite can be revoked");
  }

  await recordAudit({
    actorId: actor.id,
    action: AUDIT_ACTIONS.inviteRevoke,
    targetType: AUDIT_TARGETS.invite,
    targetId: inviteId,
    metadata: { email: existing.email, role: existing.role },
  });
}
