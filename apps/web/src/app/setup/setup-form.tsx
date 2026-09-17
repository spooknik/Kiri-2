"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";

export function SetupForm() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const result = await authClient.signUp.email({
      name: displayName.trim(),
      displayName: displayName.trim(),
      email: email.trim(),
      password,
    });
    setPending(false);
    if (result.error) {
      setError(result.error.message ?? "Could not create the first account.");
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit}>
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
      <div className="space-y-1">
        <label className="block text-sm font-medium" htmlFor="email">
          Email
        </label>
        <input
          autoComplete="email"
          className="focus-ring w-full rounded-md border border-card-border bg-background px-3 py-2 text-sm"
          id="email"
          name="email"
          onChange={(event) => setEmail(event.target.value)}
          required
          type="email"
          value={email}
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
        {pending ? "Creating…" : "Create admin account"}
      </button>
    </form>
  );
}
