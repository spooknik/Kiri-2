import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { SetupForm } from "./setup-form";

export const metadata: Metadata = { title: "Set up Kiri" };
export const dynamic = "force-dynamic";

/**
 * First-run wizard. Only reachable while the instance has no users; the first
 * account created here becomes the admin (enforced server side in
 * src/lib/auth/registration.ts, not by anything this page sends).
 */
export default async function SetupPage() {
  const userCount = await prisma.user.count();
  if (userCount > 0) {
    redirect("/login");
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-lg border border-card-border bg-card p-6 shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome to Kiri</h1>
        <p className="mt-2 mb-6 text-sm text-secondary">
          Create the first account. It becomes the administrator of this instance.
        </p>
        <SetupForm />
      </div>
    </main>
  );
}
