/**
 * Running a plugin subprocess: protocol v1 in, a classified outcome out.
 *
 * The protocol types are re-declared here rather than imported from
 * `@kiri/source-sdk`: the app never has the SDK in its own module graph (the
 * image ships it as a plain tree for *plugins* to link), and this is the host
 * half of a wire format anyway — it must keep parsing old plugins even if the
 * SDK moves on. `packages/source-sdk/src/protocol.ts` is the other half.
 *
 * What this module owns:
 *   - argv:   `node [sandbox flags] <entry> <verb> [args…]`;
 *   - env:    an **allowlist**, never `process.env` — see {@link buildEnv};
 *   - stdout: JSON-lines, read with a real line reader (a 4 kB write can split
 *             a line anywhere), unparseable lines surfaced as warnings;
 *   - stderr: free text, tailed for the job log;
 *   - time:   a `hello` deadline, an idle timeout that any event resets, and a
 *             hard total;
 *   - death:  SIGTERM to the process *group* (Chromium trees are why), 10 s
 *             grace, SIGKILL. On Windows there are no process groups, so
 *             `taskkill /T /F` takes the tree down immediately.
 *
 * `error` events win over exit codes, exactly as `docs/PLUGINS.md` promises.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable as NodeReadable } from "node:stream";
import path from "node:path";
import {
  describeAccessDenial,
  isAccessDenied,
  sandboxArgs,
  sandboxMode,
  type SandboxDescriptor,
  type SandboxMode,
} from "@/lib/plugins/sandbox";

/* -------------------------------------------------------------------------- */
/* Protocol v1                                                                */
/* -------------------------------------------------------------------------- */

export const PROTOCOL_VERSION = 1;

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

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
export type PluginErrorCode = (typeof ERROR_CODES)[number];

/** Exit codes a plugin may use when it dies without emitting an `error`. */
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

/** Codes the scheduler may retry on its own. */
export const RETRYABLE_CODES: readonly PluginErrorCode[] = ["RATE_LIMITED", "NETWORK", "IO"];

export interface HelloEvent {
  t: "hello";
  v: number;
  plugin: string;
  version: string;
  sdk: string;
}
export interface LogEvent {
  t: "log";
  level: LogLevel;
  msg: string;
}
export interface ProgressEvent {
  t: "progress";
  phase: string;
  current: number;
  total: number;
  chapterSlug?: string;
  bytes?: number;
}
export interface ChapterEvent {
  t: "chapter";
  slug: string;
  title: string;
  number: number | null;
  pageCount: number;
  status: "pending" | "downloading" | "completed" | "failed";
}
export interface ResultEvent {
  t: "result";
  ok: true;
  data: unknown;
}
export interface ErrorEvent {
  t: "error";
  ok: false;
  code: PluginErrorCode;
  message: string;
  retryable: boolean;
  hint?: string;
}

export type PluginEvent =
  HelloEvent | LogEvent | ProgressEvent | ChapterEvent | ResultEvent | ErrorEvent;

/** A plugin failure in the shape the job layer stores and notifies on. */
export interface PluginFailure {
  code: PluginErrorCode;
  message: string;
  retryable: boolean;
  hint?: string;
}

function isErrorCode(value: unknown): value is PluginErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Parse one stdout line. `null` means "not protocol" — blank lines, plain
 * `console.log` output from a plugin that bypassed the SDK, a stray banner —
 * and the caller turns those into warnings rather than failing the job.
 */
export function parseEventLine(line: string): PluginEvent | null {
  const trimmed = line.trim();
  if (trimmed === "" || !trimmed.startsWith("{")) return null;

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
        v: asNumber(record["v"]) ?? PROTOCOL_VERSION,
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
      const bytes = asNumber(record["bytes"]);
      return {
        t: "progress",
        phase,
        current: asNumber(record["current"]) ?? 0,
        total: asNumber(record["total"]) ?? 0,
        ...(chapterSlug === undefined ? {} : { chapterSlug }),
        ...(bytes === undefined ? {} : { bytes }),
      };
    }
    case "chapter": {
      const slug = asString(record["slug"]);
      if (slug === undefined) return null;
      const status = record["status"];
      const number = asNumber(record["number"]);
      return {
        t: "chapter",
        slug,
        title: asString(record["title"]) ?? slug,
        number: number === undefined ? null : number,
        pageCount: asNumber(record["pageCount"]) ?? 0,
        status:
          status === "downloading" || status === "completed" || status === "failed"
            ? status
            : "pending",
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
        message: asString(record["message"]) ?? "The plugin failed",
        retryable: record["retryable"] === true,
        ...(hint === undefined ? {} : { hint }),
      };
    }
    default:
      return null;
  }
}

