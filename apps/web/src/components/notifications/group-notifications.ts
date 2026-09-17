import type { NotificationView } from "@/lib/contracts";

export interface NotificationGroup {
  label: "Today" | "Earlier";
  items: NotificationView[];
}

/**
 * Splits a list of notifications (assumed already sorted newest-first) into
 * "Today" / "Earlier" buckets, dropping empty buckets. "Today" is the local
 * calendar day.
 */
export function groupNotificationsByDay(items: NotificationView[]): NotificationGroup[] {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const today: NotificationView[] = [];
  const earlier: NotificationView[] = [];

  for (const item of items) {
    const created = new Date(item.createdAt);
    if (!Number.isNaN(created.getTime()) && created >= todayStart) {
      today.push(item);
    } else {
      earlier.push(item);
    }
  }

  const groups: NotificationGroup[] = [];
  if (today.length > 0) groups.push({ label: "Today", items: today });
  if (earlier.length > 0) groups.push({ label: "Earlier", items: earlier });
  return groups;
}
