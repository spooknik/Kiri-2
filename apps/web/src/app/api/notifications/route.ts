/**
 * GET  /api/notifications — one cursor page plus the unread total.
 * PATCH /api/notifications — mark all (or the given ids) read.
 */
import { withAuth } from "@/lib/api";
import { markNotificationsSchema, notificationsQuerySchema } from "@/lib/contracts/notifications";
import { listNotifications, markNotificationsRead } from "@/lib/notifications";

export const dynamic = "force-dynamic";

export const GET = withAuth({ query: notificationsQuerySchema }, ({ user, query }) =>
  listNotifications(user.id, query),
);

export const PATCH = withAuth({ body: markNotificationsSchema }, async ({ user, body }) => ({
  marked: await markNotificationsRead(user.id, body.ids),
}));
