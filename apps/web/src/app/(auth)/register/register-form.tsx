"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";

interface RegisterFormProps {
  /** "claim" sets a password on an imported account instead of creating one. */
  mode: "signup" | "claim";
  inviteToken: string;
  email: string | null;
}

export function RegisterForm({ mode, inviteToken, email }: RegisterFormProps) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [address, setAddress] = useState(email ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const emailLocked = mode === "claim" || Boolean(email);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (mode === "claim") {
        const response = await fetch("/api/auth/claim-invite", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: inviteToken, password }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          setError(body?.error?.message ?? "Could not set your password.");
          return;
        }
      } else {
        const result = await authClient.signUp.email({
          name: displayName.trim(),
          displayName: displayName.trim(),
          email: address.trim(),
          password,
          ...(inviteToken ? { inviteToken } : {}),
        });
        if (result.error) {
          setError(result.error.message ?? "Could not create your account.");
          return;
        }
      }
      router.replace("/");
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      {mode === "signup" ? (
        <div className="space-y-1">
          <label className="block text-sm font-medium" htmlFor="displayName">
            Display name
          </label>
          <input
            autoComplete="nickname"
            className="focus-ring w-full rounded-md border border-card-border bg-background px-3 py-2 text-sm"
            id="displayName"
            name="displayName"
            onChange={(event) => setDisplayName(event.target.value)}
            required
            value={displayName}
          />
        </div>
      ) : null}
      <div className="space-y-1">
        <label className="block text-sm font-medium" htmlFor="email">
          Email
        </label>
        <input
          autoComplete="email"
          className="focus-ring w-full rounded-md border border-card-border bg-background px-3 py-2 text-sm disabled:opacity-70"
          disabled={emailLocked}
          id="email"
          name="email"
          onChange={(event) => setAddress(event.target.value)}
          required
          type="email"
          value={address}
        />
      </div>
      <div className="space-y-1">
        <label className="block text-sm font-medium" htmlFor="password">
          Password
        </label>
        <input
          autoComplete="new-password"
          className="focus-ring w-full rounded-md border border-card-border bg-background px-3 py-2 text-sm"
          id="password"
          minLength={10}
          name="password"
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
        <p className="text-xs text-muted">At least 10 characters.</p>
      </div>
      {error ? (
        <p className="rounded-md bg-danger-light px-3 py-2 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <button
        className="focus-ring w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-60"
        disabled={pending}
        type="submit"
      >
        {pending ? "Working…" : mode === "claim" ? "Set password" : "Create account"}
      </button>
    </form>
  );
}
