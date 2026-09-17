import { describe, expect, it } from "vitest";
import type { NotificationView } from "@/lib/contracts";
import { groupNotificationsByDay } from "./group-notifications";

function makeNotification(overrides: Partial<NotificationView>): NotificationView {
  return {
    id: "id",
    type: "SYNC_COMPLETED",
    title: "Title",
    message: "Message",
    link: null,
    seriesId: null,
    readAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("groupNotificationsByDay", () => {
  it("buckets items created today under Today and older items under Earlier", () => {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const earlierToday = new Date(startOfToday.getTime() + 60_000);
    const yesterday = new Date(startOfToday.getTime() - 60_000);

    const items = [
      makeNotification({ id: "a", createdAt: earlierToday.toISOString() }),
      makeNotification({ id: "b", createdAt: yesterday.toISOString() }),
    ];

    const groups = groupNotificationsByDay(items);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ label: "Today", items: [{ id: "a" }] });
    expect(groups[1]).toMatchObject({ label: "Earlier", items: [{ id: "b" }] });
  });

  it("omits empty buckets", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const items = [makeNotification({ id: "a", createdAt: yesterday.toISOString() })];

    const groups = groupNotificationsByDay(items);

    expect(groups).toEqual([{ label: "Earlier", items: [items[0]] }]);
  });

  it("returns no groups for an empty list", () => {
    expect(groupNotificationsByDay([])).toEqual([]);
  });

  it("treats an unparsable createdAt as Earlier rather than throwing", () => {
    const items = [makeNotification({ id: "a", createdAt: "not-a-date" })];
    const groups = groupNotificationsByDay(items);
    expect(groups).toEqual([{ label: "Earlier", items: [items[0]] }]);
  });
});
