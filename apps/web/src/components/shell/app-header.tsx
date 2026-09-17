import { User } from "lucide-react";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { AppLink } from "./app-link";

// Padded to exactly 12 chars wide x 4 lines tall. Ported from Kiri v1's
// `AppHeader` mascot (the "spicy mode" long-press toggle is intentionally
// NOT ported — adult-content filtering is server-side in V2).
const MASCOT = `    o  o    
  ( "--" )  
 ( >____< ) 
  ^^    ^^  `;

export type AppHeaderProps = {
  user?: { displayName: string };
};

export function AppHeader({ user }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-40 min-h-[var(--shell-header-height)] border-b border-card-border bg-card/80 pt-safe backdrop-blur-lg">
      <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-3">
        <AppLink
          href="/"
          className="focus-ring flex min-w-0 items-center gap-3 rounded-md"
          aria-label="Kiri home"
        >
          <pre
            className="leading-none text-[10px] text-primary"
            aria-hidden="true"
            style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
          >
            {MASCOT}
          </pre>
          <span className="min-w-0">
            <span className="block text-lg font-bold leading-tight tracking-tight text-foreground">
              Kiri
            </span>
            <span className="block truncate text-[11px] leading-tight text-muted">
              {user ? `Hi, ${user.displayName}` : "Track manga with friends"}
            </span>
          </span>
        </AppLink>

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