/** Split a blob of stdout into events plus the lines that were not protocol. */
export function linesToEvents(text: string): { events: PluginEvent[]; unparsed: string[] } {
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

/**
 * Classify a plugin that died without emitting an `error` event. `null` for a
 * clean exit; every other code maps onto the closed error set.
 */
export function failureFromExitCode(
  code: number | null,
  signal: NodeJS.Signals | null,
): PluginFailure | null {
  if (code === EXIT_CODES.OK) return null;
  if (code === null) {
    return {
      code: "CANCELLED",
      message: `The plugin was killed by ${signal ?? "a signal"}`,
      retryable: false,
    };
  }
  switch (code) {
    case EXIT_CODES.USAGE:
      return {
        code: "INTERNAL",
        message: "The plugin rejected the command line Kiri gave it (exit 2)",
        retryable: false,
      };
    case EXIT_CODES.NEEDS_CREDENTIAL:
      return {
        code: "NEEDS_CREDENTIAL",
        message: "The site asked for a cookie or the stored one has expired",
        retryable: false,
      };
    case EXIT_CODES.NOT_FOUND:
      return {
        code: "NOT_FOUND",
        message: "The plugin could not find that series",
        retryable: false,
      };
    case EXIT_CODES.RATE_LIMITED:
      return {
        code: "RATE_LIMITED",
        message: "The site rate-limited or blocked the plugin",
        retryable: true,
      };
    case EXIT_CODES.CANCELLED:
      return { code: "CANCELLED", message: "The plugin was cancelled", retryable: false };
    case EXIT_CODES.SDK_INCOMPATIBLE:
      return {
        code: "INTERNAL",
        message: "The plugin needs a different @kiri/source-sdk version than this Kiri ships",
        retryable: false,
      };
    default:
      return { code: "INTERNAL", message: `The plugin exited with code ${code}`, retryable: false };
  }
}

/* -------------------------------------------------------------------------- */
/* Environment                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Variables copied from the host environment, by name. Everything else is
 * dropped — `DATABASE_URL`, `APP_SECRET`, `NODE_OPTIONS` (which could inject a
 * `--require` right past the sandbox) and the rest never reach a plugin.
 */
export const ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  // Windows needs these to start a process at all.
  "SYSTEMROOT",
  "windir",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "NUMBER_OF_PROCESSORS",
];

/** Prefixes copied verbatim (Playwright's browser cache and executable path). */
export const ENV_ALLOWED_PREFIXES: readonly string[] = ["PLAYWRIGHT_"];

/** Names that must never be forwarded, whatever else happens. */
export const ENV_DENYLIST: readonly string[] = [
  "DATABASE_URL",
  "APP_SECRET",
  "APP_SECRET_PREVIOUS",
  "NODE_OPTIONS",
];

/**
 * Build the child environment: allowlist, then temp redirected at the run's
 * own scratch directory, then the caller's `KIRI_*` values.
 */
export function buildEnv(
  extra: Readonly<Record<string, string | undefined>>,
  tmpDir: string,
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  const denied = new Set(ENV_DENYLIST.map((name) => name.toLowerCase()));

  for (const name of ENV_ALLOWLIST) {
    const value = source[name];
    if (typeof value === "string" && value !== "") env[name] = value;
  }
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== "string" || value === "") continue;
    if (denied.has(name.toLowerCase())) continue;
    if (ENV_ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix))) env[name] = value;
  }

  const scratch = path.resolve(tmpDir);
  env["TMPDIR"] = scratch;
  env["TEMP"] = scratch;
  env["TMP"] = scratch;

  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    if (denied.has(name.toLowerCase())) continue;
    env[name] = value;
  }
  return env;
}

