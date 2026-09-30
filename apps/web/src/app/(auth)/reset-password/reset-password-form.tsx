"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";

const MIN_PASSWORD_LENGTH = 10;

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("The passwords don't match.");
      return;
    }
    setPending(true);
    try {
      const result = await authClient.resetPassword({ newPassword: password, token });
      if (result.error) {
        setError(
          result.error.code === "INVALID_TOKEN"
            ? "This reset link has expired or was already used. Ask an admin for a new one."
            : (result.error.message ?? "Could not reset your password."),
        );
        return;
      }
      router.replace("/login?reset=1");
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <div className="space-y-1">
        <label className="block text-sm font-medium" htmlFor="password">
          New password
        </label>
        <input
          autoComplete="new-password"
          className="focus-ring w-full rounded-md border border-card-border bg-background px-3 py-2 text-sm"
          id="password"
          minLength={MIN_PASSWORD_LENGTH}
          name="password"
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
        <p className="text-xs text-muted">At least {MIN_PASSWORD_LENGTH} characters.</p>
      </div>
      <div className="space-y-1">
        <label className="block text-sm font-medium" htmlFor="confirm">
          Confirm password
        </label>
        <input
          autoComplete="new-password"
          className="focus-ring w-full rounded-md border border-card-border bg-background px-3 py-2 text-sm"
          id="confirm"
          minLength={MIN_PASSWORD_LENGTH}
          name="confirm"
          onChange={(event) => setConfirm(event.target.value)}
          required
          type="password"
          value={confirm}
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
        {pending ? "Working…" : "Set new password"}
      </button>
    </form>
  );
}
