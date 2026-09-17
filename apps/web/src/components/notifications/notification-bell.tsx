"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { useMediaQuery } from "@/hooks/use-media-query";
import { getUnreadCount, useNotifications } from "@/hooks/use-notifications";
import { NotificationCenter } from "./notification-center";

/**
 * Header bell: unread badge + opens `NotificationCenter`. Below the `sm`
 * breakpoint it opens as a full `Dialog`; at `sm` and above it opens as a
 * popover-style card anchored under the button (closes on outside
 * click/Escape, like the v1 notification center).
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const isDesktop = useMediaQuery("(min-width: 640px)");
  const containerRef = useRef<HTMLDivElement>(null);
  const { data } = useNotifications();
  const unreadCount = getUnreadCount(data);
  const badgeLabel = unreadCount > 99 ? "99+" : String(unreadCount);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open || !isDesktop) return;

    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        close();
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, isDesktop, close]);

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="focus-ring relative flex h-11 w-11 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-foreground"
      >
        <Bell className="h-5 w-5" aria-hidden="true" />
        {unreadCount > 0 ? (
          <span
            aria-hidden="true"
            className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-white"
          >
            {badgeLabel}
          </span>
        ) : null}
      </button>

      {isDesktop ? (
        open ? (
          <div
            role="dialog"
            aria-label="Notifications"
            className="absolute right-0 top-full z-50 mt-2 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-card-border bg-card shadow-lg"
          >
            <NotificationCenter onNavigate={close} />
          </div>
        ) : null
      ) : (
        <Dialog open={open} onClose={close} title="Notifications" className="max-w-sm">
          <NotificationCenter onNavigate={close} showHeading={false} className="-m-4" />
        </Dialog>
      )}
    </div>
  );
}
