"use client";

import { useRef, type MouseEvent } from "react";
import { useToast } from "@/components/ui";
import { useProfile, useUpdateProfile } from "@/hooks/use-profile";
import { cn } from "@/lib/cn";
import { AppLink } from "./app-link";

// Both mascots are padded to exactly 12 chars wide x 4 lines tall (padded in
// code, since editors strip trailing spaces) so swapping them never shifts the
// header. Ported from Kiri v1's `AppHeader`, including its "spicy mode"
// long-press toggle.
function mascot(lines: string[]): string {
  return lines.map((line) => line.padEnd(12)).join("\n");
}

const NORMAL_MASCOT = mascot(["    o  o", '  ( "--" )', " ( >____< )", "  ^^    ^^"]);
const SPICY_MASCOT = mascot(["  ~ @  @ ~", ' ~( "--" )~', " ( >____< )", "  ~^ ~~ ^~"]);

const LONG_PRESS_MS = 600;

export type MascotLinkProps = {
  subtitle: string;
};

/**
 * The header's home link. A tap goes home; a long press flips the profile's
 * "Show adult content" preference (the same one the Profile page's switch
 * writes), so adult series disappear from the library server-side.
 */
export function MascotLink({ subtitle }: MascotLinkProps) {
  const profile = useProfile();
  const updateProfile = useUpdateProfile();
  const { toast } = useToast();
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didToggle = useRef(false);

  // Show the new state while the PATCH is in flight.
  const spicy =
    (updateProfile.isPending ? updateProfile.variables?.showAdult : undefined) ??
    profile.data?.showAdult ??
    false;

  function toggle() {
    // Without the current value (offline, still loading) there is nothing to flip.
    if (!profile.data || updateProfile.isPending) return;
    navigator.vibrate?.(30);
    updateProfile.mutate(
      { showAdult: !profile.data.showAdult },
      {
        onError: (error) =>
          toast({
            title: "Couldn't change adult content",
            description: error.message,
            tone: "danger",
          }),
      },
    );
  }

  function startPress() {
    didToggle.current = false;
    endPress();
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null;
      didToggle.current = true;
      toggle();
    }, LONG_PRESS_MS);
  }

  function endPress() {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    // The press that toggled must not also navigate home.
    if (didToggle.current) {
      event.preventDefault();
      didToggle.current = false;
    }
  }

  return (
    <AppLink
      href="/"
      className="focus-ring flex min-w-0 select-none items-center gap-3 rounded-md"
      aria-label="Kiri home"
      onClick={handleClick}
      onPointerDown={startPress}
      onPointerUp={endPress}
      onPointerLeave={endPress}
      onPointerCancel={endPress}
      onContextMenu={(event) => event.preventDefault()}
      style={{ WebkitTouchCallout: "none" }}
    >
      <pre
        className={cn(
          "leading-none text-[10px] transition-colors",
          spicy ? "text-danger" : "text-primary",
        )}
        aria-hidden="true"
        style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
      >
        {spicy ? SPICY_MASCOT : NORMAL_MASCOT}
      </pre>
      <span className="min-w-0">
        <span className="block text-lg font-bold leading-tight tracking-tight text-foreground">
          Kiri
        </span>
        <span className="block truncate text-[11px] leading-tight text-muted">
          {spicy ? "🌶️ Spicy mode" : subtitle}
        </span>
      </span>
    </AppLink>
  );
}