/* -------------------------------------------------------------------------- */
/* Spawning                                                                   */
/* -------------------------------------------------------------------------- */

/** Default deadlines; `docs/PLUGINS.md` documents the first two. */
export const HELLO_TIMEOUT_MS = 15_000;
export const IDLE_TIMEOUT_MS = 300_000;
/** How long a SIGTERMed process group has before SIGKILL. */
export const KILL_GRACE_MS = 10_000;
/** stderr kept for the job log. */
const STDERR_TAIL_BYTES = 32 * 1024;
/** Bound on retained events so a chatty plugin cannot grow the heap. */
const MAX_RETAINED_EVENTS = 5000;
/** A single stdout line longer than this is treated as junk, not protocol. */
const MAX_LINE_BYTES = 1024 * 1024;

/** Everything the runner needs to start one plugin. */
export interface PluginRunTarget {
  id: string;
  /** Directory holding `kiri-plugin.json`. */
  dir: string;
  /** Absolute entry file. */
  entryPath: string;
  descriptor: SandboxDescriptor;
}

export interface SpawnPluginOptions {
  plugin: PluginRunTarget;
  verb: string;
  args?: readonly string[];
  /** `KIRI_*` values merged into the allowlisted environment. */
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  signal?: AbortSignal;
  /** Series directory, when the verb writes one. */
  outputDir?: string | null;
  /** Per-run scratch directory; becomes TMPDIR and an allowed write path. */
  tmpDir: string;
  /** Linked SDK directory, allowed for reading by the sandbox. */
  sdkDir: string;
  timeouts?: { hello?: number; idle?: number; total?: number };
  sandbox?: SandboxMode;
  onEvent?: (event: PluginEvent) => void;
  onStderr?: (line: string) => void;
  onUnparsed?: (line: string) => void;
}

export type KillReason = "cancel" | "hello-timeout" | "idle-timeout" | "total-timeout";

/** stdin is closed, stdout and stderr are pipes — the shape `spawn` returns here. */
type PluginChild = ChildProcessByStdio<null, NodeReadable, NodeReadable>;

export interface SpawnPluginResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  hello: HelloEvent | null;
  events: PluginEvent[];
  /** `data` of the `result` event, when there was one. */
  result: unknown;
  error: PluginFailure | null;
  stderrTail: string;
  unparsedLines: number;
  killedBy: KillReason | null;
  sandboxed: boolean;
  /** True when `warn` mode re-ran the plugin with the sandbox off. */
  retriedWithoutSandbox: boolean;
  durationMs: number;
}

/** SIGTERM (or taskkill) the child's whole tree. */
function terminate(child: PluginChild, force: boolean): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    // Windows has no process groups; taskkill /T is the only way to reach a
    // plugin's own children (a browser, say). /F is immediate — there is no
    // graceful-then-forceful pair to emulate here.
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => undefined);
      killer.unref();
    } catch {
      child.kill("SIGKILL");
    }
    return;
  }
  const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
  try {
    // Negative pid = the whole group, which `detached: true` gave the child.
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

interface RunOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  hello: HelloEvent | null;
  events: PluginEvent[];
  result: unknown;
  errorEvent: ErrorEvent | null;
  stderrTail: string;
  unparsedLines: number;
  killedBy: KillReason | null;
}

