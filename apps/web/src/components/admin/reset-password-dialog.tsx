"use client";

import { Button, Dialog } from "@/components/ui";
import { useIssuePasswordReset } from "@/hooks/use-admin";
import type { AdminUserView } from "@/lib/contracts";
import { InviteUrlField } from "./invite-url-field";

export type ResetPasswordDialogProps = {
  user: AdminUserView | null;
  onClose: () => void;
};

/**
 * Confirm, then show a one-time reset link for another user. Kiri sends no
 * email, so the admin passes the link on by hand — like an invite, it is shown
 * once and only a hash is stored.
 */
export function ResetPasswordDialog({ user, onClose }: ResetPasswordDialogProps) {
  const issue = useIssuePasswordReset();

  function handleClose() {
    issue.reset();
    onClose();
  }

  const link = issue.data;

  return (
    <Dialog
      open={user !== null}
      onClose={handleClose}
      title={user ? `Reset password for ${user.displayName}` : "Reset password"}
      description={
        link
          ? "Send this link to them. It works once, and expires " +
            new Date(link.expiresAt).toLocaleString() +
            ". It won't be shown again."
          : "You'll get a one-time link to send them. Their current password keeps working until they use it; then they're signed out everywhere."
      }
    >
      <div className="flex flex-col gap-4">
        {link ? <InviteUrlField url={link.url} /> : null}
        {issue.error ? (
          <p className="rounded-md bg-danger-light px-3 py-2 text-sm text-danger" role="alert">
            {issue.error.message}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          {link ? (
            <Button type="button" onClick={handleClose}>
              Done
            </Button>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => user && issue.mutate(user.id)}
                loading={issue.isPending}
              >
                Create reset link
              </Button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
