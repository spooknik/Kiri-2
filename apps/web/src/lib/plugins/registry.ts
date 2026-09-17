/**
 * The plugin registry: what is installed, what is runnable, and who handles a
 * host.
 *
 * `DATA_ROOT/plugins/<id>/` is the source of truth for *files*; the `Plugin`
 * table is the source of truth for *state* (enabled/disabled, install
 * provenance, the last error an admin should see). {@link scanPlugins}
 * reconciles the two at boot and after every install or uninstall.
 *
 * Two rules keep this safe and boring:
 *   - **Boot never executes plugin code.** The scan reads and validates
 *     descriptors only; the first time a plugin runs is when a user asks for
 *     something.
 *   - **A row is never deleted because its directory vanished.** It becomes
 *     BROKEN and its series flip to NEEDS_PLUGIN, so a volume that failed to
 *     mount does not silently unbind every series on the instance.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { MediaType, Plugin, PluginStatus, Prisma } from "@/generated/prisma/client";
import { pluginsDir, resolveInside } from "@/lib/content/store";
import type { PluginDescriptor, PluginView } from "@/lib/contracts/plugins";
import {
  DescriptorError,
  hostsMatch,
  normalizeHostname,
  readDescriptor,
  type LoadedDescriptor,
} from "@/lib/plugins/descriptor";
import { toPluginView } from "@/lib/plugins/serialize";
import { prisma } from "@/lib/prisma";

/** A row plus the descriptor on disk — everything needed to spawn it. */
export interface LoadedPlugin {
  row: Plugin;
  descriptor: PluginDescriptor;
  dir: string;
  entryPath: string;
}

export interface ScanResult {
  /** Directories that held a valid descriptor. */
  ok: number;
  added: number;
  updated: number;
  /** Directories with an unusable descriptor. */
  invalid: number;
  /** Rows whose directory is gone. */
  missing: number;
}

/** Fields a descriptor owns; the rest of the row belongs to the installer. */
function descriptorFields(
  loaded: LoadedDescriptor,
): Pick<
  Prisma.PluginUncheckedCreateInput,
  | "name"
  | "version"
  | "sdkRange"
  | "entry"
  | "dir"
  | "hosts"
  | "capabilities"
  | "mediaTypes"
  | "adult"
  | "homepage"
  | "license"
  | "minKiriVersion"
  | "descriptorHash"
> {
  const { descriptor } = loaded;
  return {
    name: descriptor.name,
    version: descriptor.version,
    sdkRange: descriptor.sdk,
    entry: descriptor.entry,
    dir: loaded.dir,
    hosts: descriptor.hosts.map(normalizeHostname),
    capabilities: [...descriptor.capabilities],
    mediaTypes: descriptor.mediaTypes as MediaType[],
    adult: descriptor.adult,
    homepage: descriptor.homepage ?? null,
    license: descriptor.license ?? null,
    minKiriVersion: descriptor.minKiriVersion ?? null,
    descriptorHash: loaded.descriptorHash,
  };
}

/**
 * Write the row for a validated plugin directory.
 *
 * A DISABLED plugin stays disabled — that is an admin's decision, not a
 * property of the files — while a BROKEN one that now validates is healed.
 */
export async function upsertPluginRow(
  loaded: LoadedDescriptor,
  options: { installSource?: string; status?: PluginStatus } = {},
): Promise<{ row: Plugin; created: boolean; changed: boolean }> {
  const id = loaded.descriptor.id;
  const existing = await prisma.plugin.findUnique({ where: { id } });
  const fields = descriptorFields(loaded);

  if (!existing) {
    const row = await prisma.plugin.create({
      data: {
        id,
        ...fields,
        installSource: options.installSource ?? "dropin",
        status: options.status ?? "ENABLED",
        lastError: null,
      },
    });
    return { row, created: true, changed: true };
  }

  const status =
    options.status ?? (existing.status === "DISABLED" ? "DISABLED" : ("ENABLED" as PluginStatus));
  const changed =
    existing.descriptorHash !== loaded.descriptorHash ||
    existing.dir !== loaded.dir ||
    existing.status !== status ||
    existing.lastError !== null;

  const row = await prisma.plugin.update({
    where: { id },
    data: {
      ...fields,
      status,
      lastError: null,
      ...(options.installSource ? { installSource: options.installSource } : {}),
    },
  });
  return { row, created: false, changed };
}