/** One spawn, with no sandbox-retry logic. */
async function runOnce(
  options: SpawnPluginOptions,
  sandboxFlags: readonly string[],
): Promise<RunOutcome> {
  const helloTimeout = options.timeouts?.hello ?? HELLO_TIMEOUT_MS;
  const idleTimeout = options.timeouts?.idle ?? IDLE_TIMEOUT_MS;
  const totalTimeout = options.timeouts?.total;

  const argv = [...sandboxFlags, options.plugin.entryPath, options.verb, ...(options.args ?? [])];
  const env = buildEnv(options.env ?? {}, options.tmpDir);

  const child = spawn(process.execPath, argv, {
    cwd: options.cwd ?? options.plugin.dir,
    // The allowlist is deliberately not a `ProcessEnv` (which Next augments to
    // require NODE_ENV): a plugin gets exactly what buildEnv put in it.
    env: env as unknown as NodeJS.ProcessEnv,
    // A group of its own, so a SIGTERM reaches everything the plugin started.
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const events: PluginEvent[] = [];
  let hello: HelloEvent | null = null;
  let result: unknown;
  let errorEvent: ErrorEvent | null = null;
  let unparsedLines = 0;
  let stderrTail = "";
  let killedBy: KillReason | null = null;
  let killTimer: NodeJS.Timeout | null = null;

  const kill = (reason: KillReason): void => {
    if (killedBy) return;
    killedBy = reason;
    terminate(child, false);
    killTimer = setTimeout(() => terminate(child, true), KILL_GRACE_MS);
    killTimer.unref?.();
  };

  let idleTimer: NodeJS.Timeout | null = null;
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => kill("idle-timeout"), idleTimeout);
    idleTimer.unref?.();
  };

  const helloTimer = setTimeout(() => {
    if (!hello) kill("hello-timeout");
  }, helloTimeout);
  helloTimer.unref?.();

  const totalTimer =
    totalTimeout === undefined ? null : setTimeout(() => kill("total-timeout"), totalTimeout);
  totalTimer?.unref?.();

  const onAbort = (): void => kill("cancel");
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  const handleEvent = (event: PluginEvent): void => {
    armIdle();
    if (events.length < MAX_RETAINED_EVENTS) events.push(event);
    if (event.t === "hello" && !hello) hello = event;
    if (event.t === "result") result = event.data;
    if (event.t === "error") errorEvent = event;
    options.onEvent?.(event);
  };

  const handleLine = (line: string): void => {
    const event = parseEventLine(line);
    if (event) {
      handleEvent(event);
      return;
    }
    unparsedLines += 1;
    options.onUnparsed?.(line.length > 2000 ? `${line.slice(0, 2000)}…` : line);
  };

  let stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let index = stdoutBuffer.indexOf("\n");
    while (index !== -1) {
      const line = stdoutBuffer.slice(0, index).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      handleLine(line);
      index = stdoutBuffer.indexOf("\n");
    }
    // A plugin that never writes a newline must not grow the buffer forever.
    if (stdoutBuffer.length > MAX_LINE_BYTES) {
      handleLine(stdoutBuffer);
      stdoutBuffer = "";
    }
  });

  let stderrBuffer = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    if (!options.onStderr) return;
    stderrBuffer += chunk;
    let index = stderrBuffer.indexOf("\n");
    while (index !== -1) {
      const line = stderrBuffer.slice(0, index).replace(/\r$/, "");
      stderrBuffer = stderrBuffer.slice(index + 1);
      if (line.trim() !== "") options.onStderr(line);
      index = stderrBuffer.indexOf("\n");
    }
    if (stderrBuffer.length > MAX_LINE_BYTES) stderrBuffer = stderrBuffer.slice(-MAX_LINE_BYTES);
  });

  armIdle();

  const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on("error", (error) => {
        stderrTail = `${stderrTail}\n${error.message}`.slice(-STDERR_TAIL_BYTES);
        resolve({ code: null, signal: null });
      });
      child.on("close", (code, signal) => resolve({ code, signal }));
    },
  );

  clearTimeout(helloTimer);
  if (idleTimer) clearTimeout(idleTimer);
  if (totalTimer) clearTimeout(totalTimer);
  if (killTimer) clearTimeout(killTimer);
  options.signal?.removeEventListener("abort", onAbort);

  if (stdoutBuffer.trim() !== "") handleLine(stdoutBuffer);
  if (stderrBuffer.trim() !== "") options.onStderr?.(stderrBuffer);

  return {
    exitCode: closed.code,
    signal: closed.signal,
    hello,
    events,
    result,
    errorEvent,
    stderrTail,
    unparsedLines,
    killedBy,
  };
}

/**
 * Run one plugin verb to completion.
 *
 * Never throws for a plugin's own failure — the caller reads `error` and
 * decides whether that is a job failure, a notification or a retry.
 */
