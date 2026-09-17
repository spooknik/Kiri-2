import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { AdminNav } from "@/components/admin/admin-nav";
import { requireUser } from "@/lib/auth/session";

/** Gates the whole /admin subtree to admins and renders the section sub-nav. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  if (user.role !== "admin") {
    notFound();
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-bold text-foreground">Admin</h1>
        <p className="text-sm text-muted">Manage users, invites, and instance settings.</p>
      </div>
      <AdminNav />
      {children}
    </div>
  );
}
