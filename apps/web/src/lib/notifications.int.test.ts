/**
 * Notifications: listing, cursor pagination, the unread filter, dedupe
 * collapsing and mark-read ownership — exercised through both the library
 * functions and the route handlers.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestUser, mockCurrentUser, resetDatabase, routeContext } from "../../test/factories";
import { PATCH as markOneRoute } from "@/app/api/notifications/[id]/route";
import { GET as listRoute, PATCH as markAllRoute } from "@/app/api/notifications/route";
import type { NotificationsPage, NotificationView } from "@/lib/contracts/notifications";
import {
  createNotifications,
  listNotifications,
  markNotificationsRead,
  markOneRead,
} from "@/lib/notifications";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: vi.fn(),
}));

const ORIGIN = "http://localhost:3000";
/** Fixed epoch so seeded rows have a deterministic order. */
const BASE = new Date("2026-01-01T00:00:00.000Z").getTime();

async function seed(userId: string, index: number, readAt: Date | null = null) {
  return prisma.notification.create({
    data: {
      userId,
      type: "NEW_CHAPTER",
      title: `Chapter ${index}`,
      message: `Chapter ${index} is out`,
      link: `/series/${index}`,
      readAt,
      createdAt: new Date(BASE + index * 60_000),
    },
  });
}

function listRequest(query = ""): NextRequest {
  return new NextRequest(`${ORIGIN}/api/notifications${query}`);
}

function markAllRequest(body: unknown): NextRequest {
  return new NextRequest(`${ORIGIN}/api/notifications`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await resetDatabase();
});

describe("listNotifications", () => {
  it("pages newest first and stops when the last page is short", async () => {
    const user = await createTestUser();
    for (let i = 1; i <= 5; i += 1) await seed(user.id, i);

    const first = await listNotifications(user.id, { limit: 2 });
    expect(first.items.map((item) => item.title)).toEqual(["Chapter 5", "Chapter 4"]);
    expect(first.nextCursor).toBeTruthy();
    expect(first.unreadCount).toBe(5);

    const second = await listNotifications(user.id, { limit: 2, cursor: first.nextCursor ?? "" });
    expect(second.items.map((item) => item.title)).toEqual(["Chapter 3", "Chapter 2"]);

    const third = await listNotifications(user.id, { limit: 2, cursor: second.nextCursor ?? "" });
    expect(third.items.map((item) => item.title)).toEqual(["Chapter 1"]);
    expect(third.nextCursor).toBeNull();
  });

  it("keeps rows apart when several share a createdAt", async () => {
    const user = await createTestUser();
    const sameInstant = new Date(BASE);
    for (let i = 1; i <= 4; i += 1) {
      await prisma.notification.create({
        data: {
          userId: user.id,
          type: "SYNC_COMPLETED",
          title: `Tie ${i}`,
          message: "same instant",
          createdAt: sameInstant,
        },
      });
    }

    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 4; page += 1) {
      const result: NotificationsPage = await listNotifications(user.id, { limit: 2, cursor });
      for (const item of result.items) seen.add(item.id);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(seen.size).toBe(4);
  });

  it("filters to unread but still reports the full unread count", async () => {
    const user = await createTestUser();
    await seed(user.id, 1, new Date(BASE));
    await seed(user.id, 2);
    await seed(user.id, 3);

    const all = await listNotifications(user.id, { limit: 30 });
    expect(all.items).toHaveLength(3);
    expect(all.unreadCount).toBe(2);

    const unread = await listNotifications(user.id, { limit: 30, unread: "1" });
    expect(unread.items.map((item) => item.title)).toEqual(["Chapter 3", "Chapter 2"]);
    expect(unread.unreadCount).toBe(2);
  });

  it("never leaks another user's notifications", async () => {
    const mine = await createTestUser();
    const theirs = await createTestUser();
    await seed(mine.id, 1);
    await seed(theirs.id, 2);

    const page = await listNotifications(mine.id, { limit: 30 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.title).toBe("Chapter 1");
  });

  it("rejects a cursor it did not mint", async () => {
    const user = await createTestUser();
    await expect(listNotifications(user.id, { limit: 30, cursor: "not-a-cursor" })).rejects.toThrow(
      /invalid cursor/i,
    );
  });
});

describe("createNotifications", () => {
  it("collapses a repeat with the same dedupeKey", async () => {
    const user = await createTestUser();
    const input = {
      userIds: [user.id],
      type: "SYNC_FAILED" as const,
      title: "Sync failed",
      message: "Try again",
      dedupeKey: "sync-failed:source-1",
    };

    expect(await createNotifications(input)).toBe(1);
    expect(await createNotifications(input)).toBe(0);
    expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(1);
  });

  it("fans out to each user once and ignores an empty audience", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const created = await createNotifications({
      userIds: [a.id, b.id, a.id],
      type: "BOOK_CLUB_ADDED",
      title: "Book club",
      message: "You were added",
    });
    expect(created).toBe(2);
    expect(
      await createNotifications({ userIds: [], type: "BOOK_CLUB_ADDED", title: "x", message: "y" }),
    ).toBe(0);
  });
});

