/**
 * Outbound HTTP for URLs that came from a user or a plugin descriptor.
 *
 * Kiri fetches remote covers and plugin archives on the server, which means a
 * URL in a request body is a request *this host* makes: without a check that is
 * a server-side request forgery primitive (`http://169.254.169.254/…` for cloud
 * metadata, `http://127.0.0.1:5432/` for whatever else runs on the box). Two
 * rules close that:
 *
 *   - {@link assertPublicHttpUrl} — http(s) only, and the host must not be (or
 *     resolve to) a loopback, link-local, private, CGNAT, multicast or reserved
 *     address, in IPv4, IPv6 or IPv4-mapped/translated IPv6 form.
 *   - {@link safeFetch} — `redirect: "manual"`, so **every hop is re-checked**
 *     (a public URL that 302s to 127.0.0.1 is the usual bypass), with a hop
 *     limit, a timeout and an optional response byte cap.
 *
 * Known limit: DNS is resolved once for the check and again by the fetch, so a
 * rebinding attacker with a sub-second TTL can still win the race. Blocking
 * that needs pinned-address connections; the ranges above are the 99 % fix.
 *
 * **Test escape hatch:** `KIRI_ALLOW_PRIVATE_FETCH=1` skips the address checks
 * (never the scheme check) so tests can point fixtures at localhost or at a
 * hostname that does not resolve. It is ignored when `NODE_ENV=production`.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Hops a redirect chain may take before we give up. */
export const MAX_REDIRECTS = 3;
/** Default whole-request deadline; callers with slower work pass their own. */
const DEFAULT_TIMEOUT_MS = 30_000;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type SafeFetchErrorCode =
  "INVALID_URL" | "SCHEME" | "BLOCKED_HOST" | "DNS" | "TOO_MANY_REDIRECTS" | "TOO_LARGE";

/** Every refusal from this module; carries a user-presentable message. */
export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;

  constructor(code: SafeFetchErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SafeFetchError";
    this.code = code;
  }
}

/** The escape hatch above. Read per call so tests can toggle it. */
function allowPrivateFetch(): boolean {
  return process.env.NODE_ENV !== "production" && process.env["KIRI_ALLOW_PRIVATE_FETCH"] === "1";
}

/* -------------------------------------------------------------------------- */
/* Address classification                                                     */
/* -------------------------------------------------------------------------- */

function ipv4ToBytes(value: string): Uint8Array | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let index = 0; index < 4; index += 1) {
    const part = parts[index] ?? "";
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    bytes[index] = octet;
  }
  return bytes;
}

function splitGroups(part: string | undefined): string[] {
  return part === undefined || part === "" ? [] : part.split(":");
}

function groupsToBytes(groups: string[]): number[] | null {
  const out: number[] = [];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index] ?? "";
    if (group.includes(".")) {
      // A dotted quad is only legal as the last group, where it is four bytes.
      if (index !== groups.length - 1) return null;
      const embedded = ipv4ToBytes(group);
      if (!embedded) return null;
      out.push(...embedded);
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    out.push((value >> 8) & 0xff, value & 0xff);
  }
  return out;
}

function ipv6ToBytes(value: string): Uint8Array | null {
  const zoneAt = value.indexOf("%");
  const text = zoneAt === -1 ? value : value.slice(0, zoneAt);
  const halves = text.split("::");
  if (halves.length > 2) return null;

  const head = groupsToBytes(splitGroups(halves[0]));
  if (!head) return null;
  if (halves.length === 1) return head.length === 16 ? Uint8Array.from(head) : null;

  const tail = groupsToBytes(splitGroups(halves[1]));
  if (!tail) return null;
  const gap = 16 - head.length - tail.length;
  if (gap < 0) return null;
  return Uint8Array.from([...head, ...new Array<number>(gap).fill(0), ...tail]);
}

/** RFC 1918 and friends: everything that is not a routable public host. */
function isBlockedIpv4(bytes: Uint8Array): boolean {
  const a = bytes[0] ?? 0;
  const b = bytes[1] ?? 0;
  const c = bytes[2] ?? 0;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // multicast, reserved and 255.255.255.255
  return false;
}

/** The v4 address inside a mapped/translated v6 address, when there is one. */
function embeddedIpv4(bytes: Uint8Array): Uint8Array | null {
  const leadingZeros = bytes.slice(0, 10).every((byte) => byte === 0);
  const tail = bytes.slice(12, 16);
  if (leadingZeros && bytes[10] === 0xff && bytes[11] === 0xff) return tail; // ::ffff:a.b.c.d
  if (leadingZeros && bytes[10] === 0 && bytes[11] === 0) {
    // ::a.b.c.d (deprecated IPv4-compatible). :: and ::1 are handled as v6.
    const empty = tail[0] === 0 && tail[1] === 0 && tail[2] === 0;
    return empty ? null : tail;
  }
  // 64:ff9b::/96 (NAT64) and 2002::/16 (6to4) both carry a v4 address.
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0)
  ) {
    return tail;
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return bytes.slice(2, 6);
  return null;
}

