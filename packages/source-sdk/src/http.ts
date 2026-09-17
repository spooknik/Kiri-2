/**
 * `HttpClient` — the polite HTTP layer every plugin shares.
 *
 * Generalised from the V1 rippers, which each re-implemented retry/backoff by
 * hand. It adds a token bucket, `Retry-After` handling, per-request timeouts,
 * cookie/User-Agent injection and a *detection-only* Cloudflare check.
 *
 * Neutral by policy: there is no TLS-fingerprint spoofing, no stealth patching
 * and no challenge solving here. A site that needs those must be handled by a
 * plugin that vendors its own tooling (see `docs/PLUGINS.md`).
 */
import { Buffer } from "node:buffer";

import { PluginError } from "./errors.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** `BodyInit`/`RequestRedirect` are DOM-only names; derive them from `RequestInit`. */
type RequestBody = NonNullable<RequestInit["body"]>;
type RedirectMode = NonNullable<RequestInit["redirect"]>;

export interface HttpClientOptions {
  /** Retries *after* the first attempt. Default 3. */
  retries?: number;
  /** Per-request timeout in ms. Default 30 000. */
  timeoutMs?: number;
  /** Fixed delay before every attempt (politeness). Default 0. */
  delayMs?: number;
  /** Random extra delay, 0…jitterMs, before every attempt. Default 250. */
  jitterMs?: number;
  /** Exponential backoff base: attempt n waits `backoffMs * 2^(n-1)` + jitter. */
  backoffMs?: number;
  /** Upper bound for a single backoff sleep. Default 30 000. */
  maxBackoffMs?: number;
  /** Token bucket rate. 0 / Infinity disables the limit. Default 5. */
  requestsPerSecond?: number;
  /** Bucket size; defaults to `ceil(requestsPerSecond)` (min 1). */
  burst?: number;
  /** Longest `Retry-After` the client will honour before giving up. Default 60 000. */
  maxRetryAfterMs?: number;
  userAgent?: string;
  /** Raw `Cookie:` header value. Falls back to `KIRI_COOKIE`. */
  cookie?: string;
  /** Extra default headers merged into every request. */
  headers?: Record<string, string>;
  acceptLanguage?: string;
  /** Parent signal: aborting it makes every in-flight call throw `CANCELLED`. */
  signal?: AbortSignal;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Called before each retry sleep — useful for `log`/`progress` events. */
  onRetry?: (info: RetryInfo) => void;
  /** Environment used for cookie/User-Agent fallback. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export interface RetryInfo {
  url: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  status?: number;
  reason: string;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: RequestBody;
  /** Sent as the `Referer` header (many CDNs require it for images). */
  referer?: string;
  /** Per-call override of the client default. */
  timeoutMs?: number;
  retries?: number;
  cookie?: string;
  accept?: string;
  redirect?: RedirectMode;
  /** Extra abort source for this call only. */
  signal?: AbortSignal;
}

