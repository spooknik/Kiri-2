/**
 * Fixtures for the plugin-host integration tests.
 *
 * Everything here is built from the real `packages/source-template` — the same
 * plugin `docs/PLUGINS.md` tells authors to copy — so the tests exercise the
 * actual install and sync path rather than a mock that agrees with us.
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildZip, type ZipEntry } from "./zip-fixture";

/** `apps/web/test` -> the monorepo root. */
export const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
export const TEMPLATE_DIR = path.join(REPO_ROOT, "packages", "source-template");
export const SDK_DIR = path.join(REPO_ROOT, "packages", "source-sdk");
export const FIXTURE_SITE = path.join(TEMPLATE_DIR, "fixture-site");

/** The files a plugin ships; `fixture-site` and `serve.mjs` are not part of it. */
const TEMPLATE_FILES = ["kiri-plugin.json", "package.json", "src/index.mjs"] as const;

export interface TemplateOptions {
  /** Descriptor id (and therefore directory name) to publish under. */
  id?: string;
  hosts?: string[];
  capabilities?: string[];
  sdk?: string;
  sandbox?: "strict" | "relaxed";
  version?: string;
  /** Wrap every entry in this folder, the way GitHub's "Download ZIP" does. */
  wrapIn?: string;
}

/** The template descriptor with `options` applied. */
export function templateDescriptor(options: TemplateOptions = {}): Record<string, unknown> {
  const descriptor = JSON.parse(
    readFileSync(path.join(TEMPLATE_DIR, "kiri-plugin.json"), "utf8"),
  ) as Record<string, unknown>;
  if (options.id !== undefined) descriptor["id"] = options.id;
  if (options.hosts !== undefined) descriptor["hosts"] = options.hosts;
  if (options.capabilities !== undefined) descriptor["capabilities"] = options.capabilities;
  if (options.sdk !== undefined) descriptor["sdk"] = options.sdk;
  if (options.sandbox !== undefined) descriptor["sandbox"] = options.sandbox;
  if (options.version !== undefined) descriptor["version"] = options.version;
  return descriptor;
}

/**
 * The template plugin as an installable zip.
 *
 * The plugin's own `id` in `src/index.mjs` is rewritten alongside the
 * descriptor's, because `definePlugin`'s id has to match (the host's `hello`
 * check compares them).
 */
export function buildTemplateZip(options: TemplateOptions = {}): Buffer {
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [];
  const prefix = options.wrapIn ? `${options.wrapIn}/` : "";

  for (const file of TEMPLATE_FILES) {
    let contents = readFileSync(path.join(TEMPLATE_DIR, file), "utf8");
    if (file === "kiri-plugin.json") {
      contents = JSON.stringify(templateDescriptor(options), null, 2);
    } else if (file === "src/index.mjs" && options.id !== undefined) {
      contents = contents.replace(/id:\s*"template"/, `id: ${JSON.stringify(options.id)}`);
    }
    entries.push({ name: `${prefix}${file}`, data: encoder.encode(contents) });
  }
  return buildZip(entries);
}

/**
 * Copy the template into `DATA_ROOT/plugins/<id>` by hand — the "drop a folder
 * in and restart" install path, which never goes through the installer.
 */
export function dropInPlugin(pluginsDir: string, options: TemplateOptions = {}): string {
  const id = options.id ?? "template";
  const dir = path.join(pluginsDir, id);
  mkdirSync(path.join(dir, "src"), { recursive: true });

  let entry = readFileSync(path.join(TEMPLATE_DIR, "src", "index.mjs"), "utf8");
  if (options.id !== undefined) {
    entry = entry.replace(/id:\s*"template"/, `id: ${JSON.stringify(options.id)}`);
  }
  writeFileSync(path.join(dir, "src", "index.mjs"), entry);
  writeFileSync(
    path.join(dir, "kiri-plugin.json"),
    JSON.stringify(templateDescriptor(options), null, 2),
  );
  cpSync(path.join(TEMPLATE_DIR, "package.json"), path.join(dir, "package.json"));
  return dir;
}
