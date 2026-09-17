/**
 * `PluginError` — the only error shape the host understands.
 *
 * Everything a plugin throws is funnelled through {@link PluginError.from} by
 * {@link definePlugin}, turned into one `error` event and mapped to an exit
 * code. Unknown errors degrade to `INTERNAL` so a crash is never silent.
 */
import { EXIT_CODES, type ErrorCode, type ErrorEvent } from "./protocol.js";

/**
 * Whether the host may retry the same job later without user intervention.
 * A plugin can override per error; these are the sensible defaults.
 */
const DEFAULT_RETRYABLE: Record<ErrorCode, boolean> = {
  NEEDS_CREDENTIAL: false,
  RATE_LIMITED: true,
  NOT_FOUND: false,
  UNSUPPORTED_URL: false,
  BLOCKED: false,
  NETWORK: true,
  PARSE: false,
  IO: true,
  CANCELLED: false,
  INTERNAL: false,
};

/** Exit code per error code (see the ABI table in `docs/PLUGINS.md`). */
const EXIT_CODE_BY_ERROR: Record<ErrorCode, number> = {
  NEEDS_CREDENTIAL: EXIT_CODES.NEEDS_CREDENTIAL,
  RATE_LIMITED: EXIT_CODES.RATE_LIMITED,
  BLOCKED: EXIT_CODES.RATE_LIMITED,
  NOT_FOUND: EXIT_CODES.NOT_FOUND,
  UNSUPPORTED_URL: EXIT_CODES.NOT_FOUND,
  CANCELLED: EXIT_CODES.CANCELLED,
  NETWORK: EXIT_CODES.INTERNAL,
  PARSE: EXIT_CODES.INTERNAL,
  IO: EXIT_CODES.INTERNAL,
  INTERNAL: EXIT_CODES.INTERNAL,
};

export interface PluginErrorOptions {
  /** Defaults to {@link DEFAULT_RETRYABLE} for the code. */
  retryable?: boolean;
  /** One actionable sentence shown to the user (“paste a cf_clearance cookie”). */
  hint?: string;
  cause?: unknown;
}

export class PluginError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, options: PluginErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PluginError";
    this.code = code;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[code];
    if (options.hint !== undefined) this.hint = options.hint;
  }

  /** Wire form of this error. */
  toEvent(): ErrorEvent {
    return {
      t: "error",
      ok: false,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
    };
  }

  get exitCode(): number {
    return toExitCode(this.code);
  }

  /**
   * Normalise anything thrown into a `PluginError`. Aborts become `CANCELLED`,
   * Node fs/network errno codes get their natural mapping, everything else is
   * `INTERNAL` (or `fallback`).
   */
  static from(value: unknown, fallback: ErrorCode = "INTERNAL"): PluginError {
    if (isPluginError(value)) return value;
    if (value instanceof Error) {
      if (value.name === "AbortError") {
        return new PluginError("CANCELLED", value.message || "Cancelled", { cause: value });
      }
      if (value.name === "TimeoutError") {
        return new PluginError("NETWORK", value.message || "Request timed out", { cause: value });
      }
      const errno = (value as NodeJS.ErrnoException).code;
      if (typeof errno === "string" && FS_ERRNO.has(errno)) {
        return new PluginError("IO", `${errno}: ${value.message}`, { cause: value });
      }
      if (typeof errno === "string" && NETWORK_ERRNO.has(errno)) {
        return new PluginError("NETWORK", `${errno}: ${value.message}`, { cause: value });
      }
      return new PluginError(fallback, value.message || String(value), { cause: value });
    }
    return new PluginError(fallback, typeof value === "string" ? value : String(value));
  }
}

const FS_ERRNO = new Set(["ENOENT", "EACCES", "EPERM", "EEXIST", "EISDIR", "ENOTDIR", "ENOSPC"]);
const NETWORK_ERRNO = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/**
 * `instanceof` plus a structural check, so an error crossing a package
 * boundary (two copies of the SDK on disk) is still recognised.
 */
export function isPluginError(value: unknown): value is PluginError {
  if (value instanceof PluginError) return true;
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PluginError>;
  return (
    candidate.name === "PluginError" &&
    typeof candidate.code === "string" &&
    typeof candidate.message === "string"
  );
}

/** Map an error code to the process exit code the host expects. */
export function toExitCode(code: ErrorCode): number {
  return EXIT_CODE_BY_ERROR[code] ?? EXIT_CODES.INTERNAL;
}

/** Default `retryable` for a code, exported for hosts that rebuild errors. */
export function isRetryableByDefault(code: ErrorCode): boolean {
  return DEFAULT_RETRYABLE[code];
}

/* -------------------------------------------------------------------------- */
/* Helpers — the shorthand plugins actually use                               */
/* -------------------------------------------------------------------------- */

const make =
  (code: ErrorCode, defaultMessage: string) =>
  (message: string = defaultMessage, options: PluginErrorOptions = {}): PluginError =>
    new PluginError(code, message, options);

/** The site wants a cookie/User-Agent the host has not supplied (or it expired). */
export const needsCredential = make(
  "NEEDS_CREDENTIAL",
  "The site requires a valid cookie and User-Agent",
);
/** The site is throttling us and backing off did not help. */
export const rateLimited = make("RATE_LIMITED", "Rate limited by the site");
/** The series/chapter/page does not exist (404, deleted, licensed away). */
export const notFound = make("NOT_FOUND", "Not found");
/** This plugin does not handle the given URL. */
export const unsupportedUrl = make("UNSUPPORTED_URL", "Unsupported URL");
/** WAF/geo/ban wall that is not a credential problem. */
export const blocked = make("BLOCKED", "Blocked by the site");
/** DNS, TLS, connection reset, timeout, 5xx after retries. */
export const networkError = make("NETWORK", "Network error");
/** The page/JSON did not look the way the plugin expects (site redesign). */
export const parseError = make("PARSE", "Could not parse the site response");
/** Local filesystem failure. */
export const ioError = make("IO", "Filesystem error");
/** SIGTERM/SIGINT from the host, or a caller-provided AbortSignal. */
export const cancelled = make("CANCELLED", "Cancelled");
/** Bug in the plugin or the SDK. */
export const internalError = make("INTERNAL", "Internal plugin error");
