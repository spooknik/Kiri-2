/**
 * Instance settings for the admin UI.
 *
 * Reads and writes go through src/lib/settings.ts (which owns the single
 * "global" row); this module maps the row onto the contract's
 * `AppSettingsView` and works out which keys an update actually changed, so
 * the audit entry says something more useful than "settings touched".
 */
import type { AppSetting } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/types";
import { AUDIT_ACTIONS, AUDIT_TARGETS, recordAudit } from "@/lib/audit";
import type { AppSettingsView, UpdateSettingsInput } from "@/lib/contracts/admin";
import { getAppSettings, updateAppSettings } from "@/lib/settings";

function toView(row: AppSetting): AppSettingsView {
  return {
    instanceName: row.instanceName,
    registrationMode: row.registrationMode,
    autoSyncEnabled: row.autoSyncEnabled,
    autoSyncIntervalMinutes: row.autoSyncIntervalMinutes,
    verbosePluginLogging: row.verbosePluginLogging,
    notificationRetentionDays: row.notificationRetentionDays,
    jobLogRetentionDays: row.jobLogRetentionDays,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getSettingsView(): Promise<AppSettingsView> {
  return toView(await getAppSettings());
}

/** Keys whose submitted value differs from what is stored. */
function changedKeys(
  current: AppSetting,
  input: UpdateSettingsInput,
): (keyof UpdateSettingsInput)[] {
  const keys = Object.keys(input) as (keyof UpdateSettingsInput)[];
  return keys.filter((key) => input[key] !== undefined && input[key] !== current[key]);
}

export async function updateSettingsView(
  actor: SessionUser,
  input: UpdateSettingsInput,
): Promise<AppSettingsView> {
  const current = await getAppSettings();
  const changed = changedKeys(current, input);
  if (changed.length === 0) {
    return toView(current);
  }

  const patch = Object.fromEntries(changed.map((key) => [key, input[key]]));
  const updated = await updateAppSettings(patch);

  await recordAudit({
    actorId: actor.id,
    action: AUDIT_ACTIONS.settingsUpdate,
    targetType: AUDIT_TARGETS.settings,
    targetId: updated.id,
    metadata: { changed, values: patch },
  });

  return toView(updated);
}
