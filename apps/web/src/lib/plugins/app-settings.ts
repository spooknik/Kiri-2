/**
 * Read-only access to the instance settings the plugin host cares about.
 *
 * `src/lib/settings.ts`'s `getAppSettings()` upserts the `global` row so it
 * always exists — which is right for the admin screens, but wrong on a hot
 * path: two concurrent readers (a source panel rendering while a sync job
 * starts) both try to create the row and one loses with a unique-constraint
 * error. Nothing here needs to create it, so nothing here writes.
 *
 * The fallbacks mirror the schema defaults in `prisma/schema.prisma`; if that
 * row is missing, the instance behaves exactly as a freshly created one would.
 */
import { prisma } from "@/lib/prisma";
import { APP_SETTINGS_ID } from "@/lib/settings";

export interface GlobalPluginSettings {
  autoSyncEnabled: boolean;
  autoSyncIntervalMinutes: number;
  verbosePluginLogging: boolean;
}

/** Schema defaults, used until the settings row exists. */
export const GLOBAL_PLUGIN_DEFAULTS: GlobalPluginSettings = {
  autoSyncEnabled: false,
  autoSyncIntervalMinutes: 1440,
  verbosePluginLogging: false,
};

export async function readGlobalPluginSettings(): Promise<GlobalPluginSettings> {
  const row = await prisma.appSetting.findUnique({
    where: { id: APP_SETTINGS_ID },
    select: {
      autoSyncEnabled: true,
      autoSyncIntervalMinutes: true,
      verbosePluginLogging: true,
    },
  });
  return row ?? GLOBAL_PLUGIN_DEFAULTS;
}