export interface FetchBufferResult {
  buffer: Buffer;
  contentType: string;
  /** URL after redirects — worth storing in the manifest. */
  finalUrl: string;
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DEFAULT_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
const DEFAULT_ACCEPT_LANGUAGE = "en-US,en;q=0.9";
const IMAGE_ACCEPT = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";

/** Statuses worth another attempt (V1's list). */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
/** How much of an error body is read for the Cloudflare heuristic. */
const CHALLENGE_BODY_PEEK = 8192;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PluginError("CANCELLED", "Cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new PluginError("CANCELLED", "Cancelled"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function randomInt(maxInclusive: number): number {
  if (maxInclusive <= 0) return 0;
  return Math.floor(Math.random() * (maxInclusive + 1));
}

/**
 * Cloudflare/WAF interstitial detection. **Detection only** — the SDK never
 * tries to solve or bypass a challenge; it tells the host to ask the user for
 * a `cf_clearance` cookie (see `NEEDS_CREDENTIAL`).
 */
export function looksLikeChallenge(headers: Headers, body: string): boolean {
  if (headers.get("cf-mitigated")) return true;
  const lower = body.toLowerCase();
  if (
    lower.includes("<title>just a moment") ||
    lower.includes("just a moment...") ||
    lower.includes("attention required! | cloudflare") ||
    lower.includes("cf-browser-verification") ||
    lower.includes("/cdn-cgi/challenge-platform") ||
    lower.includes("checking your browser before accessing")
  ) {
    return true;
  }
  const server = headers.get("server")?.toLowerCase() ?? "";
  return server.includes("cloudflare") && lower.includes("enable javascript and cookies");
}

/** Merge a parent signal with a per-request one and a timeout. */
function combineSignals(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  const anyOf = (AbortSignal as unknown as { any?: (list: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyOf === "function") return anyOf(present);
  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export class HttpClient {
  readonly retries: number;
  readonly timeoutMs: number;
  readonly delayMs: number;
  readonly jitterMs: number;
  readonly backoffMs: number;
  readonly maxBackoffMs: number;
  readonly maxRetryAfterMs: number;
  readonly requestsPerSecond: number;
  readonly userAgent: string;
  readonly cookie: string | undefined;
  readonly defaultHeaders: Record<string, string>;

  readonly #signal: AbortSignal | undefined;
  readonly #fetch: FetchLike;
  readonly #onRetry: ((info: RetryInfo) => void) | undefined;
  readonly #burst: number;
  #tokens: number;
  #lastRefill: number;
  #bucketQueue: Promise<void> = Promise.resolve();

  constructor(options: HttpClientOptions = {}) {
    const env = options.env ?? process.env;
    this.retries = Math.max(0, options.retries ?? 3);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.delayMs = Math.max(0, options.delayMs ?? 0);
    this.jitterMs = Math.max(0, options.jitterMs ?? 250);
    this.backoffMs = Math.max(1, options.backoffMs ?? 500);
    this.maxBackoffMs = Math.max(this.backoffMs, options.maxBackoffMs ?? 30_000);
    this.maxRetryAfterMs = Math.max(0, options.maxRetryAfterMs ?? 60_000);
    this.requestsPerSecond = Math.max(0, options.requestsPerSecond ?? 5);
    this.userAgent = options.userAgent ?? env["KIRI_USER_AGENT"] ?? DEFAULT_USER_AGENT;
    this.cookie = options.cookie ?? env["KIRI_COOKIE"] ?? undefined;
    this.defaultHeaders = {
      Accept: DEFAULT_ACCEPT,
      "Accept-Language": options.acceptLanguage ?? DEFAULT_ACCEPT_LANGUAGE,
      ...(options.headers ?? {}),
    };
    this.#signal = options.signal;
    this.#fetch = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.#onRetry = options.onRetry;
    this.#burst = Math.max(1, Math.ceil(options.burst ?? this.requestsPerSecond ?? 1));
    this.#tokens = this.#burst;
    this.#lastRefill = Date.now();
  }

  /** A copy with some options changed (per-site rate limits, extra headers). */
  withOptions(overrides: HttpClientOptions): HttpClient {
    return new HttpClient({
      retries: this.retries,
      timeoutMs: this.timeoutMs,
      delayMs: this.delayMs,
      jitterMs: this.jitterMs,
      backoffMs: this.backoffMs,
      maxBackoffMs: this.maxBackoffMs,
      maxRetryAfterMs: this.maxRetryAfterMs,
      requestsPerSecond: this.requestsPerSecond,
      userAgent: this.userAgent,
      ...(this.cookie === undefined ? {} : { cookie: this.cookie }),
      headers: this.defaultHeaders,
      ...(this.#signal === undefined ? {} : { signal: this.#signal }),
      fetchImpl: this.#fetch,
      ...(this.#onRetry === undefined ? {} : { onRetry: this.#onRetry }),
      ...overrides,
    });
  }

  async fetchText(url: string, options: RequestOptions = {}): Promise<string> {
    const response = await this.fetchWithRetry(url, options);
    try {
      return await response.text();
    } catch (cause) {
      throw PluginError.from(cause, "NETWORK");
    }
  }

  async fetchJson<T = unknown>(url: string, options: RequestOptions = {}): Promise<T> {
    const text = await this.fetchText(url, {
      ...options,
      headers: { Accept: "application/json", ...(options.headers ?? {}) },
    });
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new PluginError("PARSE", `Invalid JSON response for ${url}`, { cause });
    }
  }

  async fetchBuffer(url: string, options: RequestOptions = {}): Promise<FetchBufferResult> {
    const response = await this.fetchWithRetry(url, {
      ...options,
      headers: { Accept: IMAGE_ACCEPT, ...(options.headers ?? {}) },
    });
    let buffer: Buffer;
    try {
      buffer = Buffer.from(await response.arrayBuffer());
    } catch (cause) {
      throw PluginError.from(cause, "NETWORK");
    }
    return {
      buffer,
      contentType: response.headers.get("content-type") ?? "",
      finalUrl: response.url || url,
    };
  }

  /**
   * The one place that talks to the network. Returns an `ok` `Response` whose
   * body has not been consumed; every failure path throws a `PluginError`.
   */
  async fetchWithRetry(url: string, options: RequestOptions = {}): Promise<Response> {
    const maxAttempts = Math.max(0, options.retries ?? this.retries) + 1;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    let lastError: PluginError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.#throwIfCancelled();
      await this.#takeToken();
      await sleep(this.delayMs + randomInt(this.jitterMs), this.#signal);
      this.#throwIfCancelled();

      const timeoutSignal =
        Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
      const signal = combineSignals([this.#signal, options.signal, timeoutSignal]);

      const headers: Record<string, string> = {
        ...this.defaultHeaders,
        "User-Agent": this.userAgent,
      };
      if (options.accept) headers["Accept"] = options.accept;
      const cookie = options.cookie ?? this.cookie;
      if (cookie) headers["Cookie"] = cookie;
      if (options.referer) headers["Referer"] = options.referer;
      Object.assign(headers, options.headers ?? {});

      const init: RequestInit = {
        method: options.method ?? "GET",
        headers,
        redirect: options.redirect ?? "follow",
      };
      if (options.body !== undefined) init.body = options.body;
      if (signal) init.signal = signal;

      let response: Response;
      try {
        response = await this.#fetch(url, init);
      } catch (cause) {
        this.#throwIfCancelled();
        if (options.signal?.aborted) throw new PluginError("CANCELLED", "Cancelled");
        const timedOut = timeoutSignal?.aborted === true;
        lastError = timedOut
          ? new PluginError("NETWORK", `Request timed out after ${timeoutMs} ms: ${url}`, {
              retryable: true,
              cause,
            })
          : PluginError.from(cause, "NETWORK");
        if (attempt === maxAttempts) throw lastError;
        await this.#backoff(attempt, url, lastError.message);
        continue;
      }

      if (response.ok) return response;

      const status = response.status;

      if (status === 404 || status === 410) {
        await discardBody(response);
        throw new PluginError("NOT_FOUND", `HTTP ${status} for ${url}`, { retryable: false });
      }

      if (status === 401) {
        await discardBody(response);
        throw new PluginError("NEEDS_CREDENTIAL", `HTTP 401 for ${url}`, {
          hint: "The site needs a signed-in session: capture a Cookie header and User-Agent for it.",
        });
      }

      if (status === 403 || status === 503) {
        const body = await peekBody(response);
        if (looksLikeChallenge(response.headers, body)) {
          throw new PluginError(
            "NEEDS_CREDENTIAL",
            `The site answered ${status} with a bot challenge for ${url}`,
            {
              hint: "Open the site in a browser, then paste its Cookie header (cf_clearance) and the exact User-Agent into Kiri, or use the Kiri Cookie Bridge extension.",
            },
          );
        }
        if (status === 403) {
          throw new PluginError("BLOCKED", `HTTP 403 for ${url}`, { retryable: false });
        }
        lastError = new PluginError("NETWORK", `HTTP 503 for ${url}`, { retryable: true });
      } else if (status === 429) {
        lastError = new PluginError("RATE_LIMITED", `HTTP 429 for ${url}`, { retryable: true });
      } else if (RETRYABLE_STATUS.has(status)) {
        lastError = new PluginError("NETWORK", `HTTP ${status} for ${url}`, { retryable: true });
      } else {
        await discardBody(response);
        throw new PluginError("NETWORK", `HTTP ${status} for ${url}`, { retryable: false });
      }

      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      if (status !== 403 && status !== 503) await discardBody(response);

      if (attempt === maxAttempts) throw lastError;
      if (retryAfterMs !== null && retryAfterMs > this.maxRetryAfterMs) throw lastError;

      const delay =
        retryAfterMs ?? Math.min(this.maxBackoffMs, this.backoffMs * 2 ** (attempt - 1));
      this.#onRetry?.({
        url,
        attempt,
        maxAttempts,
        delayMs: delay,
        status,
        reason: lastError.message,
      });
      await sleep(delay + randomInt(this.jitterMs), this.#signal);
    }

    throw lastError ?? new PluginError("NETWORK", `Request failed: ${url}`);
  }

  #throwIfCancelled(): void {
    if (this.#signal?.aborted) throw new PluginError("CANCELLED", "Cancelled");
  }

  async #backoff(attempt: number, url: string, reason: string): Promise<void> {
    const delay = Math.min(this.maxBackoffMs, this.backoffMs * 2 ** (attempt - 1));
    this.#onRetry?.({ url, attempt, maxAttempts: this.retries + 1, delayMs: delay, reason });
    await sleep(delay + randomInt(this.jitterMs), this.#signal);
  }

  /** Token bucket, serialised so parallel callers cannot drain it at once. */
  #takeToken(): Promise<void> {
    if (!(this.requestsPerSecond > 0) || !Number.isFinite(this.requestsPerSecond)) {
      return Promise.resolve();
    }
    const next = this.#bucketQueue.then(() => this.#reserveToken());
    this.#bucketQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #reserveToken(): Promise<void> {
    this.#refill();
    if (this.#tokens < 1) {
      const waitMs = Math.ceil(((1 - this.#tokens) / this.requestsPerSecond) * 1000);
      await sleep(waitMs, this.#signal);
      this.#refill();
    }
    this.#tokens = Math.max(0, this.#tokens - 1);
  }

  #refill(): void {
    const now = Date.now();
    const elapsedSeconds = Math.max(0, now - this.#lastRefill) / 1000;
    this.#lastRefill = now;
    this.#tokens = Math.min(this.#burst, this.#tokens + elapsedSeconds * this.requestsPerSecond);
  }
}

/** `Retry-After` in seconds or as an HTTP date; `null` when absent/invalid. */
export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number.parseFloat(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

async function peekBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, CHALLENGE_BODY_PEEK);
  } catch {
    return "";
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* already consumed or closed */
  }
}
