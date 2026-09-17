"use client";

import { useState } from "react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Select,
  Switch,
  useToast,
} from "@/components/ui";
import { OPTIMIZER_FORMATS, type ProfileView } from "@/lib/contracts";
import { useUpdateProfile } from "@/hooks/use-profile";

type OptimizerFormat = ProfileView["optimizerFormat"];

export function PreferencesCard({ profile }: { profile: ProfileView }) {
  const updateProfile = useUpdateProfile();
  const { toast } = useToast();
  const [quality, setQuality] = useState(profile.optimizerQuality);
  const [format, setFormat] = useState<OptimizerFormat>(profile.optimizerFormat);
  // Tracks the last server values the slider/select were synced to, so a
  // fresh `profile` (e.g. after a refetch) can reset local edits without
  // calling setState from an effect (React docs: "adjusting state when a
  // prop changes" is done during render, not in useEffect).
  const [syncedFrom, setSyncedFrom] = useState({
    quality: profile.optimizerQuality,
    format: profile.optimizerFormat,
  });
  if (
    syncedFrom.quality !== profile.optimizerQuality ||
    syncedFrom.format !== profile.optimizerFormat
  ) {
    setSyncedFrom({ quality: profile.optimizerQuality, format: profile.optimizerFormat });
    setQuality(profile.optimizerQuality);
    setFormat(profile.optimizerFormat);
  }

  const optimizerDirty = quality !== profile.optimizerQuality || format !== profile.optimizerFormat;

  function handleAdultChange(value: boolean) {
    updateProfile.mutate(
      { showAdult: value },
      {
        onError: (error) =>
          toast({ title: "Couldn't save preference", description: error.message, tone: "danger" }),
      },
    );
  }

  function handleSpoilersChange(value: boolean) {
    updateProfile.mutate(
      { showSpoilers: value },
      {
        onError: (error) =>
          toast({ title: "Couldn't save preference", description: error.message, tone: "danger" }),
      },
    );
  }

  function saveOptimizer() {
    updateProfile.mutate(
      { optimizerQuality: quality, optimizerFormat: format },
      {
        onSuccess: () => toast({ title: "Optimizer preferences saved", tone: "success" }),
        onError: (error) =>
          toast({ title: "Couldn't save", description: error.message, tone: "danger" }),
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Preferences</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Show adult content</p>
            <p className="text-xs text-muted">
              Reveals series and covers marked as adult in the library and search.
            </p>
          </div>
          <Switch
            checked={profile.showAdult}
            onCheckedChange={handleAdultChange}
            aria-label="Show adult content"
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Show spoilers</p>
            <p className="text-xs text-muted">
              Skips the spoiler-safe collapse on notes past your reading progress.
            </p>
          </div>
          <Switch
            checked={profile.showSpoilers}
            onCheckedChange={handleSpoilersChange}
            aria-label="Show spoilers"
          />
        </div>

        <div className="flex flex-col gap-3 border-t border-card-border pt-4">
          <div>
            <p className="text-sm font-medium text-foreground">Media optimizer</p>
            <p className="text-xs text-muted">
              Format and quality used when converting downloaded pages.
            </p>
          </div>
          <Field label={`Quality (${quality})`} htmlFor="optimizer-quality">
            <input
              type="range"
              min={30}
              max={100}
              value={quality}
              onChange={(event) => setQuality(Number(event.target.value))}
              className="h-11 w-full accent-primary"
            />
          </Field>
          <Field label="Format" htmlFor="optimizer-format">
            <Select
              value={format}
              onChange={(event) => setFormat(event.target.value as OptimizerFormat)}
            >
              {OPTIMIZER_FORMATS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            type="button"
            size="sm"
            className="self-start"
            onClick={saveOptimizer}
            disabled={!optimizerDirty}
            loading={updateProfile.isPending}
          >
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
