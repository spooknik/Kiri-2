/**
 * Notifications: fan-out creation, cursor-paginated listing, mark-read and
 * retention purging.
 *
 * `createNotifications` is the baseline every feature calls (book club
 * enrollment, sync results, notes); its signature is depended on elsewhere and
 * must stay stable. The rest of this module backs `/api/notifications`.
 *
 * Listing is keyset paginated on `(createdAt desc, id desc)` rather than
 * offset: the client polls every ~10 s, so rows inserted between pages must not
 * shift the window. The cursor is an opaque base64url blob — clients only ever
 * echo it back.
 */
import type { Notification, Prisma, NotificationType } from "@/generated/prisma/client";
import { badRequest, notFound } from "@/lib/api";
import type {
  NotificationsPage,
  NotificationsQuery,
  NotificationView,
} from "@/lib/contracts/notifications";
import { prisma } from "@/lib/prisma";

/* -------------------------------------------------------------------------- */
/* Creation                                                                   */
/* -------------------------------------------------------------------------- */

export interface CreateNotificationsInput {
  userIds: string[];
  type: NotificationType;
  title: string;
  message: string;
  link?: string | null;
  seriesId?: string | null;
  noteId?: string | null;
  jobId?: string | null;
  /**
   * Optional per-user idempotency key. A second notification with the same
   * (userId, dedupeKey) is silently skipped, which collapses repeats such as
   * SYNC_FAILED for the same source.
   */
  dedupeKey?: string | null;
}

/** Create one notification per user. Returns the number of rows inserted. */
export async function createNotifications(input: CreateNotificationsInput): Promise<number> {
  const userIds = Array.from(new Set(input.userIds));
  if (userIds.length === 0) return 0;
  const result = await prisma.notification.createMany({
    data: userIds.map((userId) => ({
      userId,
      type: input.type,
      title: input.title,
      message: input.message,
      link: input.link ?? null,
      seriesId: input.seriesId ?? null,
      noteId: input.noteId ?? null,
      jobId: input.jobId ?? null,
      dedupeKey: input.dedupeKey ?? null,
    })),
    skipDuplicates: true,
  });
  return result.count;
}

/* -------------------------------------------------------------------------- */
/* Cursor                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Keyset cursor codec. Deliberately duplicated in src/lib/audit.ts: the two
 * modules are owned by different features and a shared pagination module would
 * be a third owner for twenty lines.
 */
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

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

type NotificationRow = Pick<
  Notification,
  "id" | "type" | "title" | "message" | "link" | "seriesId" | "readAt" | "createdAt"
>;

const notificationSelect = {
  id: true,
  type: true,
  title: true,
  message: true,
  link: true,
  seriesId: true,
  readAt: true,
  createdAt: true,
} satisfies Prisma.NotificationSelect;

function toView(row: NotificationRow): NotificationView {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    message: row.message,
    link: row.link,
    seriesId: row.seriesId,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** One page of the user's own notifications, newest first, plus the unread total. */
export async function listNotifications(
  userId: string,
  query: NotificationsQuery,
): Promise<NotificationsPage> {
  const limit = query.limit;
  const cursor = decodeCursor(query.cursor);
  const where: Prisma.NotificationWhereInput = {
    userId,
    ...(query.unread === "1" ? { readAt: null } : {}),
    ...(cursor
      ? {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        }
      : {}),
  };

  const [rows, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      // One extra row decides whether another page exists.
      take: limit + 1,
      select: notificationSelect,
    }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items: items.map(toView),
    nextCursor: hasMore && last ? encodeCursor(last) : null,
    unreadCount,
  };
}

/* -------------------------------------------------------------------------- */
/* Mutation                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Mark the user's unread notifications read. With no `ids`, everything unread
 * is marked; rows belonging to other users are never touched. Returns the
 * number of rows actually flipped (already-read rows do not count).
 */
export async function markNotificationsRead(userId: string, ids?: string[]): Promise<number> {
  if (ids && ids.length === 0) return 0;
  const result = await prisma.notification.updateMany({
    where: { userId, readAt: null, ...(ids ? { id: { in: ids } } : {}) },
    data: { readAt: new Date() },
  });
  return result.count;
}

/** Mark one notification read. 404 when it does not exist or is not the user's. */
export async function markOneRead(userId: string, id: string): Promise<NotificationView> {
  const existing = await prisma.notification.findFirst({
    where: { id, userId },
    select: notificationSelect,
  });
  if (!existing) throw notFound("Notification");
  if (existing.readAt) return toView(existing);
  const updated = await prisma.notification.update({
    where: { id },
    data: { readAt: new Date() },
    select: notificationSelect,
  });
  return toView(updated);
}

/**
 * Delete notifications older than `olderThanDays`, read or not. Called by the
 * retention job with `AppSetting.notificationRetentionDays`.
 */
export async function purgeOldNotifications(olderThanDays: number): Promise<number> {
  const days = Math.max(1, Math.floor(olderThanDays));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await prisma.notification.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return result.count;
}
