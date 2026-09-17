/**
 * URL resolution: "which plugin handles this link, and what is it?"
 *
 * The host never guesses. It matches the URL's host label-wise against every
 * ENABLED plugin's `hosts`, spawns `resolve <url>` on the candidates (at most
 * three at a time, 20 s each) and takes the first `handled` answer. No match at
 * all is an instant, cheap "unsupported link" — no process is started.
 *
 * The answer is cached for five minutes because the series form calls this
 * while the user types and again when they submit. The cache holds only what
 * the plugin said; `existingSeriesId` is recomputed per request, since it
 * depends on who is asking. The key is the URL **without its query string or
 * fragment**, so `?i=1`, `?i=2`, … cannot walk past the cache and buy a
 * process per keystroke; the plugin still gets the URL exactly as given. (A
 * site whose identity lives in the query therefore shares one cache entry per
 * path for five minutes — cheap to be wrong about, expensive not to bound.)
 *
 * Spawning is bounded twice over: three plugins per call, and a process-wide
 * semaphore across all callers, because a route any member can POST must not
 * be able to fork the box.
 */
import { ApiError } from "@/lib/api";
import type { SessionUser } from "@/lib/auth/types";
import { visibleSeriesWhere } from "@/lib/authz";
import { MEDIA_TYPES, type MediaType } from "@/lib/contracts/series";
import type { ResolveUrlResponse } from "@/lib/contracts/plugins";
import { getEnv } from "@/lib/env";
import { jobTmpRoot } from "@/lib/jobs/tmp";
import { ensureDir, resolveInside } from "@/lib/content/store";
import { hostnameOf, needsCookie } from "@/lib/plugins/descriptor";
import { spawnPlugin } from "@/lib/plugins/process";
import { findPluginsForHost, type LoadedPlugin } from "@/lib/plugins/registry";
import { bundledSdkVersion, resolveSdkDir } from "@/lib/plugins/sdk-link";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "node:crypto";
import { removeDirSafe } from "@/lib/content/store";

/** How long one `resolve` may take before it is killed. */
export const RESOLVE_TIMEOUT_MS = 20_000;
/** Plugins asked at the same time. */
export const RESOLVE_CONCURRENCY = 3;
/** Cache lifetime for a URL's answer. */
export const RESOLVE_CACHE_MS = 5 * 60 * 1000;
const CACHE_LIMIT = 500;
/** Callers allowed to queue for a slot before the route sheds load. */
export const RESOLVE_QUEUE_LIMIT = 20;

/** What a plugin told us; user-independent, hence cacheable. */
export interface ResolvedSource {
  handled: boolean;
  pluginId: string | null;
  pluginName: string | null;
  normalizedUrl: string | null;
  slug: string | null;
  title: string | null;
  mediaType: MediaType | null;
  coverUrl: string | null;
  needsCookie: boolean;
}

const UNHANDLED: ResolvedSource = {
  handled: false,
  pluginId: null,
  pluginName: null,
  normalizedUrl: null,
  slug: null,
  title: null,
  mediaType: null,
  coverUrl: null,
  needsCookie: false,
};

interface CacheEntry {
  at: number;
  value: ResolvedSource;
}

// One cache per process, on globalThis for the same reason the job runner keeps
// its state there: Next may load this module once per route bundle.
const CACHE_KEY = Symbol.for("kiri.plugins.resolveCache");
function cache(): Map<string, CacheEntry> {
  const holder = globalThis as unknown as Record<symbol, Map<string, CacheEntry> | undefined>;
  return (holder[CACHE_KEY] ??= new Map());
}

/** Tests and the installer call this; a new plugin changes every answer. */
export function clearResolveCache(): void {
  cache().clear();
}

/**
 * Cache key for a URL: scheme, host and path only. See the module header for
 * why the query string is dropped here but never from what a plugin is asked.
 */
