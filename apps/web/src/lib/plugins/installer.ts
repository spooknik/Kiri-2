/**
 * Installing, uninstalling and enabling content-source plugins.
 *
 * An install is a pipeline with one invariant: **nothing lands in
 * `DATA_ROOT/plugins` until every check has passed.** Everything happens in a
 * staging directory inside the job's scratch space, and the last step is a
 * rename. A failed install therefore leaves the previous version of the plugin
 * exactly as it was.
 *
 *   fetch (zip upload | https zip | git clone)
 *     -> extract into staging, flattening a single wrapper folder
 *     -> validate the descriptor (this is also what names the directory)
 *     -> refuse `sandbox: "relaxed"` unless the admin accepted it
 *     -> npm install (only with real dependencies, never lifecycle scripts)
 *     -> link @kiri/source-sdk
 *     -> `node <entry> hello` — the first and only time plugin code runs here
 *     -> move into place, upsert the row, re-point orphaned sources, notify
 *
 * The `hello` check runs the plugin as a subprocess with the same sandbox a
 * sync would get, so an install cannot be the place where a plugin escapes it.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Prisma, PluginStatus } from "@/generated/prisma/client";
import { ensureDir, pluginsDir, removeDirSafe, resolveInside } from "@/lib/content/store";
import type { InstallPluginInput, PluginView } from "@/lib/contracts/plugins";
import { recordAudit } from "@/lib/audit";
import { JobFailure, type JobContext } from "@/lib/jobs/types";
import { safeFetch, SafeFetchError } from "@/lib/net/safe-fetch";
import { createNotifications } from "@/lib/notifications";
import {
  DescriptorError,
  DESCRIPTOR_FILE,
  readDescriptor,
  type LoadedDescriptor,
} from "@/lib/plugins/descriptor";
import { helloCheck } from "@/lib/plugins/process";
import {
  getPluginView,
  loadPlugin,
  reviveSourcesFor,
  scanPlugins,
  upsertPluginRow,
} from "@/lib/plugins/registry";
import { bundledSdkVersion, linkSdk, resolveSdkDir } from "@/lib/plugins/sdk-link";
import { extractZipSafely, ZipError } from "@/lib/plugins/zip";
import { prisma } from "@/lib/prisma";
import { takeCompletedUpload } from "@/lib/uploads/sessions";

const execFileAsync = promisify(execFile);

/** Audit actions this module records. */
export const PLUGIN_AUDIT = {
  install: "plugin.install",
  uninstall: "plugin.uninstall",
  status: "plugin.status",
} as const;

/** A downloaded archive may not exceed this. */
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
/** Whole-download deadline. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
/** `git clone --depth 1` deadline. */
const GIT_TIMEOUT_MS = 5 * 60 * 1000;
/** `npm install` deadline. */
const NPM_TIMEOUT_MS = 5 * 60 * 1000;
/** Output kept from npm/git, per command. */
const COMMAND_LOG_BYTES = 8000;

export interface InstallPluginResult {
  pluginId: string;
  name: string;
  version: string;
  hosts: string[];
  capabilities: string[];
  installSource: string;
  descriptorHash: string;
  sdkVersion: string;
  dependenciesInstalled: boolean;
  /** Version this install replaced, when it was an upgrade. */
  previousVersion: string | null;
  sourcesReattached: number;
}

/* -------------------------------------------------------------------------- */
/* Fetching                                                                   */
/* -------------------------------------------------------------------------- */

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > COMMAND_LOG_BYTES ? `…${trimmed.slice(-COMMAND_LOG_BYTES)}` : trimmed;
}

/**
 * Stream an https zip to disk under a hard size cap.
 *
 * The URL is an admin's input, so it goes through {@link safeFetch}: http(s)
 * only, no private or link-local address, and every redirect hop re-checked —
 * otherwise "install from URL" is a request this server makes to its own
 * network on demand.
 */
