/**
 * Cookies and User-Agents for sites that gate content behind a bot check.
 *
 * Two places can hold one:
 *   - `Source.cookieEnc` — pasted by a user on one series;
 *   - `PluginCredential` — captured for a whole host by the Cookie Bridge
 *     extension.
 *
 * Choosing between them is V1's rule, ported verbatim (`rip-queue.ts:496-538`)
 * because it was hard-won:
 *
 *   - whichever was **set more recently** wins, comparing `cookieUpdatedAt`
 *     (stamped only when the value changes) against the credential's
 *     `updatedAt` — otherwise a stale paste permanently shadows a fresh capture
 *     and the user can never escape the "paste a cookie" loop;
 *   - the cookie and the User-Agent **always travel together** from the same
 *     source. `cf_clearance` is bound to the exact User-Agent that solved the
 *     challenge; mixing them re-triggers the challenge every time;
 *   - a per-series cookie with no timestamp is treated as epoch 0, so any
 *     timestamped credential takes over.
 *
 * Cookies are stored encrypted (`src/lib/crypto.ts`) and never travel on argv.
 */
import type { Prisma, Source } from "@/generated/prisma/client";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { hostMatches, hostsMatch, normalizeHostname } from "@/lib/plugins/descriptor";
import { prisma } from "@/lib/prisma";

/**
 * Cloudflare's bot-management cookies are bound to the browser's IP and TLS
 * fingerprint. Replaying them from a server makes Cloudflare re-challenge even
 * with a valid `cf_clearance`, which is why a hand-pasted `cf_clearance` works
 * where a full captured jar does not. Strip them on the way in.
 */
const VOLATILE_COOKIE_NAMES = new Set(["__cf_bm", "_cfuvid", "cf_chl_rc_ni"]);

/** Remove the cookies that must never be replayed. Ported from V1. */
export function stripVolatileCookies(cookieHeader: string): string {
  // A bare cf_clearance value (no "=") has nothing to strip.
  if (!cookieHeader.includes("=")) return cookieHeader.trim();

  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      if (part === "") return false;
      const name = (part.split("=")[0] ?? "").trim();
      return !VOLATILE_COOKIE_NAMES.has(name) && !name.startsWith("cf_chl_");
    })
    .join("; ");
}

/** A pasted bare token is the `cf_clearance` value; give it its name back. */
export function normalizeCookieHeader(raw: string): string {
  const cleaned = stripVolatileCookies(raw.trim());
  if (cleaned === "") return "";
  return cleaned.includes("=") ? cleaned : `cf_clearance=${cleaned}`;
}

/**
 * Prisma's `Bytes` columns take a plain `Uint8Array` over a real `ArrayBuffer`;
 * `encryptSecret` returns a Node `Buffer`, which may be a view on a pooled
 * (possibly shared) buffer. Copy rather than cast. Same helper as
 * `src/lib/import-v1/writer.ts`.
 */
export function toBytes(value: Buffer): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy;
}

/** Encrypt a cookie for storage, after stripping and normalising it. */
export function sealCookie(raw: string): Uint8Array<ArrayBuffer> {
  return toBytes(encryptSecret(normalizeCookieHeader(raw)));
}

/* -------------------------------------------------------------------------- */
/* Choosing                                                                   */
/* -------------------------------------------------------------------------- */

export interface CredentialCandidate {
  cookie: string | null;
  userAgent: string | null;
  /** When this pair was last set. */
  updatedAt: Date | null;
}

export interface ChosenCredential {
  cookie: string | null;
  userAgent: string | null;
  origin: "series" | "plugin" | "none";
}

/**
 * Apply the recency rule. Exported on its own so the rule is unit-testable
 * without a database.
 */
export function chooseCredential(
  series: CredentialCandidate,
  plugin: CredentialCandidate | null,
): ChosenCredential {
  const seriesCookie = series.cookie && series.cookie !== "" ? series.cookie : null;
  const pluginCookie = plugin?.cookie && plugin.cookie !== "" ? plugin.cookie : null;

  if (!pluginCookie) {
    return seriesCookie
      ? { cookie: seriesCookie, userAgent: series.userAgent, origin: "series" }
      : { cookie: null, userAgent: null, origin: "none" };
  }
  if (!seriesCookie) {
    return { cookie: pluginCookie, userAgent: plugin?.userAgent ?? null, origin: "plugin" };
  }

  // An undated per-series paste is legacy; let a dated capture take over.
  const seriesTime = series.updatedAt?.getTime() ?? 0;
  const pluginTime = plugin?.updatedAt?.getTime() ?? 0;
  return pluginTime >= seriesTime
    ? { cookie: pluginCookie, userAgent: plugin?.userAgent ?? null, origin: "plugin" }
    : { cookie: seriesCookie, userAgent: series.userAgent, origin: "series" };
}

