"use client";

import { usePathname } from "next/navigation";
import { AppLink } from "@/components/shell/app-link";
import { cn } from "@/lib/cn";

const ITEMS = [
  { href: "/admin/users", label: "Users" },
  { href: "/admin/invites", label: "Invites" },
  { href: "/admin/jobs", label: "Jobs" },
  { href: "/admin/plugins", label: "Plugins" },
  { href: "/admin/settings", label: "Settings" },
  { href: "/admin/audit", label: "Audit" },
  { href: "/admin/import-v1", label: "Import from 1.x" },
] as const;

export function AdminNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Admin sections"
      className="scrollbar-hide flex items-center gap-1 overflow-x-auto border-b border-card-border"
    >
      {ITEMS.map((item) => {
        const active = pathname?.startsWith(item.href) ?? false;
        return (
          <AppLink
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "focus-ring min-h-11 whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors",
              active
                ? "border-primary text-primary"
                : "border-transparent text-muted hover:text-foreground",
            )}
          >
            {item.label}
          </AppLink>
        );
      })}
    </nav>
  );
}