export async function spawnPlugin(options: SpawnPluginOptions): Promise<SpawnPluginResult> {
  const startedAt = Date.now();
  const mode = options.sandbox ?? sandboxMode();
  const flags = sandboxArgs(
    options.plugin.descriptor,
    {
      pluginDir: options.plugin.dir,
      sdkDir: options.sdkDir,
      outputDir: options.outputDir ?? null,
      tmpDir: options.tmpDir,
    },
    mode,
  );
  const sandboxed = flags.length > 0;

  let outcome = await runOnce(options, flags);
  let retriedWithoutSandbox = false;

  if (
    sandboxed &&
    mode === "warn" &&
    outcome.exitCode !== EXIT_CODES.OK &&
    outcome.killedBy === null &&
    isAccessDenied(outcome.stderrTail)
  ) {
    const diagnostic = describeAccessDenial(options.plugin.id, outcome.stderrTail);
    console.warn(`[plugins] ${diagnostic}`);
    options.onStderr?.(diagnostic);
    retriedWithoutSandbox = true;
    outcome = await runOnce(options, []);
  }

  const error: PluginFailure | null = outcome.errorEvent
    ? {
        code: outcome.errorEvent.code,
        message: outcome.errorEvent.message,
        retryable: outcome.errorEvent.retryable,
        ...(outcome.errorEvent.hint === undefined ? {} : { hint: outcome.errorEvent.hint }),
      }
    : outcome.killedBy !== null
      ? killFailure(outcome.killedBy)
      : failureFromExitCode(outcome.exitCode, outcome.signal);

  return {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    hello: outcome.hello,
    events: outcome.events,
    result: outcome.result,
    error,
    stderrTail: outcome.stderrTail,
    unparsedLines: outcome.unparsedLines,
    killedBy: outcome.killedBy,
    sandboxed: sandboxed && !retriedWithoutSandbox,
    retriedWithoutSandbox,
    durationMs: Date.now() - startedAt,
  };
}

function killFailure(reason: KillReason): PluginFailure {
  switch (reason) {
    case "cancel":
      return { code: "CANCELLED", message: "The run was cancelled", retryable: false };
    case "hello-timeout":
      return {
        code: "INTERNAL",
        message: `The plugin did not announce itself within ${HELLO_TIMEOUT_MS / 1000} s`,
        retryable: false,
      };
    case "idle-timeout":
      return {
        code: "NETWORK",
        message: "The plugin stopped reporting progress and was stopped",
        retryable: true,
      };
    case "total-timeout":
      return { code: "INTERNAL", message: "The plugin ran out of time", retryable: false };
  }
}

/**
 * `hello` handshake used at install time: proves the plugin starts, speaks the
 * protocol and is the plugin it claims to be. Anything else is a refusal.
 */
export async function helloCheck(
  options: Omit<SpawnPluginOptions, "verb" | "args" | "outputDir">,
): Promise<{ ok: true; hello: HelloEvent } | { ok: false; reason: string }> {
  const run = await spawnPlugin({
    ...options,
    verb: "hello",
    timeouts: { hello: HELLO_TIMEOUT_MS, idle: HELLO_TIMEOUT_MS, total: HELLO_TIMEOUT_MS * 2 },
  });

  const first = run.events[0];
  if (!first || first.t !== "hello") {
    const detail = run.error?.message ?? run.stderrTail.trim().split("\n").slice(-3).join(" ");
    return {
      ok: false,
      reason: `The plugin did not emit a hello event${detail ? `: ${detail}` : ""}`,
    };
  }
  if (first.v !== PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: `The plugin speaks protocol v${first.v}; this Kiri speaks v${PROTOCOL_VERSION}`,
    };
  }
  if (first.plugin !== options.plugin.id) {
    return {
      ok: false,
      reason: `The plugin announced itself as "${first.plugin}" but its descriptor says "${options.plugin.id}"`,
    };
  }
  if (run.exitCode !== EXIT_CODES.OK) {
    return { ok: false, reason: run.error?.message ?? `hello exited with code ${run.exitCode}` };
  }
  return { ok: true, hello: first };
}
