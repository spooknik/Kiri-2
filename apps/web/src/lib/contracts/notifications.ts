/**
 * Notifications contract. GET /api/notifications is cursor paginated; the
 * client polls it (TanStack Query, ~10 s) and merges pages.
 */
import { z } from "zod";

export const NOTIFICATION_TYPES = [
  "BOOK_CLUB_ADDED",
  "SYNC_COMPLETED",
  "SYNC_FAILED",
  "NEW_CHAPTER",
  "NOTE_REPLY",
  "NOTE_MENTION",
  "NEEDS_CREDENTIAL",
  "PLUGIN_INSTALLED",
  "PLUGIN_FAILED",
  "IMPORT_COMPLETED",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const notificationsQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  unread: z.enum(["1"]).optional(),
});
export type NotificationsQuery = z.infer<typeof notificationsQuerySchema>;

/** PATCH /api/notifications — mark all (or a set) read. */
export const markNotificationsSchema = z.object({
  ids: z.array(z.uuid()).max(200).optional(),
});

export interface NotificationView {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  link: string | null;
  seriesId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationsPage {
  items: NotificationView[];
  nextCursor: string | null;
  unreadCount: number;
}