/** Flag a plugin unusable and take its series out of the sync rotation. */
export async function markPluginBroken(id: string, message: string): Promise<void> {
  await prisma.plugin.updateMany({
    where: { id },
    data: { status: "BROKEN", lastError: message.slice(0, 1000) },
  });
  await prisma.source.updateMany({
    where: { pluginId: id, status: { not: "NEEDS_PLUGIN" } },
    data: { status: "NEEDS_PLUGIN" },
  });
}

/**
 * Bring a plugin's sources back after it became available again: a source that
 * knows its URL is PENDING (it will sync), one that does not is UNCONFIGURED.
 */
export async function reviveSourcesFor(pluginId: string): Promise<number> {
  const sources = await prisma.source.findMany({
    where: { pluginId, status: "NEEDS_PLUGIN" },
    select: { id: true, normalizedUrl: true },
  });
  for (const source of sources) {
    await prisma.source.update({
      where: { id: source.id },
      data: { status: source.normalizedUrl ? "PENDING" : "UNCONFIGURED" },
    });
  }
  return sources.length;
}

/* -------------------------------------------------------------------------- */
/* Boot scan                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Reconcile `DATA_ROOT/plugins` with the `Plugin` table. Runs at boot and
 * after install/uninstall. Never throws: a plugin directory that cannot be
 * read must not stop the server from starting.
 */
export async function scanPlugins(): Promise<ScanResult> {
  const result: ScanResult = { ok: 0, added: 0, updated: 0, invalid: 0, missing: 0 };
  const root = pluginsDir();

  let entries: string[] = [];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[plugins] cannot read the plugins directory", error);
    }
    entries = [];
  }

  const seen = new Set<string>();
  for (const name of entries) {
    const dir = resolveInside(root, name);
    try {
      const loaded = await readDescriptor(dir);
      const { created, changed } = await upsertPluginRow(loaded);
      seen.add(loaded.descriptor.id);
      result.ok += 1;
      if (created) result.added += 1;
      else if (changed) result.updated += 1;
      await reviveSourcesFor(loaded.descriptor.id);
    } catch (error) {
      result.invalid += 1;
      const message =
        error instanceof DescriptorError
          ? error.message
          : `Could not read this plugin: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[plugins] ${name}: ${message}`);
      // Only touch a row that already exists — a stray directory is not a
      // plugin until an install (or a valid descriptor) says so.
      const existing = await prisma.plugin.findUnique({
        where: { id: name },
        select: { id: true },
      });
      if (existing) {
        seen.add(name);
        await markPluginBroken(name, message);
      }
    }
  }

  const rows = await prisma.plugin.findMany({ select: { id: true, status: true } });
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    result.missing += 1;
    if (row.status !== "BROKEN") {
      await markPluginBroken(row.id, "The plugin directory is missing from DATA_ROOT/plugins.");
    } else {
      await prisma.source.updateMany({
        where: { pluginId: row.id, status: { not: "NEEDS_PLUGIN" } },
        data: { status: "NEEDS_PLUGIN" },
      });
    }
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

async function countsFor(
  ids: readonly string[],
): Promise<Map<string, { sources: number; credential: boolean }>> {
  const counts = new Map<string, { sources: number; credential: boolean }>();
  if (ids.length === 0) return counts;
  const [sources, credentials] = await Promise.all([
    prisma.source.groupBy({
      by: ["pluginId"],
      where: { pluginId: { in: [...ids] } },
      _count: true,
    }),
    prisma.pluginCredential.findMany({
      where: { pluginId: { in: [...ids] } },
      select: { pluginId: true },
      distinct: ["pluginId"],
    }),
  ]);
  for (const id of ids) counts.set(id, { sources: 0, credential: false });
  for (const group of sources) {
    if (group.pluginId === null) continue;
    const entry = counts.get(group.pluginId);
    if (entry) entry.sources = group._count;
  }
  for (const credential of credentials) {
    const entry = counts.get(credential.pluginId);
    if (entry) entry.credential = true;
  }
  return counts;
}