export function resolveCacheKey(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    // Keep the query (some sites identify a series only by it) but make it
    // order-independent and drop the fragment; the spawn semaphore and the
    // per-user rate limit are what bound abuse, not the cache key.
    parsed.searchParams.sort();
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

/* -------------------------------------------------------------------------- */
/* Spawn semaphore                                                            */
/* -------------------------------------------------------------------------- */

interface ResolveGate {
  active: number;
  limit: number;
  waiting: (() => void)[];
}

// On globalThis for the same reason the cache is: Next may load this module
// once per route bundle, and a per-bundle semaphore bounds nothing.
const GATE_KEY = Symbol.for("kiri.plugins.resolveGate");

function gateHolder(): Record<symbol, ResolveGate | undefined> {
  return globalThis as unknown as Record<symbol, ResolveGate | undefined>;
}

/**
 * Total plugin processes this host will run for URL resolution at once. Tied
 * to JOB_CONCURRENCY because that is the operator's statement of how much
 * subprocess work the box can take; never below two, so one slow plugin cannot
 * stall every resolve.
 */
function resolveSlotLimit(): number {
  try {
    return Math.max(2, getEnv().JOB_CONCURRENCY * 2);
  } catch {
    // No validated environment (a unit test, a build probe): stay conservative.
    return 2;
  }
}

function gate(): ResolveGate {
  const holder = gateHolder();
  return (holder[GATE_KEY] ??= { active: 0, limit: resolveSlotLimit(), waiting: [] });
}

/** Test helper: drop the semaphore (and re-read JOB_CONCURRENCY). */
export function resetResolveGate(): void {
  delete gateHolder()[GATE_KEY];
}

/** How many resolves are running and queued right now (tests, diagnostics). */
export function resolveGateState(): { active: number; limit: number; waiting: number } {
  const current = gate();
  return { active: current.active, limit: current.limit, waiting: current.waiting.length };
}

/**
 * Run `task` in one of the semaphore's slots, waiting for a free one. A slot is
 * handed straight to the next waiter on release, so the count is exact and
 * arrivals never overtake the queue.
 */
async function withResolveSlot<T>(task: () => Promise<T>): Promise<T> {
  const current = gate();
  if (current.active >= current.limit || current.waiting.length > 0) {
    if (current.waiting.length >= RESOLVE_QUEUE_LIMIT) {
      throw new ApiError(503, "BUSY", "Kiri is busy checking links right now. Try again shortly.");
    }
    await new Promise<void>((resolve) => current.waiting.push(resolve));
    // Woken holding the slot the releaser handed over: `active` already counts it.
  } else {
    current.active += 1;
  }

  try {
    return await task();
  } finally {
    const next = current.waiting.shift();
    if (next) next();
    else current.active -= 1;
  }
}

/* -------------------------------------------------------------------------- */
/* Reading a plugin's answer                                                  */
/* -------------------------------------------------------------------------- */

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asMediaType(value: unknown): MediaType | null {
  return typeof value === "string" && (MEDIA_TYPES as readonly string[]).includes(value)
    ? (value as MediaType)
    : null;
}

/** Turn a `result` payload into our shape, or null when it declined. */
export function readResolveResult(plugin: LoadedPlugin, data: unknown): ResolvedSource | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record["handled"] !== true) return null;

  const normalizedUrl = asString(record["normalizedUrl"]);
  if (normalizedUrl === null) return null;

  return {
    handled: true,
    pluginId: plugin.row.id,
    pluginName: plugin.row.name,
    normalizedUrl,
    slug: asString(record["slug"]),
    title: asString(record["title"]),
    mediaType: asMediaType(record["mediaType"]),
    coverUrl: asString(record["coverUrl"]),
    needsCookie: needsCookie(plugin.descriptor),
  };
}

async function askPlugin(plugin: LoadedPlugin, url: string): Promise<ResolvedSource | null> {
  return withResolveSlot(() => runResolve(plugin, url));
}

