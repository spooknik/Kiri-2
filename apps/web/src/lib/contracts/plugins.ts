/**
 * Content-source plugin contract: the descriptor an installed plugin ships,
 * the admin API for managing plugins, per-series source configuration and
 * the cookie-bridge extension endpoints.
 */
import { z } from "zod";
import { httpUrl, MEDIA_TYPES, type MediaType } from "./series";

export const PLUGIN_CAPABILITIES = ["network", "cookie", "browser", "subprocess"] as const;
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

export const PLUGIN_STATUSES = ["ENABLED", "DISABLED", "BROKEN"] as const;
export type PluginStatus = (typeof PLUGIN_STATUSES)[number];

/** `kiri-plugin.json` — validated at install and at boot. */
export const pluginDescriptorSchema = z.object({
  id: z
    .string()
    .regex(
      /^(?:[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?){2,})$/,
      "id must be a slug (2-40 chars) or reverse-DNS name",
    ),
  name: z.string().trim().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "version must be semver"),
  sdk: z.string().trim().min(1).max(60),
  entry: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((v) => !v.includes("..") && !v.startsWith("/") && !/^[a-zA-Z]:/.test(v), {
      message: "entry must be a relative path inside the plugin directory",
    }),
  hosts: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(
          /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
          "hosts are host names, optionally with a leading *. wildcard label",
        ),
    )
    .min(1)
    .max(50),
  capabilities: z.array(z.enum(PLUGIN_CAPABILITIES)).default(["network"]),
  mediaTypes: z.array(z.enum(MEDIA_TYPES)).default([]),
  adult: z.boolean().default(false),
  homepage: z.url().optional(),
  license: z.string().trim().max(60).optional(),
  minKiriVersion: z.string().trim().max(30).optional(),
  settings: z
    .array(
      z.object({
        key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/),
        type: z.enum(["string", "number", "boolean"]),
        label: z.string().trim().min(1).max(80),
        default: z.union([z.string(), z.number(), z.boolean()]).optional(),
        description: z.string().trim().max(300).optional(),
      }),
    )
    .max(30)
    .default([]),
  /** A plugin may ask for the sandbox to be relaxed; admins must accept it explicitly. */
  sandbox: z.enum(["strict", "relaxed"]).default("strict"),
});
export type PluginDescriptor = z.infer<typeof pluginDescriptorSchema>;

export interface PluginView {
  id: string;
  name: string;
  version: string;
  sdkRange: string;
  hosts: string[];
  capabilities: PluginCapability[];
  mediaTypes: MediaType[];
  adult: boolean;
  homepage: string | null;
  license: string | null;
  status: PluginStatus;
  lastError: string | null;
  installSource: string | null;
  installedAt: string;
  updatedAt: string;
  /** Series currently bound to this plugin. */
  sourceCount: number;
  /** Whether a plugin-level credential (from the extension) is stored. */
  hasCredential: boolean;
}

/** POST /api/plugins (admin) — starts a PLUGIN_INSTALL job. */
export const installPluginSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("upload"), uploadId: z.uuid() }),
    z.object({ type: z.literal("url"), url: httpUrl() }),
    z.object({
      type: z.literal("git"),
      // http(s) only: `ext::` and `file://` remotes make a clone an exec.
      url: httpUrl(),
      ref: z.string().max(100).optional(),
    }),
  ])
  .and(
    z.object({
      /** Required when the descriptor declares `sandbox: "relaxed"`. */
      acceptRelaxedSandbox: z.boolean().default(false),
    }),
  );
export type InstallPluginInput = z.infer<typeof installPluginSchema>;

/** PATCH /api/plugins/:id (admin) */
export const updatePluginSchema = z.object({
  status: z.enum(["ENABLED", "DISABLED"]).optional(),
});

// ---------------------------------------------------------------------------
// Per-series source
// ---------------------------------------------------------------------------

export const SOURCE_STATUSES = [
  "UNCONFIGURED",
  "NEEDS_PLUGIN",
  "PENDING",
  "RUNNING",
  "READY",
  "FAILED",
] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export const AUTO_SYNC_MODES = ["INHERIT", "DISABLED", "CUSTOM"] as const;
export type AutoSyncMode = (typeof AUTO_SYNC_MODES)[number];

export interface SourceView {
  seriesId: string;
  plugin: { id: string; name: string; status: PluginStatus; needsCookie: boolean } | null;
  /** Set when the source came from Kiri 1.x and its plugin is not installed. */
  v1Site: string | null;
  normalizedUrl: string | null;
  status: SourceStatus;
  lastError: string | null;
  lastErrorCode: string | null;
  lastSyncedAt: string | null;
  hasSeriesCookie: boolean;
  cookieUpdatedAt: string | null;
  hasPluginCredential: boolean;
  autoSyncMode: AutoSyncMode;
  autoSyncIntervalMinutes: number | null;
  /** Effective interval after INHERIT resolution, null when disabled. */
  effectiveIntervalMinutes: number | null;
  activeJobId: string | null;
  settings: Record<string, string | number | boolean>;
}

/** POST /api/plugins/resolve — which plugin handles a URL (used by the series form). */
export const resolveUrlSchema = z.object({ url: httpUrl() });
export interface ResolveUrlResponse {
  handled: boolean;
  pluginId: string | null;
  pluginName: string | null;
  normalizedUrl: string | null;
  slug: string | null;
  title: string | null;
  mediaType: MediaType | null;
  coverUrl: string | null;
  needsCookie: boolean;
  /** Set when a visible series already uses this normalized URL. */
  existingSeriesId: string | null;
}

/** PUT /api/series/:id/source — bind a URL (resolve + create/replace the source). */
export const configureSourceSchema = z.object({
  url: httpUrl(),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

/** PATCH /api/series/:id/source */
export const updateSourceSchema = z.object({
  autoSyncMode: z.enum(AUTO_SYNC_MODES).optional(),
  autoSyncIntervalMinutes: z.number().int().min(60).max(43_200).nullish(),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

/** PUT /api/series/:id/source/credential — paste a cookie for this series. */
export const sourceCredentialSchema = z.object({
  cookie: z.string().trim().min(1).max(20_000),
  userAgent: z.string().trim().max(500).nullish(),
});

/** POST /api/series/:id/source/sync */
export const syncSourceSchema = z.object({
  kind: z.enum(["sync", "verify"]).default("sync"),
});

// ---------------------------------------------------------------------------
// Cookie-bridge extension
// ---------------------------------------------------------------------------

/** GET /api/plugins/hosts (extension token) */
export interface ExtensionHostsResponse {
  hosts: { host: string; pluginId: string; pluginName: string }[];
}

/** POST /api/plugins/credentials (extension token) */
export const extensionCredentialSchema = z.object({
  host: z.string().trim().min(1).max(253),
  cookie: z.string().trim().min(1).max(20_000),
  userAgent: z.string().trim().max(500).nullish(),
});

/** GET /api/admin/plugins/extension-token (admin) — derived from APP_SECRET, shown to admins. */
export interface ExtensionTokenResponse {
  token: string;
  ingestUrl: string;
  hostsUrl: string;
}
