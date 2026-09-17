"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  useToast,
} from "@/components/ui";
import type { ProfileView } from "@/lib/contracts";
import { useUpdateProfile } from "@/hooks/use-profile";

export function IdentityCard({ profile }: { profile: ProfileView }) {
  const updateProfile = useUpdateProfile();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(profile.displayName);

  function startEdit() {
    setName(profile.displayName);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setName(profile.displayName);
  }

  function save() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === profile.displayName) {
      setEditing(false);
      return;
    }
    updateProfile.mutate(
      { displayName: trimmed },
      {
        onSuccess: () => {
          setEditing(false);
          toast({ title: "Display name updated", tone: "success" });
        },
        onError: (error) => {
          toast({ title: "Couldn't update name", description: error.message, tone: "danger" });
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="flex items-center gap-2">
              <Input
                autoFocus
                value={name}
                maxLength={60}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") save();
                  if (event.key === "Escape") cancelEdit();
                }}
                aria-label="Display name"
                className="h-9"
              />
              <Button type="button" size="sm" onClick={save} loading={updateProfile.isPending}>
                Save
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={cancelEdit}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <CardTitle className="truncate">{profile.displayName}</CardTitle>
              <button
                type="button"
                onClick={startEdit}
                aria-label="Edit display name"
                className="focus-ring flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-foreground"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          )}
          <p className="mt-1 truncate text-sm text-muted">{profile.email}</p>
        </div>
        <Badge
          tone={profile.role === "admin" ? "primary" : "neutral"}
          className="shrink-0 capitalize"
        >
          {profile.role}
        </Badge>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted">
          Member since {new Date(profile.createdAt).toLocaleDateString()}
        </p>
      </CardContent>
    </Card>
  );
}
