/**
 * Node permission-model flags for a plugin subprocess.
 *
 * `KIRI_PLUGIN_SANDBOX` decides what happens:
 *   `on`   — always sandboxed; a denied access fails the run;
 *   `warn` — sandboxed, but a run that dies with `ERR_ACCESS_DENIED` is logged
 *            with the denied path and retried **once** without the flags
 *            (the default: a plugin that reads a config file Kiri did not
 *            anticipate should not be silently broken on somebody's server);
 *   `off`  — no flags at all.
 *
 * What the flags actually buy, measured on Node 24 against the template plugin
 * (see `sandbox.test.ts` and the report in the phase-4 notes):
 *   - `--allow-fs-read` is needed for BOTH the plugin directory and the SDK
 *     directory: `node_modules/@kiri/source-sdk` is a junction/symlink, and the
 *     permission model checks the *resolved* path;
 *   - the output directory needs read as well as write — the SDK reads back
 *     `manifest.json` on every checkpoint;
 *   - Node's own internals need nothing; there is no `--allow-net` in Node 24,
 *     so the sandbox constrains the filesystem and child processes, not the
 *     network. A plugin is still a program you chose to run.
 *
 * `capabilities` is declarative, not a boundary: `browser`/`subprocess` add
 * `--allow-child-process`, which lets the plugin spawn anything at all. The
 * admin UI shows that as a warning badge, and `sandbox: "relaxed"` (an explicit
 * opt-out in the descriptor, admin-accepted at install) turns the flags off
 * entirely for that plugin.
 */
import path from "node:path";
import type { PluginDescriptor } from "@/lib/contracts/plugins";
import { getEnv } from "@/lib/env";

export type SandboxMode = "on" | "warn" | "off";

export interface SandboxPaths {
  /** Directory holding `kiri-plugin.json`. */
  pluginDir: string;
  /** The linked `@kiri/source-sdk` tree. */
  sdkDir: string;
  /** Series directory a sync writes into; omitted for `hello`/`resolve`. */
  outputDir?: string | null;
  /** Per-run scratch directory (also `TMPDIR` for the child). */
  tmpDir?: string | null;
}

/** The descriptor fields the sandbox cares about. */
export type SandboxDescriptor = Pick<PluginDescriptor, "capabilities" | "sandbox">;

/** Current mode from the environment. */
export function sandboxMode(): SandboxMode {
  return getEnv().KIRI_PLUGIN_SANDBOX;
}

/** True when this plugin runs with no permission flags at all. */
export function isUnsandboxed(descriptor: SandboxDescriptor, mode: SandboxMode): boolean {
  return mode === "off" || descriptor.sandbox === "relaxed";
}

/**
 * Argv prefix for `node`. Empty when the sandbox is off or the plugin asked
 * for (and was granted) a relaxed sandbox.
 */
export function sandboxArgs(
  descriptor: SandboxDescriptor,
  paths: SandboxPaths,
  mode: SandboxMode = sandboxMode(),
): string[] {
  if (isUnsandboxed(descriptor, mode)) return [];

  const reads: string[] = [path.resolve(paths.pluginDir), path.resolve(paths.sdkDir)];
  const writes: string[] = [];
  if (paths.outputDir) {
    reads.push(path.resolve(paths.outputDir));
    writes.push(path.resolve(paths.outputDir));
  }
  if (paths.tmpDir) {
    reads.push(path.resolve(paths.tmpDir));
    writes.push(path.resolve(paths.tmpDir));
  }

  const args = ["--permission"];
  const needsChildProcess =
    descriptor.capabilities.includes("browser") || descriptor.capabilities.includes("subprocess");
  if (needsChildProcess) {
    args.push("--allow-child-process");
    for (const key of ["PLAYWRIGHT_BROWSERS_PATH", "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"]) {
      const value = process.env[key];
      if (value !== undefined && value.trim() !== "") reads.push(path.resolve(value.trim()));
    }
    // Chromium keeps its shared memory here; without it the browser aborts at
    // startup inside a container.
    if (process.platform !== "win32") {
      reads.push("/dev/shm");
      writes.push("/dev/shm");
    }
  }

  for (const dir of dedupe(reads)) args.push(`--allow-fs-read=${dir}`);
  for (const dir of dedupe(writes)) args.push(`--allow-fs-write=${dir}`);
  return args;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                */
/* -------------------------------------------------------------------------- */

const ACCESS_DENIED = /ERR_ACCESS_DENIED/;
const RESOURCE = /resource:\s*'([^']*)'/;
const PERMISSION = /permission:\s*'([^']*)'/;

/** Did the child die because the permission model refused something? */
export function isAccessDenied(stderr: string): boolean {
  return ACCESS_DENIED.test(stderr);
}

export interface AccessDenial {
  /** e.g. `FileSystemRead`. */
  permission: string | null;
  /** The path Node refused, with its `\\?\` prefix removed. */
  resource: string | null;
}

/** Pull the denied path out of Node's `ERR_ACCESS_DENIED` dump. */
export function parseAccessDenial(stderr: string): AccessDenial {
  const resource = RESOURCE.exec(stderr)?.[1] ?? null;
  return {
    permission: PERMISSION.exec(stderr)?.[1] ?? null,
    resource: resource === null ? null : resource.replaceAll("\\\\", "\\").replace(/^\\\\\?\\/, ""),
  };
}

/** One-line explanation for the job log when `warn` mode retries a run. */
export function describeAccessDenial(pluginId: string, stderr: string): string {
  const { permission, resource } = parseAccessDenial(stderr);
  const what = resource ?? "an unreported path";
  const how = permission ?? "the filesystem";
  return (
    `Plugin ${pluginId} was denied ${how} access to ${what} by the Node sandbox. ` +
    "KIRI_PLUGIN_SANDBOX=warn, so the run is being retried without the sandbox. " +
    "Set KIRI_PLUGIN_SANDBOX=on to fail instead."
  );
}
