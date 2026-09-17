"use client";

import { Bell, WifiOff } from "lucide-react";
import { AppLink } from "@/components/shell/app-link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import type { NotificationView } from "@/lib/contracts";
import { formatRelativeTime } from "@/lib/format";
import {
  getUnreadCount,
  useMarkNotificationsRead,
  useNotifications,
} from "@/hooks/use-notifications";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { groupNotificationsByDay } from "./group-notifications";

export type NotificationCenterProps = {
  /** Called after a notification is opened (used to close the bell's dialog/panel). */
  onNavigate?: () => void;
  /**
   * Hides the built-in "Notifications" heading — set this when the center is
   * already wrapped in a `Dialog` that renders its own title.
   */
  showHeading?: boolean;
  className?: string;
};

/**
 * Notification list content: grouped Today/Earlier, unread dot, "Mark all
 * read", "Load more", empty/error/offline states. Presentation-only — the
 * bell decides whether this renders inside a `Dialog` (mobile) or an
 * anchored panel (desktop).
 */
export function NotificationCenter({
  onNavigate,
  showHeading = true,
  className,
}: NotificationCenterProps) {
  const isOnline = useOnlineStatus();
  const { data, isLoading, isError, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useNotifications();
  const markRead = useMarkNotificationsRead();

  const items = data?.pages.flatMap((page) => page.items) ?? [];
  const unreadCount = getUnreadCount(data);
  const groups = groupNotificationsByDay(items);

  function handleItemClick(item: NotificationView) {
    if (!item.readAt) {
      markRead.mutate({ ids: [item.id] });
    }
    onNavigate?.();
  }

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-card-border px-4 py-3">
        {showHeading ? (
          <div>
            <p className="text-sm font-semibold text-foreground">Notifications</p>
            <p className="text-xs text-muted">
              {unreadCount > 0 ? `${unreadCount} unread` : "All caught up"}
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted">
            {unreadCount > 0 ? `${unreadCount} unread` : "All caught up"}
          </p>
        )}
        {unreadCount > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => markRead.mutate({})}
            loading={markRead.isPending}
          >
            Mark all read
          </Button>
        ) : null}
      </div>

      {!isOnline ? (
        <p className="flex items-center gap-2 border-b border-card-border bg-warning-light px-4 py-2 text-xs text-warning">
          <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          You&apos;re offline. Showing the last notifications that were loaded.
        </p>
      ) : null}

      <div className="max-h-[70vh] overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <Spinner label="Loading notifications" />
          </div>
        ) : isError ? (
          <EmptyState
            icon={Bell}
            title="Couldn't load notifications"
            description="Try again in a moment."
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={Bell}
            title="No notifications yet"
            description="You're all caught up."
          />
        ) : (
          groups.map((group) => (
            <div key={group.label}>
              <p className="px-4 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted">
                {group.label}
              </p>
              {group.items.map((item) => (
                <NotificationRow key={item.id} item={item} onClick={() => handleItemClick(item)} />
              ))}
            </div>
          ))
        )}

        {hasNextPage ? (
          <div className="p-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="w-full"
              onClick={() => void fetchNextPage()}
              loading={isFetchingNextPage}
            >
              Load more
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function NotificationRow({ item, onClick }: { item: NotificationView; onClick: () => void }) {
  const rowClassName = cn(
    "block w-full border-t border-card-border px-4 py-3 text-left transition-colors first:border-t-0 hover:bg-surface-2",
    !item.readAt && "bg-primary/5",
  );

  const content = (
    <div className="flex items-start gap-3">
      <span
        className={cn(
          "mt-1.5 h-2 w-2 shrink-0 rounded-full",
          item.readAt ? "bg-transparent" : "bg-primary",
        )}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium text-foreground">{item.title}</p>
          <span className="shrink-0 text-[11px] text-muted">
            {formatRelativeTime(item.createdAt)}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-muted">{item.message}</p>
      </div>
    </div>
  );

  if (item.link) {
    return (
      <AppLink href={item.link} onClick={onClick} className={rowClassName}>
        {content}
      </AppLink>
    );
  }

  return (
    <button type="button" onClick={onClick} className={rowClassName}>
      {content}
    </button>
  );
}
