/**
 * The environment contract. Nothing secret ever travels on `argv` (it is
 * visible in `ps`), so the host passes cookies, settings and paths through an
 * allowlisted environment instead.
 *
 * | Variable | Meaning |
 * |---|---|
 * | `KIRI_COOKIE` | Raw `Cookie:` header value for the source site |
 * | `KIRI_USER_AGENT` | User-Agent that the cookie was captured with |
 * | `KIRI_OUTPUT_DIR` | Series directory (`--output` overrides it) |
 * | `KIRI_PLUGIN_DIR` | Directory holding `kiri-plugin.json` |
 * | `KIRI_SDK_VERSION` | SDK version the host linked into the plugin |
 * | `KIRI_APP_VERSION` | Kiri version running the plugin |
 * | `KIRI_VERBOSE` | `1` mirrors events to stderr and enables debug logs |
 * | `KIRI_CONCURRENCY` | Page download concurrency (default 4) |
 * | `KIRI_SETTINGS` | JSON object of the source's configured settings |
 * | `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | Chromium for the browser helper |
 */

export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 16;

export interface PluginEnv {
  /** Raw `Cookie:` header value, or `undefined` when the host has none. */
  cookie?: string;
  userAgent?: string;
  /** Series output directory, when the host set it in the environment. */
  outputDir?: string;
  /** Directory containing `kiri-plugin.json`. */
  pluginDir?: string;
  /** SDK version the host linked (may differ from the bundled `SDK_VERSION`). */
  sdkVersion?: string;
  appVersion?: string;
  verbose: boolean;
  /** Page download concurrency, clamped to 1…{@link MAX_CONCURRENCY}. */
  concurrency: number;
  /** Parsed `KIRI_SETTINGS`; `{}` when unset or unparseable. */
  settings: Record<string, unknown>;
  /** Set when `KIRI_SETTINGS` was present but not a JSON object. */
  settingsError?: string;
  chromiumExecutablePath?: string;
  tmpDir?: string;
}

type EnvSource = Record<string, string | undefined>;

function text(source: EnvSource, key: string): string | undefined {
  const raw = source[key];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** `1`, `true`, `yes`, `on` (case-insensitive) are true; everything else false. */
export function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isVerbose(source: EnvSource = process.env): boolean {
  return isTruthy(source["KIRI_VERBOSE"]);
}

/** Parse `KIRI_SETTINGS`. Never throws — a bad value degrades to `{}`. */
export function parseSettings(raw: string | undefined): {
  settings: Record<string, unknown>;
  error?: string;
} {
  if (raw === undefined || raw.trim() === "") return { settings: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return {
      settings: {},
      error: `KIRI_SETTINGS is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { settings: {}, error: "KIRI_SETTINGS must be a JSON object" };
  }
  return { settings: parsed as Record<string, unknown> };
}

function readConcurrency(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_CONCURRENCY;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, parsed);
}

/** Read the whole plugin environment in one typed shot. */
export function readEnv(source: EnvSource = process.env): PluginEnv {
  const { settings, error } = parseSettings(source["KIRI_SETTINGS"]);
  const env: PluginEnv = {
    verbose: isVerbose(source),
    concurrency: readConcurrency(text(source, "KIRI_CONCURRENCY")),
    settings,
  };
  const cookie = text(source, "KIRI_COOKIE");
  if (cookie !== undefined) env.cookie = cookie;
  const userAgent = text(source, "KIRI_USER_AGENT");
  if (userAgent !== undefined) env.userAgent = userAgent;
  const outputDir = text(source, "KIRI_OUTPUT_DIR");
  if (outputDir !== undefined) env.outputDir = outputDir;
  const pluginDir = text(source, "KIRI_PLUGIN_DIR");
  if (pluginDir !== undefined) env.pluginDir = pluginDir;
  const sdkVersion = text(source, "KIRI_SDK_VERSION");
  if (sdkVersion !== undefined) env.sdkVersion = sdkVersion;
  const appVersion = text(source, "KIRI_APP_VERSION");
  if (appVersion !== undefined) env.appVersion = appVersion;
  const chromium = text(source, "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH");
  if (chromium !== undefined) env.chromiumExecutablePath = chromium;
  const tmpDir = text(source, "TMPDIR") ?? text(source, "TEMP") ?? text(source, "TMP");
  if (tmpDir !== undefined) env.tmpDir = tmpDir;
  if (error !== undefined) env.settingsError = error;
  return env;
}

/** Read one setting with a typed fallback (settings are host-supplied JSON). */
export function getSetting<T>(settings: Record<string, unknown>, key: string, fallback: T): T {
  const value = settings[key];
  if (value === undefined || value === null) return fallback;
  if (typeof fallback === "number") {
    const parsed = typeof value === "number" ? value : Number(value);
    return (Number.isFinite(parsed) ? parsed : fallback) as T;
  }
  if (typeof fallback === "boolean") {
    if (typeof value === "boolean") return value as T;
    if (value === "true") return true as T;
    if (value === "false") return false as T;
    return fallback;
  }
  if (typeof fallback === "string") {
    return (typeof value === "string" ? value : String(value)) as T;
  }
  return value as T;
}