/** Every installed plugin, newest install first. */
export async function listPlugins(): Promise<PluginView[]> {
  const rows = await prisma.plugin.findMany({ orderBy: [{ installedAt: "desc" }, { id: "asc" }] });
  const counts = await countsFor(rows.map((row) => row.id));
  return rows.map((row) => {
    const entry = counts.get(row.id);
    return toPluginView(row, {
      sourceCount: entry?.sources ?? 0,
      hasCredential: entry?.credential ?? false,
    });
  });
}

export async function getPluginView(id: string): Promise<PluginView | null> {
  const row = await prisma.plugin.findUnique({ where: { id } });
  if (!row) return null;
  const counts = await countsFor([id]);
  const entry = counts.get(id);
  return toPluginView(row, {
    sourceCount: entry?.sources ?? 0,
    hasCredential: entry?.credential ?? false,
  });
}

/** The raw row (the installer and the sync handler need more than the view). */
export async function getPlugin(id: string): Promise<Plugin | null> {
  return prisma.plugin.findUnique({ where: { id } });
}

/**
 * Load a row's descriptor from disk. Returns null — and marks the row BROKEN —
 * when the files no longer back the row, so callers can treat "runnable" as a
 * single check.
 */
export async function loadPlugin(row: Plugin): Promise<LoadedPlugin | null> {
  const dir = row.dir && path.isAbsolute(row.dir) ? row.dir : resolveInside(pluginsDir(), row.id);
  try {
    const loaded = await readDescriptor(dir);
    return {
      row,
      descriptor: loaded.descriptor,
      dir: loaded.dir,
      entryPath: loaded.entryPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markPluginBroken(row.id, message);
    return null;
  }
}

/** An ENABLED plugin whose files are present, or null. */
export async function getEnabledPlugin(id: string): Promise<LoadedPlugin | null> {
  const row = await prisma.plugin.findUnique({ where: { id } });
  if (!row || row.status !== "ENABLED") return null;
  return loadPlugin(row);
}

/**
 * Every ENABLED plugin claiming `hostname`, in descriptor-id order so a
 * resolve fan-out is deterministic. Host matching is done in JS rather than in
 * the GIN index because `*.` patterns are not equality.
 */
export async function findPluginsForHost(hostname: string): Promise<LoadedPlugin[]> {
  const host = normalizeHostname(hostname);
  if (host === "") return [];
  const rows = await prisma.plugin.findMany({
    where: { status: "ENABLED" },
    orderBy: { id: "asc" },
  });
  const candidates = rows.filter((row) => hostsMatch(row.hosts, host));
  const loaded: LoadedPlugin[] = [];
  for (const row of candidates) {
    const plugin = await loadPlugin(row);
    if (plugin) loaded.push(plugin);
  }
  return loaded;
}

/** Hosts of ENABLED plugins that declare the `cookie` capability. */
export async function cookieHosts(): Promise<
  { host: string; pluginId: string; pluginName: string }[]
> {
  const rows = await prisma.plugin.findMany({
    where: { status: "ENABLED", capabilities: { has: "cookie" } },
    orderBy: { id: "asc" },
    select: { id: true, name: true, hosts: true },
  });
  const seen = new Set<string>();
  const hosts: { host: string; pluginId: string; pluginName: string }[] = [];
  for (const row of rows) {
    for (const host of row.hosts) {
      const normalized = normalizeHostname(host);
      if (normalized === "" || seen.has(normalized)) continue;
      seen.add(normalized);
      hosts.push({ host: normalized, pluginId: row.id, pluginName: row.name });
    }
  }
  return hosts;
}
