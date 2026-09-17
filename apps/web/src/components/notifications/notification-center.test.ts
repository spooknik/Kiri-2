// @vitest-environment jsdom
//
// Named `.ts` (not `.tsx`) to match this project's vitest `include` glob, so
// JSX is written via `createElement` instead of JSX syntax (see dialog.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import type { InfiniteData } from "@tanstack/react-query";
import type { NotificationsPage, NotificationView } from "@/lib/contracts";
import { NotificationCenter } from "./notification-center";
import { useMarkNotificationsRead, useNotifications } from "@/hooks/use-notifications";

afterEach(cleanup);

vi.mock("@/hooks/use-notifications", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/use-notifications")>(
    "@/hooks/use-notifications",
  );
  return {
    ...actual,
    useNotifications: vi.fn(),
    useMarkNotificationsRead: vi.fn(),
  };
});

vi.mock("@/hooks/use-online-status", () => ({
  useOnlineStatus: () => true,
}));

const mockedUseNotifications = vi.mocked(useNotifications);
const mockedUseMarkNotificationsRead = vi.mocked(useMarkNotificationsRead);

function makeNotification(overrides: Partial<NotificationView>): NotificationView {
  return {
    id: "n1",
    type: "SYNC_COMPLETED",
    title: "Sync completed",
    message: "One Piece has 3 new chapters.",
    link: null,
    seriesId: null,
    readAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function mockNotificationsQuery(
  items: NotificationView[],
  unreadCount: number,
  overrides: Record<string, unknown> = {},
) {
  const data: InfiniteData<NotificationsPage> = {
    pages: [{ items, nextCursor: null, unreadCount }],
    pageParams: [undefined],
  };
  mockedUseNotifications.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

function mockMarkRead(mutate = vi.fn()) {
  mockedUseMarkNotificationsRead.mockReturnValue({
    mutate,
    isPending: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return mutate;
}

describe("NotificationCenter", () => {
  it("renders notifications grouped by day", () => {
    mockMarkRead();
    mockNotificationsQuery(
      [
        makeNotification({ id: "a", title: "First" }),
        makeNotification({ id: "b", title: "Second", readAt: new Date().toISOString() }),
      ],
      1,
    );

    render(createElement(NotificationCenter));

    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("1 unread")).toBeInTheDocument();
  });

  it("shows an empty state when there are no notifications", () => {
    mockMarkRead();
    mockNotificationsQuery([], 0);

    render(createElement(NotificationCenter));

    expect(screen.getByText("No notifications yet")).toBeInTheDocument();
    expect(screen.queryByText("Mark all read")).not.toBeInTheDocument();
  });

  it("calls the mark-all-read mutation with no ids when 'Mark all read' is clicked", () => {
    const mutate = mockMarkRead();
    mockNotificationsQuery([makeNotification({ id: "a" })], 1);

    render(createElement(NotificationCenter));
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));

    expect(mutate).toHaveBeenCalledWith({});
  });

  it("marks a single unread notification read when it is clicked", () => {
    const mutate = mockMarkRead();
    mockNotificationsQuery([makeNotification({ id: "a", title: "Unread item" })], 1);

    render(createElement(NotificationCenter));
    fireEvent.click(screen.getByText("Unread item"));

    expect(mutate).toHaveBeenCalledWith({ ids: ["a"] });
  });

  it("does not re-mark an already-read notification", () => {
    const mutate = mockMarkRead();
    mockNotificationsQuery(
      [makeNotification({ id: "a", title: "Read item", readAt: new Date().toISOString() })],
      0,
    );

    render(createElement(NotificationCenter));
    fireEvent.click(screen.getByText("Read item"));

    expect(mutate).not.toHaveBeenCalled();
  });
});