function isBlockedIpv6(bytes: Uint8Array): boolean {
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  const allButLastZero = bytes.slice(0, 15).every((byte) => byte === 0);
  if (allButLastZero && ((bytes[15] ?? 0) === 0 || (bytes[15] ?? 0) === 1)) return true; // :: and ::1
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (first === 0xfe && (second & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (first === 0xff) return true; // ff00::/8 multicast
  return false;
}

/**
 * Is this literal address one we refuse to connect to? Anything that is not a
 * parseable IP is refused too — callers only ask about literals.
 */
export function isBlockedIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const bytes = ipv4ToBytes(address);
    return bytes === null || isBlockedIpv4(bytes);
  }
  if (family === 6) {
    const bytes = ipv6ToBytes(address);
    if (bytes === null) return true;
    const embedded = embeddedIpv4(bytes);
    return embedded === null ? isBlockedIpv6(bytes) : isBlockedIpv4(embedded);
  }
  return true;
}

/** `[::1]` in a URL hostname is the literal `::1`; plain hosts pass through. */
function ipLiteralOf(hostname: string): string | null {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return isIP(bare) === 0 ? null : bare;
}

function blockedHost(hostname: string): SafeFetchError {
  return new SafeFetchError(
    "BLOCKED_HOST",
    `${hostname} is not a public address, so Kiri will not fetch it`,
  );
}

/* -------------------------------------------------------------------------- */
/* Public surface                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Throw unless `url` is an http(s) URL whose host is public — including every
 * address it resolves to. Returns the parsed URL so callers can reuse it.
 */
export async function assertPublicHttpUrl(url: string | URL): Promise<URL> {
  let parsed: URL;
  try {
    parsed = url instanceof URL ? url : new URL(url);
  } catch {
    throw new SafeFetchError("INVALID_URL", "That is not a valid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SafeFetchError("SCHEME", "Only http(s) URLs are supported");
  }
  const hostname = parsed.hostname;
  if (hostname === "") {
    throw new SafeFetchError("INVALID_URL", "That URL has no host");
  }
  if (allowPrivateFetch()) return parsed;

  const literal = ipLiteralOf(hostname);
  if (literal !== null) {
    if (isBlockedIpAddress(literal)) throw blockedHost(hostname);
    return parsed;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch (cause) {
    throw new SafeFetchError("DNS", `Could not resolve ${hostname}`, { cause });
  }
  if (addresses.length === 0) {
    throw new SafeFetchError("DNS", `Could not resolve ${hostname}`);
  }
  for (const { address } of addresses) {
    if (isBlockedIpAddress(address)) throw blockedHost(hostname);
  }
  return parsed;
}

export interface SafeFetchInit extends Omit<RequestInit, "redirect"> {
  /** Refuse a response larger than this, by header and while streaming. */
  maxBytes?: number;
  /** Whole-request deadline; defaults to 30 s. */
  timeoutMs?: number;
  /** Redirect hops allowed; defaults to {@link MAX_REDIRECTS}. */
  maxRedirects?: number;
}

/** Wrap the body so it can never deliver more than `maxBytes`. */
function withByteCap(response: Response, maxBytes: number | undefined): Response {
  if (maxBytes === undefined) return response;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new SafeFetchError("TOO_LARGE", `The response is larger than ${maxBytes} bytes`);
  }
  const body = response.body;
  if (!body) return response;

  let seen = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        controller.error(
          new SafeFetchError("TOO_LARGE", `The response is larger than ${maxBytes} bytes`),
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return new Response(body.pipeThrough(limiter), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * `fetch` for user-supplied URLs: the target and every redirect target are
 * checked with {@link assertPublicHttpUrl} before a connection is made.
 *
 * Non-2xx responses are returned as-is — status handling belongs to the caller;
 * only the checks above throw ({@link SafeFetchError}).
 */
export async function safeFetch(url: string | URL, init: SafeFetchInit = {}): Promise<Response> {
  const {
    maxBytes,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = MAX_REDIRECTS,
    signal,
    ...rest
  } = init;

  let target = await assertPublicHttpUrl(url);
  const deadline = AbortSignal.timeout(timeoutMs);
  const composed = signal ? AbortSignal.any([signal, deadline]) : deadline;

  for (let hop = 0; ; hop += 1) {
    const response = await fetch(target, { ...rest, redirect: "manual", signal: composed });
    if (!REDIRECT_STATUSES.has(response.status)) return withByteCap(response, maxBytes);

    const location = response.headers.get("location");
    if (location === null || location.trim() === "") return withByteCap(response, maxBytes);
    if (hop >= maxRedirects) {
      await response.body?.cancel().catch(() => undefined);
      throw new SafeFetchError(
        "TOO_MANY_REDIRECTS",
        `That URL redirected more than ${maxRedirects} times`,
      );
    }

    await response.body?.cancel().catch(() => undefined);
    let next: URL;
    try {
      next = new URL(location, target);
    } catch {
      throw new SafeFetchError("INVALID_URL", "That URL redirected to an invalid address");
    }
    target = await assertPublicHttpUrl(next);
  }
}
