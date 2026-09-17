"use client";

import { useState, type FormEvent } from "react";
import { AlertTriangle, Mail } from "lucide-react";
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  useToast,
} from "@/components/ui";
import { formatRelativeTime } from "@/lib/format";
import { useAdminInvites, useCreateInvite, useRevokeInvite } from "@/hooks/use-admin";
import type { InviteStatus, InviteView, Role } from "@/lib/contracts";
import { InviteUrlField } from "./invite-url-field";

const STATUS_TONE: Record<InviteStatus, BadgeTone> = {
  PENDING: "primary",
  ACCEPTED: "success",
  REVOKED: "neutral",
  EXPIRED: "warning",
};

const EXPIRY_OPTIONS = [1, 7, 14, 30, 90] as const;

export function InvitesPanel() {
  const { data, isLoading, isError } = useAdminInvites();
  const createInvite = useCreateInvite();
  const revokeInvite = useRevokeInvite();
  const { toast } = useToast();

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [expiresInDays, setExpiresInDays] = useState(14);
  const [justCreated, setJustCreated] = useState<InviteView | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createInvite.mutate(
      { email: email.trim() || null, role, expiresInDays },
      {
        onSuccess: (invite) => {
          setJustCreated(invite);
          setEmail("");
          setRole("member");
          setExpiresInDays(14);
          toast({ title: "Invite created", tone: "success" });
        },
        onError: (error) =>
          toast({ title: "Couldn't create invite", description: error.message, tone: "danger" }),
      },
    );
  }

  function handleRevoke(invite: InviteView) {
    revokeInvite.mutate(invite.id, {
      onSuccess: () => toast({ title: "Invite revoked", tone: "success" }),
      onError: (error) =>
        toast({ title: "Couldn't revoke invite", description: error.message, tone: "danger" }),
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Create invite</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
            <Field
              label="Email (optional)"
              htmlFor="invite-email"
              help="Pins the invite to one address; leave blank for anyone with the link."
            >
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="friend@example.com"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Role" htmlFor="invite-role">
                <Select value={role} onChange={(event) => setRole(event.target.value as Role)}>
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </Select>
              </Field>
              <Field label="Expires in" htmlFor="invite-expires">
                <Select
                  value={expiresInDays}
                  onChange={(event) => setExpiresInDays(Number(event.target.value))}
                >
                  {EXPIRY_OPTIONS.map((days) => (
                    <option key={days} value={days}>
                      {days} {days === 1 ? "day" : "days"}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button type="submit" className="self-start" loading={createInvite.isPending}>
              Create invite
            </Button>
          </form>

          {justCreated?.url ? (
            <div className="mt-4 rounded-lg border border-primary/30 bg-primary-light p-3">
              <p className="text-sm font-medium text-foreground">Invite link (shown once)</p>
              <p className="mt-0.5 text-xs text-muted">
                Copy this now — it won&apos;t be shown again after you leave this page.
              </p>
              <div className="mt-2">
                <InviteUrlField url={justCreated.url} />
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        {isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner label="Loading invites" />
          </div>
        ) : isError || !data ? (
          <EmptyState
            icon={AlertTriangle}
            title="Couldn't load invites"
            description="Try refreshing the page."
          />
        ) : data.length === 0 ? (
          <EmptyState
            icon={Mail}
            title="No invites yet"
            description="Create one above to invite someone."
          />
        ) : (
          data.map((invite) => (
            <Card key={invite.id}>
              <CardContent className="flex flex-col gap-2 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {invite.email ?? "Anyone with the link"}
                    </p>
                    <p className="text-xs text-muted">
                      {invite.role} · invited by {invite.createdBy.displayName}
                    </p>
                  </div>
                  <Badge tone={STATUS_TONE[invite.status]} className="shrink-0 capitalize">
                    {invite.status.toLowerCase()}
                  </Badge>
                </div>
                <p className="text-xs text-muted">
                  {invite.status === "PENDING"
                    ? `Expires ${formatRelativeTime(invite.expiresAt)}`
                    : invite.status === "ACCEPTED" && invite.redeemedBy
                      ? `Redeemed by ${invite.redeemedBy.displayName}`
                      : `Created ${formatRelativeTime(invite.createdAt)}`}
                </p>
                {invite.status === "PENDING" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="self-start text-danger"
                    onClick={() => handleRevoke(invite)}
                    loading={revokeInvite.isPending}
                  >
                    Revoke
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
