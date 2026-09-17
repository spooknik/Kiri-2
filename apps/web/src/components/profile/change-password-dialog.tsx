"use client";

/**
 * Change/set-password dialog.
 *
 * NOTE (mustSetPassword): better-auth's client-exposed `changePassword`
 * endpoint (`POST /api/auth/change-password`) always requires
 * `currentPassword` server-side — it looks up the user's existing credential
 * account and 400s with `CREDENTIAL_ACCOUNT_NOT_FOUND` when there isn't one,
 * regardless of what's sent. The server-only `setPassword` endpoint (no
 * current password required) is not exposed on the client at all. So for a
 * user who has never had a password (`mustSetPassword: true`, e.g. imported
 * from v1), this dialog renders a "Set password" form without the current
 * field and posts to `POST /api/auth/set-password` instead, which calls
 * `auth.api.setPassword` server-side. A user who already has a password
 * keeps using `authClient.changePassword`, unchanged.
 */
import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, Field, Input, useToast } from "@/components/ui";
import { ApiClientError, api } from "@/lib/api-client";
import { authClient } from "@/lib/auth/client";
import { queryKeys } from "@/lib/query-keys";

export type ChangePasswordDialogProps = {
  open: boolean;
  onClose: () => void;
  mustSetPassword: boolean;
};

// Matches better-auth's `emailAndPassword.minPasswordLength` (src/lib/auth/server.ts).
const MIN_PASSWORD_LENGTH = 10;

export function ChangePasswordDialog({
  open,
  onClose,
  mustSetPassword,
}: ChangePasswordDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New password and confirmation don't match.");
      return;
    }
    if (!mustSetPassword && !currentPassword) {
      setError("Enter your current password.");
      return;
    }

    setPending(true);

    if (mustSetPassword) {
      try {
        await api.post("/api/auth/set-password", { newPassword });
      } catch (err) {
        setPending(false);
        setError(err instanceof ApiClientError ? err.message : "Couldn't set your password.");
        return;
      }
      setPending(false);
      toast({ title: "Password set", tone: "success" });
      void queryClient.invalidateQueries({ queryKey: queryKeys.profile });
      handleClose();
      return;
    }

    const result = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    });
    setPending(false);

    if (result.error) {
      setError(result.error.message ?? "Couldn't change your password.");
      return;
    }

    toast({ title: "Password changed", tone: "success" });
    handleClose();
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={mustSetPassword ? "Set password" : "Change password"}
    >
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        {!mustSetPassword ? (
          <Field label="Current password" htmlFor="current-password" required>
            <Input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
            />
          </Field>
        ) : null}
        <Field label="New password" htmlFor="new-password" required>
          <Input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            required
          />
        </Field>
        <Field label="Confirm new password" htmlFor="confirm-password" required>
          <Input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            required
          />
        </Field>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            {mustSetPassword ? "Set password" : "Change password"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
