/**
 * Finding the bundled `@kiri/source-sdk` and linking it into a plugin.
 *
 * A plugin must never vendor the SDK or list it in `dependencies`: it declares
 * a range in `kiri-plugin.json` and the host links whatever it ships. That
 * makes zip installs work with no network at all and guarantees every plugin
 * on an instance runs the same SDK.
 *
 * Where the SDK lives depends on how Kiri is running:
 *   - `KIRI_SDK_DIR`      an explicit directory (tests, unusual deployments);
 *   - `KIRI_SDK_ROOT`     a directory holding `VERSION` and `<version>/` — this
 *                         is what the Docker image sets (`/app/sdk`, see the
 *                         `build` stage of docker/Dockerfile, which packs the
 *                         SDK to `/app/sdk/<version>` and writes `/app/sdk/VERSION`);
 *   - a `node_modules/@kiri/source-sdk` above the cwd (the dev workspace);
 *   - `packages/source-sdk` above the cwd (a source checkout without an install).
 *
 * `require.resolve` is deliberately not used: the SDK's package `exports` map
 * declares only an `import` condition, so CJS resolution — which is what a Next
 * server bundle runs — cannot see it at all.
 */
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";

/** The npm name of the SDK; also its directory name under `node_modules/@kiri`. */
export const SDK_PACKAGE = "@kiri/source-sdk";

interface SdkPackageJson {
  name?: unknown;
  version?: unknown;
}

function readPackageVersion(dir: string): string | null {
  try {
    const raw = readFileSync(path.join(dir, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as SdkPackageJson;
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/** A directory only counts as the SDK when it has a package.json with a version. */
function isSdkDir(dir: string | undefined | null): dir is string {
  return typeof dir === "string" && dir !== "" && readPackageVersion(dir) !== null;
}

function fromSdkRoot(root: string): string | null {
  const versionFile = path.join(root, "VERSION");
  try {
    const version = readFileSync(versionFile, "utf8").trim();
    if (version === "") return null;
    const dir = path.join(root, version);
    return isSdkDir(dir) ? dir : null;
  } catch {
    return null;
  }
}

/** Walk up from `start` looking for `node_modules/@kiri/source-sdk`. */
function fromNodeModules(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, "node_modules", "@kiri", "source-sdk");
    if (isSdkDir(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Walk up from `start` looking for the monorepo's `packages/source-sdk`. */
function fromWorkspace(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, "packages", "source-sdk");
    if (isSdkDir(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Absolute path of the SDK tree plugins link against. Not cached: tests move
 * `KIRI_SDK_DIR` around, and the lookup is a handful of `existsSync` calls.
 */
export function resolveSdkDir(): string {
  const explicit = process.env["KIRI_SDK_DIR"];
  if (explicit !== undefined && explicit.trim() !== "") {
    const dir = path.resolve(explicit.trim());
    if (!isSdkDir(dir)) {
      throw new Error(`KIRI_SDK_DIR=${explicit} does not contain a package.json`);
    }
    return dir;
  }

  const root = process.env["KIRI_SDK_ROOT"];
  if (root !== undefined && root.trim() !== "") {
    const dir = fromSdkRoot(path.resolve(root.trim()));
    if (dir) return dir;
  }

  const cwd = process.cwd();
  const found = fromNodeModules(cwd) ?? fromWorkspace(cwd);
  if (found) return found;

  throw new Error(
    `Cannot find ${SDK_PACKAGE}. Set KIRI_SDK_DIR to the directory holding its package.json.`,
  );
}

/** Version of the SDK this host will link into plugins. */
export function bundledSdkVersion(): string {
  const version = readPackageVersion(resolveSdkDir());
  if (version === null) {
    throw new Error(`${SDK_PACKAGE} has no version in its package.json`);
  }
  return version;
}

/**
 * Point `<pluginDir>/node_modules/@kiri/source-sdk` at the bundled SDK,
 * replacing whatever was there. A junction on Windows (no developer-mode or
 * admin rights needed, unlike a symlink), a directory symlink elsewhere.
 *
 * If the link cannot be created at all — an exotic filesystem, a Docker volume
 * mounted from a host that forbids links — the SDK is copied instead. A copy
 * costs a few hundred kB per plugin and keeps installs working.
 */
export async function linkSdk(
  pluginDir: string,
): Promise<{ sdkDir: string; mode: "link" | "copy" }> {
  const sdkDir = resolveSdkDir();
  const scope = path.join(pluginDir, "node_modules", "@kiri");
  const target = path.join(scope, "source-sdk");

  await mkdir(scope, { recursive: true });
  await rm(target, { recursive: true, force: true });

  try {
    await symlink(sdkDir, target, process.platform === "win32" ? "junction" : "dir");
    return { sdkDir, mode: "link" };
  } catch {
    await cp(sdkDir, target, { recursive: true, dereference: true });
    return { sdkDir, mode: "copy" };
  }
}

/** True when `dir` already has a usable SDK link (used by the boot scan). */
export function hasSdkLink(pluginDir: string): boolean {
  return existsSync(path.join(pluginDir, "node_modules", "@kiri", "source-sdk", "package.json"));
}
