/**
 * Prisma rows to the wire shapes in `src/lib/contracts/plugins.ts`.
 *
 * Kept separate from the modules that query so both the plugin registry and
 * the per-series source service produce byte-identical views, and so a shape
 * change is one file.
 */
import type { Plugin, Source } from "@/generated/prisma/client";
import type { MediaType } from "@/lib/contracts/series";
import {
  PLUGIN_CAPABILITIES,
  type AutoSyncMode,
  type PluginCapability,
  type PluginView,
  type SourceView,
} from "@/lib/contracts/plugins";

/** `Plugin.capabilities` is `String[]` in the schema; keep only known values. */
export function toCapabilities(values: readonly string[]): PluginCapability[] {
  return values.filter((value): value is PluginCapability =>
    (PLUGIN_CAPABILITIES as readonly string[]).includes(value),
  );
}

export interface PluginCounts {
  sourceCount: number;
  hasCredential: boolean;
}

export function toPluginView(row: Plugin, counts: PluginCounts): PluginView {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    sdkRange: row.sdkRange,
    hosts: row.hosts,
    capabilities: toCapabilities(row.capabilities),
    mediaTypes: row.mediaTypes as MediaType[],
    adult: row.adult,
    homepage: row.homepage,
    license: row.license,
    status: row.status,
    lastError: row.lastError,
    installSource: row.installSource,
    installedAt: row.installedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    sourceCount: counts.sourceCount,
    hasCredential: counts.hasCredential,
  };
}

/**
 * The same view with the two admin-only fields blanked, for GET /api/plugins as
 * a member sees it. `installSource` is a URL, an upload filename or a git sha,
 * and `lastError` carries paths and stderr tails: both describe the host, not
 * the plugin, and neither is anything the reading UI uses.
 */
export function toMemberPluginView(view: PluginView): PluginView {
  return { ...view, installSource: null, lastError: null };
}

/* -------------------------------------------------------------------------- */
/* Source                                                                     */
/* -------------------------------------------------------------------------- */

/** Per-series plugin options, stored under `Source.configJson.settings`. */
export type SourceSettings = Record<string, string | number | boolean>;

/** `configJson` is free-form JSON; read the two keys the host puts there. */
export function readSourceConfig(value: unknown): {
  settings: SourceSettings;
  v1Site: string | null;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { settings: {}, v1Site: null };
  }
  const record = value as Record<string, unknown>;
  const rawSettings = record["settings"];
  const settings: SourceSettings = {};
  if (typeof rawSettings === "object" && rawSettings !== null && !Array.isArray(rawSettings)) {
    for (const [key, item] of Object.entries(rawSettings)) {
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
        settings[key] = item;
      }
    }
  }
  const v1Site = record["v1Site"];
  return { settings, v1Site: typeof v1Site === "string" && v1Site !== "" ? v1Site : null };
}

/**
 * Minutes between automatic syncs, or null when this source never syncs on its
 * own. `INHERIT` follows the instance setting (which is itself off unless
 * `AppSetting.autoSyncEnabled`), `CUSTOM` uses its own value and falls back to
 * the global one when it has none.
 */
export function effectiveIntervalMinutes(
  mode: AutoSyncMode,
  custom: number | null,
  globalMinutes: number,
  globalEnabled: boolean,
): number | null {
  if (mode === "DISABLED") return null;
  if (mode === "CUSTOM") return custom ?? globalMinutes;
  return globalEnabled ? globalMinutes : null;
}

export interface SourceViewInput {
  seriesId: string;
  source: (Source & { plugin: Plugin | null }) | null;
  hasPluginCredential: boolean;
  activeJobId: string | null;
  globalIntervalMinutes: number;
  globalAutoSyncEnabled: boolean;
}

/** A series with no `Source` row still has a (blank) view; the UI needs one. */
export function toSourceView(input: SourceViewInput): SourceView {
  const { source } = input;
  if (!source) {
    return {
      seriesId: input.seriesId,
      plugin: null,
      v1Site: null,
      normalizedUrl: null,
      status: "UNCONFIGURED",
      lastError: null,
      lastErrorCode: null,
      lastSyncedAt: null,
      hasSeriesCookie: false,
      cookieUpdatedAt: null,
      hasPluginCredential: false,
      autoSyncMode: "INHERIT",
      autoSyncIntervalMinutes: null,
      effectiveIntervalMinutes: null,
      activeJobId: null,
      settings: {},
    };
  }

  const { settings, v1Site } = readSourceConfig(source.configJson);
  return {
    seriesId: input.seriesId,
    plugin: source.plugin
      ? {
          id: source.plugin.id,
          name: source.plugin.name,
          status: source.plugin.status,
          needsCookie: source.plugin.capabilities.includes("cookie"),
        }
      : null,
    v1Site,
    normalizedUrl: source.normalizedUrl,
    status: source.status,
    lastError: source.lastError,
    lastErrorCode: source.lastErrorCode,
    lastSyncedAt: source.lastSyncedAt?.toISOString() ?? null,
    hasSeriesCookie: source.cookieEnc !== null,
    cookieUpdatedAt: source.cookieUpdatedAt?.toISOString() ?? null,
    hasPluginCredential: input.hasPluginCredential,
    autoSyncMode: source.autoSyncMode,
    autoSyncIntervalMinutes: source.autoSyncIntervalMinutes,
    effectiveIntervalMinutes: effectiveIntervalMinutes(
      source.autoSyncMode,
      source.autoSyncIntervalMinutes,
      input.globalIntervalMinutes,
      input.globalAutoSyncEnabled,
    ),
    activeJobId: input.activeJobId,
    settings,
  };
}