async function downloadArchive(url: string, target: string, ctx: JobContext): Promise<void> {
  try {
    const response = await safeFetch(url, {
      signal: ctx.signal,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      headers: { accept: "application/zip, application/octet-stream;q=0.9, */*;q=0.8" },
    });
    if (!response.ok) {
      throw new JobFailure("DOWNLOAD_FAILED", `The download returned HTTP ${response.status}`, {
        retryable: response.status >= 500,
      });
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      throw new JobFailure("DOWNLOAD_TOO_LARGE", "That archive is larger than 500 MB");
    }
    if (!response.body) {
      throw new JobFailure("DOWNLOAD_FAILED", "The download returned no body");
    }

    await ensureDir(path.dirname(target));
    let received = 0;
    const counting = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > MAX_DOWNLOAD_BYTES) {
          callback(new Error("the archive is larger than 500 MB"));
          return;
        }
        callback(null, chunk);
      },
    });
    const web = response.body as unknown as Parameters<typeof Readable.fromWeb>[0];
    await pipeline(Readable.fromWeb(web), counting, createWriteStream(target));
    ctx.log(`Downloaded ${received} bytes from ${url}`);
  } catch (error) {
    if (error instanceof JobFailure) throw error;
    if (ctx.signal.aborted) throw error;
    if (error instanceof SafeFetchError) {
      throw new JobFailure("DOWNLOAD_BLOCKED", `Kiri will not download that URL: ${error.message}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new JobFailure("DOWNLOAD_FAILED", `Could not download the plugin: ${message}`, {
      retryable: true,
    });
  }
}

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"], { timeout: 15_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** Shallow-clone a repository and return the commit it landed on. */
async function cloneRepository(
  url: string,
  ref: string | undefined,
  target: string,
  ctx: JobContext,
): Promise<string> {
  if (!(await gitAvailable())) {
    throw new JobFailure(
      "GIT_UNAVAILABLE",
      "This Kiri image has no git. Upload a zip instead, or use an https zip URL.",
    );
  }
  // `z.url()` accepts every scheme, and git's `ext::` transport runs the rest of
  // the URL as a shell command. Pin the clone to http(s) and switch the
  // command-executing transports off, so neither the schema nor a redirect in a
  // remote's config can turn a clone into an exec.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new JobFailure("GIT_URL_INVALID", "That does not look like a git URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new JobFailure("GIT_URL_INVALID", "Only http(s) git URLs are supported");
  }

  const args = [
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "protocol.file.allow=never",
    "clone",
    "--depth",
    "1",
  ];
  if (ref !== undefined && ref.trim() !== "") args.push("--branch", ref.trim());
  args.push("--", url, target);

  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
    });
    const output = tail(`${stdout}\n${stderr}`);
    if (output) ctx.log(output);
  } catch (error) {
    const detail = error instanceof Error ? tail(error.message) : String(error);
    throw new JobFailure("GIT_CLONE_FAILED", `git clone failed: ${detail}`);
  }

  let sha = "unknown";
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: target,
      timeout: 30_000,
      windowsHide: true,
    });
    sha = stdout.trim().slice(0, 40) || "unknown";
  } catch {
    // A repository without HEAD is odd but not fatal; the install source just
    // records "unknown".
  }
  await rm(path.join(target, ".git"), { recursive: true, force: true });
  return sha;
}

/* -------------------------------------------------------------------------- */
/* Dependencies                                                               */
/* -------------------------------------------------------------------------- */

interface PluginPackageJson {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/**
 * Does this plugin need `npm install`?
 *
 * `@kiri/source-sdk` is deliberately ignored: `docs/PLUGINS.md` tells authors
 * not to depend on it (the host links whatever it ships), but the template and
 * some ported plugins list it as a workspace dependency anyway. Running npm for
 * that one name would fail — it is not on the registry — for no benefit.
 */
export function installableDependencies(pkg: unknown): string[] {
  if (typeof pkg !== "object" || pkg === null) return [];
  const { dependencies, optionalDependencies } = pkg as PluginPackageJson;
  return [...Object.keys(dependencies ?? {}), ...Object.keys(optionalDependencies ?? {})].filter(
    (name) => name !== "@kiri/source-sdk",
  );
}

async function readPackageJson(dir: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function npmInstall(dir: string, ctx: JobContext): Promise<void> {
  const args = ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"];
  try {
    const { stdout, stderr } = await execFileAsync("npm", args, {
      cwd: dir,
      timeout: NPM_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      // npm is a .cmd shim on Windows, which execFile cannot start directly.
      // Every argument here is a fixed literal, so there is nothing to inject.
      shell: process.platform === "win32",
    });
    const output = tail(`${stdout}\n${stderr}`);
    if (output) ctx.log(output);
  } catch (error) {
    const detail = error instanceof Error ? tail(error.message) : String(error);
    throw new JobFailure("NPM_INSTALL_FAILED", `npm install failed: ${detail}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Staging                                                                    */
/* -------------------------------------------------------------------------- */

/** Move `from` onto `to`, falling back to copy+delete across filesystems. */
async function movePath(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(from, to, { recursive: true });
    await rm(from, { recursive: true, force: true });
  }
}

/**
 * Give the staging directory the plugin's own id as its name, which is what
 * makes `readDescriptor`'s "id must equal the directory name" check meaningful
 * before anything is installed.
 */
async function nameStagingAfterDescriptor(staging: string, parent: string): Promise<string> {
  const raw = await readFile(path.join(staging, DESCRIPTOR_FILE), "utf8").catch(() => null);
  if (raw === null) {
    throw new JobFailure(
      "DESCRIPTOR_MISSING",
      `The archive has no ${DESCRIPTOR_FILE} at its root. A plugin zip must not wrap its files in an extra folder.`,
    );
  }
  let id: unknown;
  try {
    id = (JSON.parse(raw) as { id?: unknown }).id;
  } catch {
    throw new JobFailure("DESCRIPTOR_INVALID", `${DESCRIPTOR_FILE} is not valid JSON`);
  }
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9.-]{0,62}[a-z0-9]$/.test(id)) {
    throw new JobFailure("DESCRIPTOR_INVALID", `${DESCRIPTOR_FILE} has no usable "id"`);
  }
  const target = resolveInside(parent, id);
  if (target !== staging) {
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  }
  return target;
}

