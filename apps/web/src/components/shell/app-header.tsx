import { User } from "lucide-react";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { AppLink } from "./app-link";
import { MascotLink } from "./mascot-link";

export type AppHeaderProps = {
  user?: { displayName: string };
};

export function AppHeader({ user }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-40 min-h-[var(--shell-header-height)] border-b border-card-border bg-card/80 pt-safe backdrop-blur-lg">
      <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-3">
        <MascotLink subtitle={user ? `Hi, ${user.displayName}` : "Track manga with friends"} />

        <div className="flex shrink-0 items-center gap-1">
          <NotificationBell />
          <AppLink
            href="/profile"
            aria-label="Profile"
            className="focus-ring flex h-11 w-11 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-foreground"
          >
            <User className="h-5 w-5" aria-hidden="true" />
          </AppLink>
        </div>
      </div>
    </header>
  );
}
