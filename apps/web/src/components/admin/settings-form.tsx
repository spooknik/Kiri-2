"use client";

import { useState, type FormEvent } from "react";
import { AlertTriangle } from "lucide-react";
import {
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
  Switch,
  useToast,
} from "@/components/ui";
import {
  AUTO_SYNC_PRESETS_MINUTES,
  REGISTRATION_MODES,
  type AppSettingsView,
  type RegistrationMode,
} from "@/lib/contracts";
import { useAdminSettings, useUpdateAdminSettings } from "@/hooks/use-admin";

const REGISTRATION_MODE_LABEL: Record<RegistrationMode, string> = {
  INVITE: "Invite only",
  OPEN: "Open",
  CLOSED: "Closed",
};

const REGISTRATION_MODE_HELP: Record<RegistrationMode, string> = {
  INVITE: "Only people with an invite link can register.",
  OPEN: "Anyone can create an account from the sign-up page.",
  CLOSED: "No new accounts can be created, invites included.",
};

const INTERVAL_LABELS: Record<(typeof AUTO_SYNC_PRESETS_MINUTES)[number], string> = {
  360: "Every 6 hours",
  720: "Every 12 hours",
  1440: "Every 24 hours",
  2880: "Every 2 days",
  10080: "Every week",
};

type FormState = Pick<
  AppSettingsView,
  | "instanceName"
  | "registrationMode"
  | "autoSyncEnabled"
  | "autoSyncIntervalMinutes"
  | "verbosePluginLogging"
  | "notificationRetentionDays"
  | "jobLogRetentionDays"
>;

function toFormState(settings: AppSettingsView): FormState {
  return {
    instanceName: settings.instanceName,
    registrationMode: settings.registrationMode,
    autoSyncEnabled: settings.autoSyncEnabled,
    autoSyncIntervalMinutes: settings.autoSyncIntervalMinutes,
    verbosePluginLogging: settings.verbosePluginLogging,
    notificationRetentionDays: settings.notificationRetentionDays,
    jobLogRetentionDays: settings.jobLogRetentionDays,
  };
}

export function SettingsForm() {
  const { data, isLoading, isError } = useAdminSettings();
  const updateSettings = useUpdateAdminSettings();
  const { toast } = useToast();
  const [form, setForm] = useState<FormState | null>(null);
  // Tracks the last server payload the form was seeded from, so a fresh
  // `data` (e.g. after a refetch) can reset local edits without calling
  // setState from an effect (React docs: "adjusting state when a prop
  // changes" is done during render, not in useEffect).
  const [syncedFrom, setSyncedFrom] = useState<AppSettingsView | null>(null);
  if (data && data !== syncedFrom) {
    setSyncedFrom(data);
    setForm(toFormState(data));
  }

  if (isError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn't load settings"
        description="Try refreshing the page."
      />
    );
  }

  if (isLoading || !form) {
    return (
      <div className="flex justify-center py-10">
        <Spinner label="Loading settings" />
      </div>
    );
  }

  const dirty = data ? JSON.stringify(form) !== JSON.stringify(toFormState(data)) : false;

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) return;
    updateSettings.mutate(form, {
      onSuccess: () => toast({ title: "Settings saved", tone: "success" }),
      onError: (error) =>
        toast({ title: "Couldn't save settings", description: error.message, tone: "danger" }),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Instance settings</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <Field label="Instance name" htmlFor="instance-name">
            <Input
              value={form.instanceName}
              maxLength={60}
              onChange={(event) => update("instanceName", event.target.value)}
            />
          </Field>

          <Field
            label="Registration"
            htmlFor="registration-mode"
            help={REGISTRATION_MODE_HELP[form.registrationMode]}
          >
            <Select
              value={form.registrationMode}
              onChange={(event) =>
                update("registrationMode", event.target.value as RegistrationMode)
              }
            >
              {REGISTRATION_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {REGISTRATION_MODE_LABEL[mode]}
                </option>
              ))}
            </Select>
          </Field>

          <div className="flex items-center justify-between gap-3 border-t border-card-border pt-4">
            <div>
              <p className="text-sm font-medium text-foreground">Auto-sync</p>
              <p className="text-xs text-muted">
                Automatically check sources for new chapters in the background.
              </p>
            </div>
            <Switch
              checked={form.autoSyncEnabled}
              onCheckedChange={(value) => update("autoSyncEnabled", value)}
              aria-label="Auto-sync enabled"
            />
          </div>
          <Field label="Check interval" htmlFor="auto-sync-interval">
            <Select
              value={form.autoSyncIntervalMinutes}
              disabled={!form.autoSyncEnabled}
              onChange={(event) => update("autoSyncIntervalMinutes", Number(event.target.value))}
            >
              {AUTO_SYNC_PRESETS_MINUTES.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {INTERVAL_LABELS[minutes]}
                </option>
              ))}
            </Select>
          </Field>

          <div className="flex items-center justify-between gap-3 border-t border-card-border pt-4">
            <div>
              <p className="text-sm font-medium text-foreground">Verbose plugin logging</p>
              <p className="text-xs text-muted">
                Keep detailed logs from content-source plugin jobs.
              </p>
            </div>
            <Switch
              checked={form.verbosePluginLogging}
              onCheckedChange={(value) => update("verbosePluginLogging", value)}
              aria-label="Verbose plugin logging"
            />
          </div>

          <div className="grid grid-cols-2 gap-3 border-t border-card-border pt-4">
            <Field label="Notification retention (days)" htmlFor="notification-retention">
              <Input
                type="number"
                min={7}
                max={3650}
                value={form.notificationRetentionDays}
                onChange={(event) =>
                  update("notificationRetentionDays", Number(event.target.value))
                }
              />
            </Field>
            <Field label="Job log retention (days)" htmlFor="job-log-retention">
              <Input
                type="number"
                min={1}
                max={365}
                value={form.jobLogRetentionDays}
                onChange={(event) => update("jobLogRetentionDays", Number(event.target.value))}
              />
            </Field>
          </div>

          <Button
            type="submit"
            className="self-start"
            disabled={!dirty}
            loading={updateSettings.isPending}
          >
            Save settings
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