describe("mark read", () => {
  it("marks every unread row of the caller and nobody else's", async () => {
    const mine = await createTestUser();
    const theirs = await createTestUser();
    await seed(mine.id, 1);
    await seed(mine.id, 2, new Date(BASE));
    await seed(theirs.id, 3);

    expect(await markNotificationsRead(mine.id)).toBe(1);
    expect(await prisma.notification.count({ where: { userId: mine.id, readAt: null } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: theirs.id, readAt: null } })).toBe(1);
  });

  it("marks only the ids that belong to the caller", async () => {
    const mine = await createTestUser();
    const theirs = await createTestUser();
    const own = await seed(mine.id, 1);
    const other = await seed(theirs.id, 2);

    expect(await markNotificationsRead(mine.id, [own.id, other.id])).toBe(1);
    const reloaded = await prisma.notification.findUniqueOrThrow({ where: { id: other.id } });
    expect(reloaded.readAt).toBeNull();
  });

  it("markOneRead is idempotent and 404s on someone else's row", async () => {
    const mine = await createTestUser();
    const theirs = await createTestUser();
    const own = await seed(mine.id, 1);
    const other = await seed(theirs.id, 2);

    const first = await markOneRead(mine.id, own.id);
    expect(first.readAt).not.toBeNull();
    const second = await markOneRead(mine.id, own.id);
    expect(second.readAt).toBe(first.readAt);

    await expect(markOneRead(mine.id, other.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("routes", () => {
  it("GET returns the contract shape with ISO dates", async () => {
    const user = await createTestUser();
    mockCurrentUser(user);
    await seed(user.id, 1);

    const response = await listRoute(listRequest("?limit=1"), routeContext({}));
    expect(response.status).toBe(200);
    const body = (await response.json()) as NotificationsPage;
    expect(body.unreadCount).toBe(1);
    expect(body.nextCursor).toBeNull();
    expect(body.items[0]).toMatchObject({
      type: "NEW_CHAPTER",
      title: "Chapter 1",
      link: "/series/1",
      readAt: null,
    });
    expect(body.items[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("GET is 401 when signed out", async () => {
    mockCurrentUser(null);
    const response = await listRoute(listRequest(), routeContext({}));
    expect(response.status).toBe(401);
  });

  it("PATCH marks everything read and reports the count", async () => {
    const user = await createTestUser();
    mockCurrentUser(user);
    await seed(user.id, 1);
    await seed(user.id, 2);

    const response = await markAllRoute(markAllRequest({}), routeContext({}));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ marked: 2 });
  });

  it("PATCH /:id returns the updated notification and 404s for another user's", async () => {
    const mine = await createTestUser();
    const theirs = await createTestUser();
    mockCurrentUser(mine);
    const own = await seed(mine.id, 1);
    const other = await seed(theirs.id, 2);

    const ok = await markOneRoute(
      new NextRequest(`${ORIGIN}/api/notifications/${own.id}`, { method: "PATCH" }),
      routeContext({ id: own.id }),
    );
    expect(ok.status).toBe(200);
    const view = (await ok.json()) as NotificationView;
    expect(view.id).toBe(own.id);
    expect(view.readAt).not.toBeNull();

    const denied = await markOneRoute(
      new NextRequest(`${ORIGIN}/api/notifications/${other.id}`, { method: "PATCH" }),
      routeContext({ id: other.id }),
    );
    expect(denied.status).toBe(404);
  });
});
