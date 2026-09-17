/**
 * `@kiri/source-sdk/testing` — the harness a plugin author tests against.
 *
 * Three pieces, all dependency-free:
 *  - {@link startFixtureServer}: a static `node:http` server on a random port,
 *    so a plugin is exercised end-to-end without touching a real site (and can
 *    be made to fail on demand, to test resume/checkpoint behaviour);
 *  - {@link runPlugin}: spawns `node <entry> <verb> …` exactly as Kiri does and
 *    returns the parsed events, the exit code and stderr;
 *  - {@link makeTmpDir}: a throwaway output directory.
 */
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseEventLine,
  type ErrorEvent,
  type HelloEvent,
  type PluginEvent,
  type ResultEvent,
} from "./protocol.js";

/* -------------------------------------------------------------------------- */
/* Fixture server                                                             */
/* -------------------------------------------------------------------------- */

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".bin": "application/octet-stream",
};

export interface FixtureServerOptions {
  /** Interface to bind. Default `127.0.0.1`. */
  host?: string;
  /** Fixed port; default 0 (an ephemeral port, which is what tests want). */
  port?: number;
  /** Extra headers on every response (e.g. `cf-mitigated` for a challenge). */
  headers?: Record<string, string>;
}

export interface FixtureServer {
  /** e.g. `http://127.0.0.1:53412` (no trailing slash). */
  baseUrl: string;
  port: number;
  /** Absolute URL for a path inside the fixture root. */
  url(pathname: string): string;
  /** Every request path the server saw, in order. */
  requests: string[];
  /** Make one path answer `status` instead of the file (once per `times`). */
  fail(pathname: string, status?: number, times?: number): void;
  clearFailures(): void;
  close(): Promise<void>;
}

/** Serve `rootDir` over HTTP on an ephemeral port. */
export async function startFixtureServer(
  rootDir: string,
  options: FixtureServerOptions = {},
): Promise<FixtureServer> {
  const root = path.resolve(rootDir);
  const requests: string[] = [];
  const failures = new Map<string, { status: number; times: number }>();

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestUrl = new URL(request.url ?? "/", "http://fixture.invalid");
    const pathname = decodeURIComponent(requestUrl.pathname);
    requests.push(pathname);

    for (const [key, value] of Object.entries(options.headers ?? {})) {
      response.setHeader(key, value);
    }

    const failure = failures.get(pathname);
    if (failure && failure.times > 0) {
      failure.times -= 1;
      if (failure.times === 0) failures.delete(pathname);
      response.writeHead(failure.status, { "content-type": "text/plain" });
      response.end(`fixture failure ${failure.status}`);
      return;
    }

    const relative = pathname.replace(/^\/+/, "");
    let target = path.resolve(root, relative);
    // Never serve outside the fixture root, even for `..` in the URL.
    if (target !== root && !target.startsWith(root + path.sep)) {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("forbidden");
      return;
    }

    let info = await stat(target).catch(() => null);
    if (info?.isDirectory()) {
      target = path.join(target, "index.html");
      info = await stat(target).catch(() => null);
    }
    if (!info?.isFile()) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }

    response.writeHead(200, {
      "content-type":
        CONTENT_TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream",
      "content-length": String(info.size),
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(target).pipe(response);
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end("fixture error");
    });
  });

  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://${host}:${address.port}`;

  return {
    baseUrl,
    port: address.port,
    requests,
    url: (pathname) => `${baseUrl}/${pathname.replace(/^\/+/, "")}`,
    fail: (pathname, status = 500, times = Number.MAX_SAFE_INTEGER) => {
      failures.set(pathname.startsWith("/") ? pathname : `/${pathname}`, { status, times });
    },
    clearFailures: () => failures.clear(),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/* -------------------------------------------------------------------------- */
/* Plugin runner                                                              */
/* -------------------------------------------------------------------------- */

export interface RunPluginOptions {
  /** Added to a KIRI_*-free copy of `process.env`, so tests stay hermetic. */
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Kill the plugin after this long. Default 60 000 ms. */
  timeoutMs?: number;
  /** Node executable; defaults to the one running the tests. */
  nodePath?: string;
}

export interface RunPluginResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  events: PluginEvent[];
  /** Lines on stdout that were not valid protocol events (a bug if non-empty). */
  unparsed: string[];
  stdout: string;
  stderr: string;
  hello?: HelloEvent;
  result?: ResultEvent;
  error?: ErrorEvent;
  /** `result.data`, already unwrapped. */
  data?: unknown;
  /** True when the process was killed by the timeout. */
  timedOut: boolean;
}

/** Spawn a plugin the way the Kiri host does and collect its protocol stream. */
export function runPlugin(
  entry: string,
  argv: readonly string[],
  options: RunPluginOptions = {},
): Promise<RunPluginResult> {
  const baseEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("KIRI_")) continue;
    baseEnv[key] = value;
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...baseEnv, ...(options.env ?? {}) })) {
    if (value !== undefined) env[key] = value;
  }

  return new Promise<RunPluginResult>((resolve, reject) => {
    const child = spawn(options.nodePath ?? process.execPath, [entry, ...argv], {
      cwd: options.cwd ?? path.dirname(entry),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const events: PluginEvent[] = [];
    const unparsed: string[] = [];
    let stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;

    const consume = (chunk: string): void => {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.trim() !== "") {
          const event = parseEventLine(line);
          if (event) events.push(event);
          else unparsed.push(line);
        }
        newline = pending.indexOf("\n");
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      consume(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 60_000);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (pending.trim() !== "") consume("\n");
      const hello = events.find((event): event is HelloEvent => event.t === "hello");
      const result = events.find((event): event is ResultEvent => event.t === "result");
      const failure = events.find((event): event is ErrorEvent => event.t === "error");
      resolve({
        exitCode: code,
        signal,
        events,
        unparsed,
        stdout,
        stderr,
        timedOut,
        ...(hello === undefined ? {} : { hello }),
        ...(result === undefined ? {} : { result, data: result.data }),
        ...(failure === undefined ? {} : { error: failure }),
      });
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                       */
/* -------------------------------------------------------------------------- */

/** A fresh empty directory under the OS temp dir. */
export function makeTmpDir(prefix = "kiri-plugin-"): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** Read and parse a JSON file (the manifest, in most tests). */
export async function readJsonFile<T = unknown>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

/** Events of one type, in order. */
export function eventsOfType<T extends PluginEvent["t"]>(
  events: readonly PluginEvent[],
  type: T,
): Extract<PluginEvent, { t: T }>[] {
  return events.filter((event): event is Extract<PluginEvent, { t: T }> => event.t === type);
}
