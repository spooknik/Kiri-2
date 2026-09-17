"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";

export function LoginForm({
  next,
  cloudflareEnabled,
}: {
  next: string;
  cloudflareEnabled: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const result = await authClient.signIn.email({ email: email.trim(), password });
    setPending(false);
    if (result.error) {
      setError(result.error.message ?? "Could not sign in with those details.");
      return;
    }
    router.replace(next);
    router.refresh();
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit}>
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
          autoComplete="current-password"
          className="focus-ring w-full rounded-md border border-card-border bg-background px-3 py-2 text-sm"
          id="password"
          name="password"
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
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
        {pending ? "Signing in…" : "Sign in"}
      </button>
      {cloudflareEnabled ? (
        <a
          className="focus-ring block w-full rounded-md border border-card-border px-3 py-2 text-center text-sm font-medium hover:bg-surface-2"
          href={`/api/auth/cf?next=${encodeURIComponent(next)}`}
        >
          Continue with Cloudflare Access
        </a>
      ) : null}
    </form>
  );
}