async function runResolve(plugin: LoadedPlugin, url: string): Promise<ResolvedSource | null> {
  const scratch = resolveInside(jobTmpRoot(), `resolve-${randomUUID().slice(0, 8)}`);
  await ensureDir(scratch);
  try {
    const run = await spawnPlugin({
      plugin: {
        id: plugin.row.id,
        dir: plugin.dir,
        entryPath: plugin.entryPath,
        descriptor: plugin.descriptor,
      },
      verb: "resolve",
      args: [url],
      tmpDir: scratch,
      sdkDir: resolveSdkDir(),
      env: {
        KIRI_PLUGIN_DIR: plugin.dir,
        KIRI_SDK_VERSION: bundledSdkVersion(),
        KIRI_APP_VERSION: process.env["NEXT_PUBLIC_APP_VERSION"] ?? "dev",
      },
      timeouts: { hello: RESOLVE_TIMEOUT_MS, idle: RESOLVE_TIMEOUT_MS, total: RESOLVE_TIMEOUT_MS },
    });
    if (run.error && run.error.code !== "UNSUPPORTED_URL") {
      console.warn(
        `[plugins] ${plugin.row.id} resolve failed: ${run.error.code} ${run.error.message}`,
      );
    }
    return readResolveResult(plugin, run.result);
  } catch (error) {
    console.error(`[plugins] ${plugin.row.id} resolve crashed`, error);
    return null;
  } finally {
    await removeDirSafe(scratch).catch(() => undefined);
  }
}

/** Ask every candidate, `RESOLVE_CONCURRENCY` at a time, and keep them all. */
async function askAll(plugins: LoadedPlugin[], url: string): Promise<ResolvedSource[]> {
  const answers: (ResolvedSource | null)[] = new Array<ResolvedSource | null>(plugins.length).fill(
    null,
  );
  let next = 0;
  const workers = Array.from(
    { length: Math.min(RESOLVE_CONCURRENCY, plugins.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        const plugin = plugins[index];
        if (!plugin) return;
        answers[index] = await askPlugin(plugin, url);
      }
    },
  );
  await Promise.all(workers);
  return answers.filter((answer): answer is ResolvedSource => answer !== null);
}

/* -------------------------------------------------------------------------- */
/* Public surface                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a URL against the installed plugins, with caching. The result is
 * user-independent — {@link resolveSourceUrl} adds the per-user part.
 */
export async function resolveUrl(url: string): Promise<ResolvedSource> {
  const target = url.trim();
  const key = resolveCacheKey(target);
  const hit = cache().get(key);
  if (hit && Date.now() - hit.at < RESOLVE_CACHE_MS) return hit.value;

  const hostname = hostnameOf(target);
  let value = UNHANDLED;
  if (hostname !== null) {
    // Ordered by id in the registry, so ties resolve the same way every time.
    const candidates = await findPluginsForHost(hostname);
    if (candidates.length > 0) {
      // The plugin sees the URL as the user gave it, query string included.
      const answers = await askAll(candidates, target);
      value = answers[0] ?? UNHANDLED;
    }
  }

  const store = cache();
  if (store.size >= CACHE_LIMIT) store.clear();
  store.set(key, { at: Date.now(), value });
  return value;
}

/** The series (visible to this user) that already uses `normalizedUrl`. */
export async function findSeriesByNormalizedUrl(
  user: SessionUser,
  normalizedUrl: string,
  options: { excludeSeriesId?: string } = {},
): Promise<string | null> {
  const source = await prisma.source.findFirst({
    where: {
      normalizedUrl,
      ...(options.excludeSeriesId ? { seriesId: { not: options.excludeSeriesId } } : {}),
      series: { is: visibleSeriesWhere(user) },
    },
    select: { seriesId: true },
  });
  return source?.seriesId ?? null;
}

/** POST /api/plugins/resolve. */
export async function resolveSourceUrl(
  user: SessionUser,
  url: string,
): Promise<ResolveUrlResponse> {
  const resolved = await resolveUrl(url);
  const existingSeriesId = resolved.normalizedUrl
    ? await findSeriesByNormalizedUrl(user, resolved.normalizedUrl)
    : null;
  return { ...resolved, existingSeriesId };
}

/**
 * Shared 409 for "another series already reads from this URL". The series id
 * travels in `details` so the UI can offer to open it instead.
 */
export function duplicateSourceConflict(existingSeriesId: string): ApiError {
  return new ApiError(409, "CONFLICT", "Another series in your library already uses that link", {
    existingSeriesId,
  });
}
