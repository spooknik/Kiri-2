/**
 * Admin audit trail.
 *
 * Every state-changing admin action writes one row: who did it, what they did
 * (a dotted action string), and which record it touched. Writes are
 * best-effort — a failing audit insert logs and is swallowed rather than
 * rolling back an action the admin already saw succeed.
 */
import type { Prisma } from "@/generated/prisma/client";
import { badRequest } from "@/lib/api";
import type { AuditEntryView, AuditPage } from "@/lib/contracts/admin";
import { prisma } from "@/lib/prisma";

/** The actions this codebase records. Callers may pass any dotted string. */
export const AUDIT_ACTIONS = {
  userRole: "user.role",
  userBan: "user.ban",
  userUnban: "user.unban",
  inviteCreate: "invite.create",
  inviteRevoke: "invite.revoke",
  settingsUpdate: "settings.update",
} as const;

/** Target types used with {@link AUDIT_ACTIONS}. */
export const AUDIT_TARGETS = {
  user: "user",
  invite: "invite",
  settings: "settings",
} as const;

export interface RecordAuditInput {
  /** Null for actions taken by the system rather than a signed-in admin. */
  actorId: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Append one entry. Never throws: the audited action has already happened. */
export async function recordAudit(input: RecordAuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    console.error(`[audit] failed to record ${input.action}`, error);
  }
}

/* -------------------------------------------------------------------------- */
/* Listing                                                                    */
/* -------------------------------------------------------------------------- */

/** See the note in src/lib/notifications.ts on why this codec lives twice. */
interface KeysetCursor {
  createdAt: Date;
  id: string;
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ c: row.createdAt.toISOString(), i: row.id })).toString(
    "base64url",
  );
}

function decodeCursor(raw: string | undefined): KeysetCursor | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw badRequest("Invalid cursor");
  }
  if (!parsed || typeof parsed !== "object") throw badRequest("Invalid cursor");
  const { c, i } = parsed as { c?: unknown; i?: unknown };
  if (typeof c !== "string" || typeof i !== "string") throw badRequest("Invalid cursor");
  const createdAt = new Date(c);
  if (Number.isNaN(createdAt.getTime())) throw badRequest("Invalid cursor");
  return { createdAt, id: i };
}

export interface AuditQuery {
  cursor?: string | undefined;
  limit: number;
}

interface AuditRow {
  id: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Prisma.JsonValue;
  createdAt: Date;
  actor: { id: string; displayName: string } | null;
}

/** Anything that is not a JSON object (null, array, scalar) reads back as `{}`. */
function toMetadata(value: Prisma.JsonValue): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toView(row: AuditRow): AuditEntryView {
  return {
    id: row.id,
    actor: row.actor ? { id: row.actor.id, displayName: row.actor.displayName } : null,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    metadata: toMetadata(row.metadata),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Newest first, keyset paginated on `(createdAt desc, id desc)`. */
export async function listAudit(query: AuditQuery): Promise<AuditPage> {
  const limit = query.limit;
  const cursor = decodeCursor(query.cursor);
  const rows = await prisma.auditLog.findMany({
    where: cursor
      ? {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        }
      : {},
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: { actor: { select: { id: true, displayName: true } } },
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items: items.map(toView),
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  };
}
