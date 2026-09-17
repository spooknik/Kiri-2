"use client";

import { usePathname } from "next/navigation";
import { BookOpen, CloudOff, Plus, User } from "lucide-react";
import { cn } from "@/lib/cn";
import { AppLink } from "./app-link";

const NAV_ITEMS = [
  { href: "/", label: "Library", icon: BookOpen },
  { href: "/add", label: "Add", icon: Plus },
  { href: "/offline", label: "Offline", icon: CloudOff },
  { href: "/profile", label: "Profile", icon: User },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-50 min-h-[var(--shell-bottom-nav-height)] border-t border-card-border bg-card/80 pb-[env(safe-area-inset-bottom)] backdrop-blur-lg"
    >
      <div className="mx-auto flex max-w-2xl items-center justify-around">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <AppLink
              key={href}
              href={href}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "focus-ring flex min-h-11 flex-1 flex-col items-center gap-1 py-3 text-xs transition-colors",
                isActive
                  ? "rounded-lg bg-primary/10 text-primary"
                  : "text-muted hover:text-foreground",
              )}
            >
              <Icon className="h-6 w-6" aria-hidden="true" />
              <span>{label}</span>
            </AppLink>
          );
        })}
      </div>
    </nav>
  );
}