/* -------------------------------------------------------------------------- */
/* Install                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Run one install. Called by the PLUGIN_INSTALL job handler, which owns
 * progress, logging and the scratch directory.
 */
export async function installPlugin(
  ctx: JobContext,
  input: InstallPluginInput,
  requestedById: string | null,
): Promise<InstallPluginResult> {
  const work = resolveInside(ctx.tmpDir, "install");
  const staging = resolveInside(work, `staging-${randomUUID().slice(0, 8)}`);
  await ensureDir(work);

  /* 1. Fetch ------------------------------------------------------------- */
  await ctx.progress({ phase: "fetch", current: 0, total: 5, message: "Fetching the plugin" });
  let installSource: string;

  if (input.type === "git") {
    ctx.log(`Cloning ${input.url}${input.ref ? ` (${input.ref})` : ""}`);
    const sha = await cloneRepository(input.url, input.ref, staging, ctx);
    installSource = `git:${input.url}@${sha}`;
  } else {
    let archivePath: string;
    let label: string;
    if (input.type === "upload") {
      if (!requestedById) {
        throw new JobFailure("UPLOAD_MISSING", "An uploaded plugin needs the uploader's session");
      }
      const upload = await takeCompletedUpload(requestedById, input.uploadId).catch((error) => {
        throw new JobFailure(
          "UPLOAD_MISSING",
          `That upload is missing or was never completed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      archivePath = upload.path;
      label = upload.filename;
      installSource = `upload:${upload.filename}`;
    } else {
      archivePath = resolveInside(work, "download.zip");
      label = input.url;
      installSource = input.url;
      await downloadArchive(input.url, archivePath, ctx);
    }

    await ctx.progress({ phase: "extract", current: 1, total: 5, message: `Extracting ${label}` });
    try {
      const extracted = await extractZipSafely(archivePath, staging, { signal: ctx.signal });
      ctx.log(
        `Extracted ${extracted.files} file(s), ${extracted.bytes} bytes` +
          (extracted.strippedRoot ? ` (stripped wrapper folder "${extracted.strippedRoot}")` : ""),
      );
    } catch (error) {
      if (error instanceof ZipError) {
        throw new JobFailure(`ZIP_${error.code}`, error.message);
      }
      throw error;
    }
  }

  /* 2. Validate ---------------------------------------------------------- */
  await ctx.progress({
    phase: "validate",
    current: 2,
    total: 5,
    message: "Checking the descriptor",
  });
  const stagingDir = await nameStagingAfterDescriptor(staging, work);

  let loaded: LoadedDescriptor;
  try {
    loaded = await readDescriptor(stagingDir);
  } catch (error) {
    if (error instanceof DescriptorError) throw new JobFailure(error.code, error.message);
    throw error;
  }
  const { descriptor } = loaded;
  ctx.log(
    `${descriptor.name} ${descriptor.version} (${descriptor.id}) — hosts: ${descriptor.hosts.join(", ")}`,
  );

  if (descriptor.sandbox === "relaxed" && !input.acceptRelaxedSandbox) {
    throw new JobFailure(
      "SANDBOX_NOT_ACCEPTED",
      `${descriptor.name} asks to run without Kiri's sandbox. Re-install with that explicitly accepted if you trust it.`,
    );
  }

  /* 3. Dependencies and SDK --------------------------------------------- */
  const pkg = await readPackageJson(stagingDir);
  const dependencies = installableDependencies(pkg);
  if (dependencies.length > 0) {
    await ctx.progress({
      phase: "dependencies",
      current: 3,
      total: 5,
      message: `Installing ${dependencies.length} dependenc${dependencies.length === 1 ? "y" : "ies"}`,
    });
    ctx.log(`Dependencies: ${dependencies.join(", ")}`);
    await npmInstall(stagingDir, ctx);
  } else {
    ctx.log("No dependencies to install");
  }

  const sdk = await linkSdk(stagingDir);
  ctx.log(`Linked @kiri/source-sdk ${bundledSdkVersion()} (${sdk.mode})`);

  /* 4. hello ------------------------------------------------------------- */
  await ctx.progress({ phase: "verify", current: 4, total: 5, message: "Running the plugin once" });
  const handshake = await helloCheck({
    plugin: {
      id: descriptor.id,
      dir: stagingDir,
      entryPath: loaded.entryPath,
      descriptor,
    },
    tmpDir: ctx.tmpDir,
    sdkDir: sdk.sdkDir,
    env: {
      KIRI_PLUGIN_DIR: stagingDir,
      KIRI_SDK_VERSION: loaded.sdkVersion,
      KIRI_APP_VERSION: process.env["NEXT_PUBLIC_APP_VERSION"] ?? "dev",
    },
    signal: ctx.signal,
    onStderr: (line) => ctx.log(`[hello] ${line}`),
  });
  if (!handshake.ok) {
    throw new JobFailure("HELLO_FAILED", handshake.reason);
  }
  ctx.log(`hello ok — protocol v${handshake.hello.v}, sdk ${handshake.hello.sdk}`);

  /* 5. Install ----------------------------------------------------------- */
  await ctx.progress({ phase: "install", current: 5, total: 5, message: "Moving into place" });
  const previous = await prisma.plugin.findUnique({
    where: { id: descriptor.id },
    select: { version: true },
  });

  const target = resolveInside(pluginsDir(), descriptor.id);
  await ensureDir(pluginsDir());
  const displaced = `${target}.old-${randomUUID().slice(0, 8)}`;
  const hadPrevious = (await stat(target).catch(() => null)) !== null;
  if (hadPrevious) await rename(target, displaced);

  try {
    await movePath(stagingDir, target);
  } catch (error) {
    // Put the old version back rather than leaving the plugin uninstalled.
    if (hadPrevious) await rename(displaced, target).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    throw new JobFailure("INSTALL_FAILED", `Could not move the plugin into place: ${message}`);
  }
  if (hadPrevious) await rm(displaced, { recursive: true, force: true }).catch(() => undefined);

  const installed = await readDescriptor(target);
  const { row } = await upsertPluginRow(installed, { installSource, status: "ENABLED" });

  /* 6. Re-point sources, audit, notify ----------------------------------- */
  const reattached = await reattachSources(row.id);
  await recordAudit({
    actorId: requestedById,
    action: PLUGIN_AUDIT.install,
    targetType: "plugin",
    targetId: row.id,
    metadata: {
      version: row.version,
      installSource,
      hosts: row.hosts,
      capabilities: row.capabilities,
      sandbox: descriptor.sandbox,
      previousVersion: previous?.version ?? null,
      sourcesReattached: reattached,
    },
  });

  const admins = await prisma.user.findMany({ where: { role: "admin" }, select: { id: true } });
  await createNotifications({
    userIds: admins.map((admin) => admin.id),
    type: "PLUGIN_INSTALLED",
    title: `${row.name} installed`,
    message:
      `${row.name} ${row.version} is ready` +
      (reattached > 0 ? ` and picked up ${reattached} series waiting for it.` : "."),
    link: "/admin/plugins",
  });

  return {
    pluginId: row.id,
    name: row.name,
    version: row.version,
    hosts: row.hosts,
    capabilities: row.capabilities,
    installSource,
    descriptorHash: row.descriptorHash,
    sdkVersion: installed.sdkVersion,
    dependenciesInstalled: dependencies.length > 0,
    previousVersion: previous?.version ?? null,
    sourcesReattached: reattached,
  };
}

/**
 * Attach every source that was waiting for this plugin — the ones the V1
 * importer parked with `configJson.v1Site`, plus any that kept the FK while
 * the plugin was BROKEN.
 */
export async function reattachSources(pluginId: string): Promise<number> {
  const waiting = await prisma.source.findMany({
    where: {
      OR: [
        { pluginId: null, configJson: { path: ["v1Site"], equals: pluginId } },
        { pluginId, status: "NEEDS_PLUGIN" },
      ],
    },
    select: { id: true, pluginId: true, normalizedUrl: true },
  });

  for (const source of waiting) {
    await prisma.source.update({
      where: { id: source.id },
      data: {
        pluginId,
        status: source.normalizedUrl ? "PENDING" : "UNCONFIGURED",
        lastErrorCode: null,
      },
    });
  }
  await reviveSourcesFor(pluginId);
  return waiting.length;
}

/* -------------------------------------------------------------------------- */
/* Uninstall / enable / disable                                               */
/* -------------------------------------------------------------------------- */

/**
 * Remove a plugin and its files. Series keep their chapters and their URL: the
 * source is parked as NEEDS_PLUGIN with `configJson.v1Site` set to the plugin
 * id, which is exactly the state the V1 importer produces — so re-installing
 * the plugin re-attaches them.
 */
export async function uninstallPlugin(id: string, actorId: string | null): Promise<void> {
  const row = await prisma.plugin.findUnique({ where: { id } });
  if (!row) return;

  const sources = await prisma.source.findMany({
    where: { pluginId: id },
    select: { id: true, configJson: true },
  });
  for (const source of sources) {
    const config =
      typeof source.configJson === "object" &&
      source.configJson !== null &&
      !Array.isArray(source.configJson)
        ? (source.configJson as Record<string, unknown>)
        : {};
    await prisma.source.update({
      where: { id: source.id },
      data: {
        pluginId: null,
        status: "NEEDS_PLUGIN",
        configJson: { ...config, v1Site: id } as Prisma.InputJsonValue,
      },
    });
  }

  try {
    await removeDirSafe(resolveInside(pluginsDir(), id));
  } catch (error) {
    console.error(`[plugins] could not remove the directory of ${id}`, error);
  }
  await prisma.plugin.delete({ where: { id } }).catch(() => undefined);

  await recordAudit({
    actorId,
    action: PLUGIN_AUDIT.uninstall,
    targetType: "plugin",
    targetId: id,
    metadata: { version: row.version, sourcesParked: sources.length },
  });
}

/** Enable or disable a plugin. Disabling never touches files or series data. */
export async function setPluginStatus(
  id: string,
  status: Extract<PluginStatus, "ENABLED" | "DISABLED">,
  actorId: string | null,
): Promise<PluginView | null> {
  const row = await prisma.plugin.findUnique({ where: { id } });
  if (!row) return null;

  if (status === "ENABLED") {
    // Re-validate before claiming a BROKEN plugin works again.
    const loaded = await loadPlugin(row);
    if (!loaded) return getPluginView(id);
    await prisma.plugin.update({ where: { id }, data: { status: "ENABLED", lastError: null } });
    await reviveSourcesFor(id);
  } else {
    await prisma.plugin.update({ where: { id }, data: { status: "DISABLED" } });
  }

  await recordAudit({
    actorId,
    action: PLUGIN_AUDIT.status,
    targetType: "plugin",
    targetId: id,
    metadata: { status },
  });
  return getPluginView(id);
}

/** Re-read `DATA_ROOT/plugins`; exported so routes can refresh after a change. */
export async function refreshPlugins(): Promise<void> {
  await scanPlugins();
}

/** The SDK an install would link, for the admin UI's confirmation screen. */
export function installerSdkInfo(): { dir: string; version: string } {
  return { dir: resolveSdkDir(), version: bundledSdkVersion() };
}
