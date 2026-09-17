"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";

/** Calls better-auth's POST /api/auth/sign-out, then sends you to /login. */
export function LogoutRunner() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    void authClient.signOut().finally(() => {
      if (cancelled) return;
      router.replace("/login");
      router.refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return <p className="text-center text-sm text-secondary">Signing out…</p>;
}
