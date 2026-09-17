"use client";

import { useState } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { AppLink } from "@/components/shell/app-link";
import { Button, Card, CardContent, EmptyState, Spinner } from "@/components/ui";
import { authClient } from "@/lib/auth/client";
import { useProfile } from "@/hooks/use-profile";
import { ChangePasswordDialog } from "./change-password-dialog";
import { IdentityCard } from "./identity-card";
import { PreferencesCard } from "./preferences-card";
import { SessionsCard } from "./sessions-card";
import { StatsCard } from "./stats-card";

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";

/** Client-side assembly of the whole /profile page; fetches via `useProfile()`. */
export function ProfileView() {
  const { data: profile, isLoading, isError } = useProfile();
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);

  async function handleSignOut() {
    await authClient.signOut();
    // Intentionally a hard navigation (per spec), not router.push(): it
    // guarantees client caches (TanStack Query, etc.) don't briefly render
    // stale authenticated state on the way out.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/login";
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner label="Loading profile" />
      </div>
    );
  }

  if (isError || !profile) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn't load your profile"
        description="Check your connection and try again."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <IdentityCard profile={profile} />
      <PreferencesCard profile={profile} />
      <StatsCard stats={profile.stats} />

      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <div>
            <p className="text-sm font-medium text-foreground">Password</p>
            <p className="text-xs text-muted">
              {profile.mustSetPassword
                ? "This account doesn't have a password set yet."
                : "Change the password used to sign in."}
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            className="self-start"
            onClick={() => setPasswordDialogOpen(true)}
          >
            {profile.mustSetPassword ? "Set password" : "Change password"}
          </Button>
        </CardContent>
      </Card>

      <SessionsCard />

      {profile.role === "admin" ? (
        <AppLink
          href="/admin"
          className="focus-ring flex items-center gap-3 rounded-lg border border-card-border bg-card p-4 shadow-sm hover:bg-surface-2"
        >
          <ShieldCheck className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium text-foreground">Admin</p>
            <p className="text-xs text-muted">Manage users, invites, and instance settings.</p>
          </div>
        </AppLink>
      ) : null}

      <Button type="button" variant="secondary" onClick={() => void handleSignOut()}>
        Sign out
      </Button>

      <p className="pb-2 text-center text-xs text-muted">Kiri {APP_VERSION}</p>

      <ChangePasswordDialog
        open={passwordDialogOpen}
        onClose={() => setPasswordDialogOpen(false)}
        mustSetPassword={profile.mustSetPassword}
      />
    </div>
  );
}
