/**
 * Admin user management: list, promote/demote, ban/unban.
 *
 * Role and ban live on the `User` row exactly as better-auth's admin plugin
 * writes them ("admin" | "member", `banned` + `banReason`), so a user banned
 * here is refused by the plugin's sign-in hook just as if `auth.api.banUser`
 * had done it. The plugin also deletes the banned user's sessions; we do the
 * same through the internal adapter, otherwise an already-signed-in session
 * would keep working until it expired.
 *
 * Two guard rails, both 400s:
 *  - an admin cannot change their own role or ban themselves (V1 had no such
 *    check and a mis-click locked the owner out);
 *  - the last remaining admin cannot be demoted or banned, which would leave
 *    the instance with no way back into /admin.
 */
import type { Prisma } from "@/generated/prisma/client";
import { badRequest, notFound } from "@/lib/api";
import { auth } from "@/lib/auth/server";
import type { SessionUser, UserRole } from "@/lib/auth/types";
import { AUDIT_ACTIONS, AUDIT_TARGETS, recordAudit } from "@/lib/audit";
import type { AdminUserView, UpdateUserInput } from "@/lib/contracts/admin";
import { prisma } from "@/lib/prisma";

const adminUserSelect = {
  id: true,
  email: true,
  displayName: true,
  role: true,
  banned: true,
  banReason: true,
  mustSetPassword: true,
  createdAt: true,
  _count: { select: { createdSeries: true, library: true } },
} satisfies Prisma.UserSelect;

interface AdminUserRow {
  id: string;
  email: string;
  displayName: string;
  role: string;
  banned: boolean;
  banReason: string | null;
  mustSetPassword: boolean;
  createdAt: Date;
  _count: { createdSeries: number; library: number };
}

function normalizeRole(role: string): UserRole {
  return role === "admin" ? "admin" : "member";
}

function toView(row: AdminUserRow): AdminUserView {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: normalizeRole(row.role),
    banned: row.banned,
    banReason: row.banReason,
    mustSetPassword: row.mustSetPassword,
    createdAt: row.createdAt.toISOString(),
    seriesCreated: row._count.createdSeries,
    seriesTracked: row._count.library,
  };
}

/** Everyone, oldest account first — the instance owner heads the list. */
export async function listAdminUsers(): Promise<AdminUserView[]> {
  const rows = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: adminUserSelect,
  });
  return rows.map(toView);
}

/**
 * Drop every session of a banned user. Prefers better-auth's internal adapter
 * so any session bookkeeping it does stays consistent; falls back to a direct
 * delete, because leaving a banned user signed in is not an acceptable failure
 * mode.
 */
async function revokeAllSessions(userId: string): Promise<void> {
  try {
    const ctx = await auth.$context;
    await ctx.internalAdapter.deleteUserSessions(userId);
  } catch (error) {
    console.error(`[admin] internal session revoke failed for ${userId}`, error);
    await prisma.session.deleteMany({ where: { userId } });
  }
}

export async function updateAdminUser(
  actor: SessionUser,
  targetId: string,
  input: UpdateUserInput,
): Promise<AdminUserView> {
  const target = await prisma.user.findUnique({
    where: { id: targetId },
    select: adminUserSelect,
  });
  if (!target) throw notFound("User");

  const currentRole = normalizeRole(target.role);
  const roleChanged = input.role !== undefined && input.role !== currentRole;
  const banChanged = input.banned !== undefined && input.banned !== target.banned;
  const isSelf = target.id === actor.id;

  if (isSelf && roleChanged) {
    throw badRequest("You cannot change your own role");
  }
  if (isSelf && input.banned === true) {
    throw badRequest("You cannot ban yourself");
  }

  const losesAdmin = currentRole === "admin" && (roleChanged || input.banned === true);
  if (losesAdmin) {
    const otherAdmins = await prisma.user.count({
      where: { role: "admin", banned: false, id: { not: target.id } },
    });
    if (otherAdmins === 0) {
      throw badRequest("The last administrator cannot be demoted or banned");
    }
  }

  const data: Prisma.UserUpdateInput = {};
  if (input.role !== undefined) data.role = input.role;
  if (input.banned !== undefined) {
    data.banned = input.banned;
    if (input.banned) {
      data.banReason = input.banReason ?? target.banReason ?? null;
    } else {
      // Unbanning clears the reason and any expiry the plugin may have set.
      data.banReason = null;
      data.banExpires = null;
    }
  } else if (input.banReason !== undefined) {
    data.banReason = input.banReason ?? null;
  }

  const updated = await prisma.user.update({
    where: { id: targetId },
    data,
    select: adminUserSelect,
  });

  if (input.banned === true) {
    await revokeAllSessions(targetId);
  }

  if (roleChanged && input.role) {
    await recordAudit({
      actorId: actor.id,
      action: AUDIT_ACTIONS.userRole,
      targetType: AUDIT_TARGETS.user,
      targetId: targetId,
      metadata: { email: target.email, from: currentRole, to: input.role },
    });
  }
  if (banChanged) {
    await recordAudit({
      actorId: actor.id,
      action: input.banned ? AUDIT_ACTIONS.userBan : AUDIT_ACTIONS.userUnban,
      targetType: AUDIT_TARGETS.user,
      targetId: targetId,
      metadata: { email: target.email, reason: updated.banReason },
    });
  }

  return toView(updated);
}
