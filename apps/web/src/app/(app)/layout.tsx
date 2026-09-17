import type { ReactNode } from "react";
import { AppHeader } from "@/components/shell/app-header";
import { BottomNav } from "@/components/shell/bottom-nav";
import { PageContainer } from "@/components/shell/page-container";

/**
 * App shell for all authenticated/tracker routes: header, centered page
 * content, and the fixed bottom nav. Server component — the interactive
 * pieces (AppLink, BottomNav's usePathname) are client components rendered
 * from here.
 */
export default function AppShellLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader />
      <PageContainer>{children}</PageContainer>
      <BottomNav />
    </div>
  );
}
