/**
 * Protocol v1 — the JSON-lines contract between the Kiri host and a plugin
 * subprocess.
 *
 * The host spawns `node <entry> <verb> …` and reads **stdout line by line**.
 * Every line is one JSON object with a `t` discriminator; anything the host
 * cannot parse becomes a `warn` log instead of failing the job. stderr is free
 * text and is tailed into `Job.outputLog`.
 *
 * Rules that make this work:
 *  - `hello` is always the first line (the host applies a 15 s deadline);
 *  - nothing but {@link emit} may ever write to stdout — {@link definePlugin}
 *    redirects `console.*` to `log` events for exactly this reason;
 *  - the `error` event wins over the process exit code.
 */

/** Version of this JSON-lines protocol. Bumped only on breaking changes. */
export const PROTOCOL_VERSION = 1 as const;

/** Longest `log`/`error` message written to stdout; longer text is truncated. */
export const MAX_MESSAGE_LENGTH = 8192;

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Closed set of machine-readable failure reasons. The host maps these to job
 * states, notifications and retry policy, so a plugin must never invent codes.
 */
export const ERROR_CODES = [
  "NEEDS_CREDENTIAL",
  "RATE_LIMITED",
  "NOT_FOUND",
  "UNSUPPORTED_URL",
  "BLOCKED",
  "NETWORK",
  "PARSE",
  "IO",
  "CANCELLED",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Chapter status vocabulary shared with manifest v2 and the host's ingest. */
export const CHAPTER_STATUSES = ["pending", "downloading", "completed", "failed"] as const;
export type ChapterStatus = (typeof CHAPTER_STATUSES)[number];

/**
 * Process exit codes. The host prefers a received `error` event, but a plugin
 * that dies without emitting one is still classified from its exit code.
 */
export const EXIT_CODES = {
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  NEEDS_CREDENTIAL: 3,
  NOT_FOUND: 4,
  RATE_LIMITED: 5,
  CANCELLED: 6,
  SDK_INCOMPATIBLE: 7,
} as const;
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** Well-known progress phases; any other string is allowed and passed through. */
export type ProgressPhase =
  "resolve" | "discover" | "cover" | "chapter" | "page" | "verify" | (string & {});

export interface HelloEvent {
  t: "hello";
  /** Protocol version the plugin speaks. */
  v: number;
  /** Descriptor id (`kiri-plugin.json`), falling back to the spec id. */
  plugin: string;
  /** Plugin version from the descriptor. */
  version: string;
  /** Version of `@kiri/source-sdk` the plugin is running against. */
  sdk: string;
}

export interface LogEvent {
  t: "log";
  level: LogLevel;
  msg: string;
}

export interface ProgressEvent {
  t: "progress";
  phase: ProgressPhase;
  current: number;
  total: number;
  chapterSlug?: string;
  bytes?: number;
}

export interface ChapterEvent {
  t: "chapter";
  slug: string;
  title: string;
  /** `null` when the source exposes no chapter number. */
  number: number | null;
  pageCount: number;
  status: ChapterStatus;
}

export interface ResultEvent<T = unknown> {
  t: "result";
  ok: true;
  data: T;
}

export interface ErrorEvent {
  t: "error";
  ok: false;
  code: ErrorCode;
  message: string;
  retryable: boolean;
  hint?: string;
}

export type PluginEvent =
  HelloEvent | LogEvent | ProgressEvent | ChapterEvent | ResultEvent | ErrorEvent;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

export function isChapterStatus(value: unknown): value is ChapterStatus {
  return typeof value === "string" && (CHAPTER_STATUSES as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* Emitting                                                                   */
/* -------------------------------------------------------------------------- */

function truncate(value: string): string {
  return value.length <= MAX_MESSAGE_LENGTH
    ? value
    : `${value.slice(0, MAX_MESSAGE_LENGTH)}… (truncated)`;
}

function verboseEnabled(): boolean {
  const raw = process.env["KIRI_VERBOSE"];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/** Serialise an event to its wire form (one line, trailing newline included). */
export function formatEventLine(event: PluginEvent): string {
  const shaped: PluginEvent =
    event.t === "log"
      ? { ...event, msg: truncate(event.msg) }
      : event.t === "error"
        ? { ...event, message: truncate(event.message) }
        : event;
  // JSON.stringify escapes newlines, so one event can never become two lines.
  return `${JSON.stringify(shaped)}\n`;
}

/**
 * Write one event to stdout. This is the **only** function allowed to touch
 * stdout in a plugin process. With `KIRI_VERBOSE` set the same event is
 * mirrored to stderr in a human-readable form for local debugging.
 */
export function emit(event: PluginEvent): void {
  const line = formatEventLine(event);
  try {
    process.stdout.write(line);
  } catch {
    // A closed pipe (host went away) must never crash the plugin mid-write.
  }
  if (verboseEnabled()) {
    try {
      process.stderr.write(`[kiri] ${line}`);
    } catch {
      /* ignore */
    }
  }
}

/** Convenience wrapper for `log` events. */
export function emitLog(level: LogLevel, msg: string): void {
  emit({ t: "log", level, msg });
}

/** Convenience wrapper for `progress` events. */
export function emitProgress(progress: Omit<ProgressEvent, "t">): void {
  emit({ t: "progress", ...progress });
}

/* -------------------------------------------------------------------------- */
/* Parsing (host side + tests)                                                */
/* -------------------------------------------------------------------------- */

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Parse one stdout line into an event. Returns `null` for blank lines, invalid
 * JSON, non-objects and unknown `t` values — the host turns those into `warn`
 * logs rather than failing the job.
 */
export function parseEventLine(line: string): PluginEvent | null {
  const trimmed = line.trim();
  if (trimmed === "" || !(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  switch (record["t"]) {
    case "hello": {
      const plugin = asString(record["plugin"]);
      if (plugin === undefined) return null;
      return {
        t: "hello",
        v: asFiniteNumber(record["v"]) ?? PROTOCOL_VERSION,
        plugin,
        version: asString(record["version"]) ?? "0.0.0",
        sdk: asString(record["sdk"]) ?? "0.0.0",
      };
    }
    case "log": {
      const msg = asString(record["msg"]);
      if (msg === undefined) return null;
      const level = record["level"];
      return { t: "log", level: isLogLevel(level) ? level : "info", msg };
    }
    case "progress": {
      const phase = asString(record["phase"]);
      if (phase === undefined) return null;
      const chapterSlug = asString(record["chapterSlug"]);
      const bytes = asFiniteNumber(record["bytes"]);
      return {
        t: "progress",
        phase,
        current: asFiniteNumber(record["current"]) ?? 0,
        total: asFiniteNumber(record["total"]) ?? 0,
        ...(chapterSlug === undefined ? {} : { chapterSlug }),
        ...(bytes === undefined ? {} : { bytes }),
      };
    }
    case "chapter": {
      const slug = asString(record["slug"]);
      if (slug === undefined) return null;
      const status = record["status"];
      const number = asFiniteNumber(record["number"]);
      return {
        t: "chapter",
        slug,
        title: asString(record["title"]) ?? slug,
        number: number === undefined ? null : number,
        pageCount: asFiniteNumber(record["pageCount"]) ?? 0,
        status: isChapterStatus(status) ? status : "pending",
      };
    }
    case "result":
      return { t: "result", ok: true, data: record["data"] };
    case "error": {
      const code = record["code"];
      const hint = asString(record["hint"]);
      return {
        t: "error",
        ok: false,
        code: isErrorCode(code) ? code : "INTERNAL",
        message: asString(record["message"]) ?? "Plugin failed",
        retryable: record["retryable"] === true,
        ...(hint === undefined ? {} : { hint }),
      };
    }
    default:
      return null;
  }
}

/** Split a chunk of stdout into events plus the lines that could not be parsed. */
export function parseEventLines(text: string): { events: PluginEvent[]; unparsed: string[] } {
  const events: PluginEvent[] = [];
  const unparsed: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const event = parseEventLine(line);
    if (event) events.push(event);
    else unparsed.push(line);
  }
  return { events, unparsed };
}