/**
 * The plugin-level credential that applies to `hostname`: an exact host match
 * first, then a pattern match, then — for a single-host plugin — its only
 * credential.
 */
export function pickCredentialForHost<T extends { host: string }>(
  credentials: readonly T[],
  hostname: string | null,
): T | null {
  if (credentials.length === 0) return null;
  const host = hostname === null ? "" : normalizeHostname(hostname);
  if (host !== "") {
    const exact = credentials.find((credential) => normalizeHostname(credential.host) === host);
    if (exact) return exact;
    const pattern = credentials.find((credential) => hostMatches(host, credential.host));
    if (pattern) return pattern;
  }
  return credentials.length === 1 ? (credentials[0] ?? null) : null;
}

/** Resolve the cookie/User-Agent a sync of `source` should run with. */
export async function credentialForSource(
  source: Pick<
    Source,
    "cookieEnc" | "userAgent" | "cookieUpdatedAt" | "pluginId" | "normalizedUrl"
  >,
): Promise<ChosenCredential> {
  const seriesCandidate: CredentialCandidate = {
    cookie: source.cookieEnc ? decryptSecret(source.cookieEnc) : null,
    userAgent: source.userAgent,
    updatedAt: source.cookieUpdatedAt,
  };

  let pluginCandidate: CredentialCandidate | null = null;
  if (source.pluginId) {
    const rows = await prisma.pluginCredential.findMany({
      where: { pluginId: source.pluginId },
      orderBy: { updatedAt: "desc" },
    });
    let hostname: string | null = null;
    try {
      hostname = source.normalizedUrl ? new URL(source.normalizedUrl).hostname : null;
    } catch {
      hostname = null;
    }
    const chosen = pickCredentialForHost(rows, hostname);
    if (chosen) {
      pluginCandidate = {
        cookie: chosen.cookieEnc ? decryptSecret(chosen.cookieEnc) : null,
        userAgent: chosen.userAgent,
        updatedAt: chosen.updatedAt,
      };
    }
  }

  return chooseCredential(seriesCandidate, pluginCandidate);
}

/* -------------------------------------------------------------------------- */
/* Extension ingest                                                           */
/* -------------------------------------------------------------------------- */

export interface IngestCredentialInput {
  host: string;
  cookie: string;
  userAgent?: string | null;
}

export interface IngestCredentialResult {
  pluginId: string;
  pluginName: string;
  host: string;
  /** Sources that were stuck on NEEDS_CREDENTIAL and have been un-flagged. */
  clearedSources: number;
}

/**
 * Store a cookie captured by the extension. The host decides which plugin owns
 * it; an unknown host is a 404 at the route, so the extension stops sending.
 */
export async function ingestPluginCredential(
  input: IngestCredentialInput,
): Promise<IngestCredentialResult | null> {
  const host = normalizeHostname(input.host);
  if (host === "") return null;

  const plugins = await prisma.plugin.findMany({
    where: { status: "ENABLED", capabilities: { has: "cookie" } },
    orderBy: { id: "asc" },
    select: { id: true, name: true, hosts: true },
  });
  const plugin = plugins.find((candidate) => hostsMatch(candidate.hosts, host));
  if (!plugin) return null;

  const cookie = normalizeCookieHeader(input.cookie);
  if (cookie === "") return null;
  const userAgent = input.userAgent?.trim() ? input.userAgent.trim() : null;

  const cookieEnc = toBytes(encryptSecret(cookie));
  await prisma.pluginCredential.upsert({
    where: { pluginId_host: { pluginId: plugin.id, host } },
    create: { pluginId: plugin.id, host, cookieEnc, userAgent },
    update: { cookieEnc, userAgent },
  });

  // A source parked on NEEDS_CREDENTIAL now has something new to try; clear the
  // flag so the UI stops nagging before the next sync proves it.
  const cleared = await prisma.source.updateMany({
    where: { pluginId: plugin.id, lastErrorCode: "NEEDS_CREDENTIAL" },
    data: { lastErrorCode: null },
  });

  return {
    pluginId: plugin.id,
    pluginName: plugin.name,
    host,
    clearedSources: cleared.count,
  };
}

/** Does this plugin have any stored credential? (For the plugins list.) */
export async function hasPluginCredential(pluginId: string | null): Promise<boolean> {
  if (!pluginId) return false;
  const count = await prisma.pluginCredential.count({ where: { pluginId } });
  return count > 0;
}

/** Typed helper for the `configJson` merge the source service does. */
export type SourceConfigJson = Prisma.InputJsonValue;
