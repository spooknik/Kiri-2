"use client";

import { useState } from "react";
import { Button, Dialog, Field, Textarea } from "@/components/ui";

export type BanUserDialogProps = {
  open: boolean;
  userName: string;
  pending: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
};

/** Confirmation dialog collecting an optional ban reason before banning a user. */
export function BanUserDialog({ open, userName, pending, onClose, onConfirm }: BanUserDialogProps) {
  const [reason, setReason] = useState("");

  function handleClose() {
    setReason("");
    onClose();
  }

  function handleConfirm() {
    onConfirm(reason.trim());
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={userName ? `Ban ${userName}` : "Ban user"}
      description="They'll be signed out and unable to sign back in until unbanned."
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Reason (optional)"
          htmlFor="ban-reason"
          help="Shown to admins on this user's row."
        >
          <Textarea
            value={reason}
            maxLength={300}
            rows={3}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={handleConfirm} loading={pending}>
            Ban user
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
