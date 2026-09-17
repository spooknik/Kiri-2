"use client";

import { useState } from "react";
import { AlertTriangle, Users } from "lucide-react";
import {
  Badge,
  Card,
  CardContent,
  EmptyState,
  Select,
  Spinner,
  Switch,
  useToast,
} from "@/components/ui";
import { useAdminUsers, useUpdateAdminUser } from "@/hooks/use-admin";
import type { AdminUserView, Role } from "@/lib/contracts";
import { BanUserDialog } from "./ban-user-dialog";

export function UsersTable({ currentUserId }: { currentUserId: string }) {
  const { data, isLoading, isError } = useAdminUsers();
  const updateUser = useUpdateAdminUser();
  const { toast } = useToast();
  const [banTarget, setBanTarget] = useState<AdminUserView | null>(null);

  function handleRoleChange(user: AdminUserView, role: Role) {
    if (role === user.role) return;
    updateUser.mutate(
      { id: user.id, input: { role } },
      {
        onSuccess: () => toast({ title: `${user.displayName} is now ${role}`, tone: "success" }),
        onError: (error) =>
          toast({ title: "Couldn't update role", description: error.message, tone: "danger" }),
      },
    );
  }

  function handleBanToggle(user: AdminUserView, banned: boolean) {
    if (banned) {
      setBanTarget(user);
      return;
    }
    updateUser.mutate(
      { id: user.id, input: { banned: false, banReason: null } },
      {
        onSuccess: () => toast({ title: `${user.displayName} unbanned`, tone: "success" }),
        onError: (error) =>
          toast({ title: "Couldn't unban user", description: error.message, tone: "danger" }),
      },
    );
  }

  function confirmBan(reason: string) {
    if (!banTarget) return;
    const target = banTarget;
    updateUser.mutate(
      { id: target.id, input: { banned: true, banReason: reason || null } },
      {
        onSuccess: () => {
          toast({ title: `${target.displayName} banned`, tone: "success" });
          setBanTarget(null);
        },
        onError: (error) =>
          toast({ title: "Couldn't ban user", description: error.message, tone: "danger" }),
      },
    );
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Spinner label="Loading users" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn't load users"
        description="Try refreshing the page."
      />
    );
  }

  if (data.length === 0) {
    return <EmptyState icon={Users} title="No users yet" />;
  }

  return (
    <div className="flex flex-col gap-3">
      {data.map((user) => {
        const isSelf = user.id === currentUserId;
        return (
          <Card key={user.id}>
            <CardContent className="flex flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">
                    {user.displayName}
                  </p>
                  <p className="truncate text-xs text-muted">{user.email}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {user.banned ? <Badge tone="danger">Banned</Badge> : null}
                  {user.mustSetPassword ? <Badge tone="warning">No password</Badge> : null}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs text-muted">
                <p>Created {new Date(user.createdAt).toLocaleDateString()}</p>
                <p>
                  {user.seriesTracked} tracked · {user.seriesCreated} created
                </p>
              </div>

              {user.banned && user.banReason ? (
                <p className="rounded-md bg-danger-light px-2 py-1 text-xs text-danger">
                  Reason: {user.banReason}
                </p>
              ) : null}

              <div className="flex flex-wrap items-center gap-4 border-t border-card-border pt-3">
                <label className="flex items-center gap-2 text-xs font-medium text-secondary">
                  Role
                  <Select
                    value={user.role}
                    disabled={isSelf || updateUser.isPending}
                    onChange={(event) => handleRoleChange(user, event.target.value as Role)}
                    aria-label={`Role for ${user.displayName}`}
                    className="h-9 w-32"
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </Select>
                </label>
                <label className="flex items-center gap-2 text-xs font-medium text-secondary">
                  Banned
                  <Switch
                    checked={user.banned}
                    disabled={isSelf || updateUser.isPending}
                    onCheckedChange={(value) => handleBanToggle(user, value)}
                    aria-label={`Ban ${user.displayName}`}
                  />
                </label>
                {isSelf ? (
                  <p className="text-xs text-muted">
                    You can&apos;t change your own role or ban status.
                  </p>
                ) : null}
              </div>
            </CardContent>
          </Card>
        );
      })}

      <BanUserDialog
        open={banTarget !== null}
        userName={banTarget?.displayName ?? ""}
        pending={updateUser.isPending}
        onClose={() => setBanTarget(null)}
        onConfirm={confirmBan}
      />
    </div>
  );
}
