/**
 * Instance-wide settings. A single row with id "global" that is created on
 * first read, so nothing has to seed it during install or migration.
 */
import type { AppSetting } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

export const APP_SETTINGS_ID = "global";

/** Fields callers may patch. `id` and `updatedAt` are managed here. */
export type AppSettingsPatch = Partial<Omit<AppSetting, "id" | "updatedAt">>;

/** Read the global settings row, creating it with schema defaults on first access. */
export async function getAppSettings(): Promise<AppSetting> {
  return prisma.appSetting.upsert({
    where: { id: APP_SETTINGS_ID },
    update: {},
    create: { id: APP_SETTINGS_ID },
  });
}

/** Apply a partial update, creating the row if it does not exist yet. */
export async function updateAppSettings(patch: AppSettingsPatch): Promise<AppSetting> {
  return prisma.appSetting.upsert({
    where: { id: APP_SETTINGS_ID },
    update: patch,
    create: { id: APP_SETTINGS_ID, ...patch },
  });
}
