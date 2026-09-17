/**
 * `kiri-plugin.json` — reading, validating and fingerprinting a descriptor.
 *
 * Validation happens twice: at install (on the staging directory, before
 * anything is moved into place) and at every boot (on `DATA_ROOT/plugins/*`,
 * without executing a single line of plugin code). Both go through
 * {@link readDescriptor}, so "a plugin Kiri will run" has exactly one
 * definition.
 *
 * Beyond the zod shape in `src/lib/contracts/plugins.ts` a descriptor must:
 *   - carry an `id` equal to its directory name (the id is the identity of the
 *     plugin everywhere: the row id, the directory, `manifest.site`);
 *   - point `entry` at a file that exists inside the directory;
 *   - declare an `sdk` range the bundled SDK satisfies.
 *
 * `descriptorHash` is the sha256 of the canonical JSON of the *parsed* value
 * (keys sorted, defaults applied), so reformatting the file does not look like
 * a new version while a changed host list does.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { readJsonFile, resolveInside } from "@/lib/content/store";
import { pluginDescriptorSchema, type PluginDescriptor } from "@/lib/contracts/plugins";
import { sha256Hex } from "@/lib/crypto";
import { bundledSdkVersion } from "@/lib/plugins/sdk-link";
import { satisfies } from "@/lib/plugins/semver";

/** File name of the descriptor, at the root of a plugin directory or zip. */
export const DESCRIPTOR_FILE = "kiri-plugin.json";

export type DescriptorErrorCode =
  | "DESCRIPTOR_MISSING"
  | "DESCRIPTOR_INVALID"
  | "ID_MISMATCH"
  | "ENTRY_OUTSIDE"
  | "ENTRY_MISSING"
  | "SDK_INCOMPATIBLE";

/** A descriptor problem worth showing to an admin verbatim. */
export class DescriptorError extends Error {
  readonly code: DescriptorErrorCode;
  constructor(code: DescriptorErrorCode, message: string) {
    super(message);
    this.name = "DescriptorError";
    this.code = code;
  }
}

/** A validated descriptor plus everything derived from where it was found. */
export interface LoadedDescriptor {
  descriptor: PluginDescriptor;
  /** Absolute plugin directory. */
  dir: string;
  /** Absolute path of `descriptor.entry`, proven to exist inside `dir`. */
  entryPath: string;
  descriptorHash: string;
  /** SDK version the range was checked against. */
  sdkVersion: string;
}

/* -------------------------------------------------------------------------- */
/* Canonical JSON                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Stable serialisation: object keys sorted, arrays in order, `undefined`
 * dropped. Two descriptors that mean the same thing hash the same.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const body = entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** sha256 of the canonical JSON of a parsed descriptor. */
export function descriptorHashOf(descriptor: PluginDescriptor): string {
  return sha256Hex(canonicalJson(descriptor));
}

/* -------------------------------------------------------------------------- */
/* Host matching                                                              */
/* -------------------------------------------------------------------------- */

/** Lowercase, strip a trailing dot and any surrounding whitespace. */
export function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Match a hostname against one descriptor pattern. Labels are compared whole:
 * `*.example.com` matches `cdn.example.com` but neither `example.com` nor
 * `a.b.example.com` (one wildcard label, leftmost only), and `example.com`
 * matches only itself. Case- and trailing-dot-insensitive.
 */
export function hostMatches(hostname: string, pattern: string): boolean {
  const host = normalizeHostname(hostname);
  const target = normalizeHostname(pattern);
  if (host === "" || target === "") return false;
  if (!target.startsWith("*.")) return host === target;

  const suffix = target.slice(2);
  if (suffix === "") return false;
  if (!host.endsWith(`.${suffix}`)) return false;
  const label = host.slice(0, host.length - suffix.length - 1);
  return label !== "" && !label.includes(".");
}

/** The hostname of a URL, or null when it is not a parseable http(s) URL. */
export function hostnameOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return normalizeHostname(parsed.hostname);
  } catch {
    return null;
  }
}

/** Does any of `hosts` match `hostname`? */
export function hostsMatch(hosts: readonly string[], hostname: string): boolean {
  return hosts.some((pattern) => hostMatches(hostname, pattern));
}

/** A plugin that wants a cookie shows up in the browser extension's host list. */
export function needsCookie(descriptor: { capabilities: readonly string[] }): boolean {
  return descriptor.capabilities.includes("cookie");
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/** `./src/index.mjs` becomes `["src", "index.mjs"]`. */
function entrySegments(entry: string): string[] {
  return entry
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
}

/**
 * Read and fully validate `<dir>/kiri-plugin.json`.
 *
 * @param dir absolute (or cwd-relative) plugin directory; its basename is the
 *            id the descriptor must declare.
 * @param options.sdkVersion override the bundled SDK version (tests).
 * @param options.expectId   check against this id instead of the basename —
 *            used at install time, where the staging directory is a temp name.
 */
export async function readDescriptor(
  dir: string,
  options: { sdkVersion?: string; expectId?: string } = {},
): Promise<LoadedDescriptor> {
  const absolute = path.resolve(dir);
  const file = path.join(absolute, DESCRIPTOR_FILE);

  let raw: unknown;
  try {
    raw = await readJsonFile(file);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new DescriptorError(
      "DESCRIPTOR_INVALID",
      `${DESCRIPTOR_FILE} is not valid JSON: ${detail}`,
    );
  }
  if (raw === null) {
    throw new DescriptorError("DESCRIPTOR_MISSING", `No ${DESCRIPTOR_FILE} at the plugin root`);
  }

  const parsed = pluginDescriptorSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new DescriptorError("DESCRIPTOR_INVALID", `${DESCRIPTOR_FILE} is invalid — ${issues}`);
  }
  const descriptor = parsed.data;

  const expected = options.expectId ?? path.basename(absolute);
  if (descriptor.id !== expected) {
    throw new DescriptorError(
      "ID_MISMATCH",
      `Descriptor id "${descriptor.id}" must equal the plugin directory name "${expected}"`,
    );
  }

  let entryPath: string;
  try {
    entryPath = resolveInside(absolute, ...entrySegments(descriptor.entry));
  } catch {
    throw new DescriptorError(
      "ENTRY_OUTSIDE",
      `Entry "${descriptor.entry}" resolves outside the plugin directory`,
    );
  }
  const info = await stat(entryPath).catch(() => null);
  if (!info?.isFile()) {
    throw new DescriptorError("ENTRY_MISSING", `Entry "${descriptor.entry}" does not exist`);
  }

  const sdkVersion = options.sdkVersion ?? bundledSdkVersion();
  if (!satisfies(sdkVersion, descriptor.sdk)) {
    throw new DescriptorError(
      "SDK_INCOMPATIBLE",
      `This plugin needs @kiri/source-sdk ${descriptor.sdk}; this Kiri ships ${sdkVersion}`,
    );
  }

  return {
    descriptor,
    dir: absolute,
    entryPath,
    descriptorHash: descriptorHashOf(descriptor),
    sdkVersion,
  };
}
