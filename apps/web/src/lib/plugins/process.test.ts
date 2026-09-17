/**
 * The subprocess ABI: the line protocol, the exit-code mapping, the
 * environment allowlist, and the parts of {@link spawnPlugin} that can only be
 * proved by starting a real Node process — partial lines, the hello deadline,
 * cancellation, and "the error event wins over the exit code".
 *
 * The fixtures are throwaway `.mjs` files rather than the template plugin: this
 * file is about the host, and a fixture can misbehave on purpose.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildEnv,
  EXIT_CODES,
  failureFromExitCode,
  helloCheck,
  linesToEvents,
  parseEventLine,
  spawnPlugin,
  type PluginRunTarget,
} from "@/lib/plugins/process";

let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "kiri-process-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a fake plugin entry and return a run target for it. */
function fixture(name: string, body: string): PluginRunTarget {
  const dir = path.join(root, name);
  rmSync(dir, { recursive: true, force: true });
  const entryPath = path.join(dir, "index.mjs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(entryPath, body);
  return {
    id: name,
    dir,
    entryPath,
    descriptor: { capabilities: ["network"], sandbox: "strict" },
  };
}

const HELLO = `process.stdout.write(JSON.stringify({t:"hello",v:1,plugin:PLUGIN,version:"1.0.0",sdk:"2.0.0-alpha.0"})+"\\n");`;

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

describe("parseEventLine", () => {
  it("reads every event kind", () => {
    expect(
      parseEventLine('{"t":"hello","v":1,"plugin":"a","version":"1.0.0","sdk":"2.0.0"}'),
    ).toEqual({ t: "hello", v: 1, plugin: "a", version: "1.0.0", sdk: "2.0.0" });
    expect(parseEventLine('{"t":"log","level":"warn","msg":"hi"}')).toEqual({
      t: "log",
      level: "warn",
      msg: "hi",
    });
    expect(
      parseEventLine('{"t":"progress","phase":"page","current":2,"total":9,"chapterSlug":"c-1"}'),
    ).toEqual({ t: "progress", phase: "page", current: 2, total: 9, chapterSlug: "c-1" });
    expect(parseEventLine('{"t":"result","ok":true,"data":{"n":3}}')).toEqual({
      t: "result",
      ok: true,
      data: { n: 3 },
    });
  });

  it("defaults unknown levels, statuses and error codes", () => {
    expect(parseEventLine('{"t":"log","level":"shout","msg":"x"}')).toMatchObject({
      level: "info",
    });
    expect(parseEventLine('{"t":"chapter","slug":"c","status":"weird"}')).toMatchObject({
      status: "pending",
      title: "c",
      number: null,
      pageCount: 0,
    });
    expect(parseEventLine('{"t":"error","code":"NOPE","message":"x"}')).toMatchObject({
      code: "INTERNAL",
      retryable: false,
    });
  });

  it("returns null for anything that is not protocol", () => {
    expect(parseEventLine("")).toBeNull();
    expect(parseEventLine("plain log line")).toBeNull();
    expect(parseEventLine("{not json")).toBeNull();
    expect(parseEventLine("[1,2,3]")).toBeNull();
    expect(parseEventLine('{"t":"unknown"}')).toBeNull();
    expect(parseEventLine('{"t":"hello","v":1}')).toBeNull();
  });
});

describe("linesToEvents", () => {
  it("splits a blob and reports the lines that were not protocol", () => {
    const { events, unparsed } = linesToEvents(
      [
        '{"t":"log","level":"info","msg":"a"}',
        "noise",
        "",
        '{"t":"result","ok":true,"data":1}',
      ].join("\r\n"),
    );
    expect(events.map((event) => event.t)).toEqual(["log", "result"]);
    expect(unparsed).toEqual(["noise"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Exit codes                                                                 */
/* -------------------------------------------------------------------------- */

describe("failureFromExitCode", () => {
  it("maps the documented codes", () => {
    expect(failureFromExitCode(EXIT_CODES.OK, null)).toBeNull();
    expect(failureFromExitCode(EXIT_CODES.INTERNAL, null)).toMatchObject({ code: "INTERNAL" });
    expect(failureFromExitCode(EXIT_CODES.USAGE, null)).toMatchObject({ code: "INTERNAL" });
    expect(failureFromExitCode(EXIT_CODES.NEEDS_CREDENTIAL, null)).toMatchObject({
      code: "NEEDS_CREDENTIAL",
      retryable: false,
    });
    expect(failureFromExitCode(EXIT_CODES.NOT_FOUND, null)).toMatchObject({ code: "NOT_FOUND" });
    expect(failureFromExitCode(EXIT_CODES.RATE_LIMITED, null)).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });
    expect(failureFromExitCode(EXIT_CODES.CANCELLED, null)).toMatchObject({ code: "CANCELLED" });
    expect(failureFromExitCode(EXIT_CODES.SDK_INCOMPATIBLE, null)).toMatchObject({
      code: "INTERNAL",
    });
    expect(failureFromExitCode(42, null)).toMatchObject({ code: "INTERNAL" });
  });

  it("treats death by signal as cancellation", () => {
    expect(failureFromExitCode(null, "SIGKILL")).toMatchObject({ code: "CANCELLED" });
  });
});

/* -------------------------------------------------------------------------- */
/* Environment                                                                */
/* -------------------------------------------------------------------------- */

describe("buildEnv", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/kiri",
    DATABASE_URL: "postgres://secret",
    APP_SECRET: "super-secret",
    APP_SECRET_PREVIOUS: "older-secret",
    NODE_OPTIONS: "--require /tmp/evil.js",
    NEXT_PUBLIC_APP_VERSION: "2.0.0",
    PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
    RANDOM_THING: "nope",
  };

  it("passes only the allowlist through", () => {
    const env = buildEnv({}, "/tmp/run", source);
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/home/kiri");
    expect(env["PLAYWRIGHT_BROWSERS_PATH"]).toBe("/ms-playwright");
    expect(env["RANDOM_THING"]).toBeUndefined();
    expect(env["NEXT_PUBLIC_APP_VERSION"]).toBeUndefined();
  });

  it("never forwards a secret or NODE_OPTIONS", () => {
    const env = buildEnv({}, "/tmp/run", source);
    expect(env["DATABASE_URL"]).toBeUndefined();
    expect(env["APP_SECRET"]).toBeUndefined();
    expect(env["APP_SECRET_PREVIOUS"]).toBeUndefined();
    expect(env["NODE_OPTIONS"]).toBeUndefined();
  });

  it("refuses to let a caller smuggle a denied name back in", () => {
    const env = buildEnv(
      { APP_SECRET: "still no", KIRI_COOKIE: "cf_clearance=abc" },
      "/tmp/run",
      source,
    );
    expect(env["APP_SECRET"]).toBeUndefined();
    expect(env["KIRI_COOKIE"]).toBe("cf_clearance=abc");
  });

  it("points every temp variable at the run's own directory", () => {
    const env = buildEnv({}, path.join("/tmp", "run-1"), source);
    const expected = path.resolve("/tmp/run-1");
    expect(env["TMPDIR"]).toBe(expected);
    expect(env["TEMP"]).toBe(expected);
    expect(env["TMP"]).toBe(expected);
  });
});

/* -------------------------------------------------------------------------- */
/* Real subprocesses                                                          */
/* -------------------------------------------------------------------------- */

describe("spawnPlugin", () => {
  const runOptions = (plugin: PluginRunTarget) => ({
    plugin,
    tmpDir: root,
    sdkDir: root,
    sandbox: "off" as const,
  });

  it("collects hello, result and the exit code", async () => {
    const plugin = fixture(
      "ok-plugin",
      `${HELLO.replace("PLUGIN", '"ok-plugin"')}
       process.stdout.write(JSON.stringify({t:"result",ok:true,data:{chapters:3}})+"\\n");`,
    );

    const run = await spawnPlugin({ ...runOptions(plugin), verb: "sync" });

    expect(run.exitCode).toBe(0);
    expect(run.hello?.plugin).toBe("ok-plugin");
    expect(run.result).toEqual({ chapters: 3 });
    expect(run.error).toBeNull();
    expect(run.unparsedLines).toBe(0);
    expect(run.sandboxed).toBe(false);
  });

  it("reassembles events split across writes", async () => {
    const plugin = fixture(
      "split-plugin",
      `const line = JSON.stringify({t:"hello",v:1,plugin:"split-plugin",version:"1.0.0",sdk:"2.0.0"});
       process.stdout.write(line.slice(0, 12));
       setTimeout(() => {
         process.stdout.write(line.slice(12) + "\\n");
         process.stdout.write(JSON.stringify({t:"result",ok:true,data:"done"}) + "\\n");
       }, 30);`,
    );

    const run = await spawnPlugin({ ...runOptions(plugin), verb: "sync" });

    expect(run.hello?.plugin).toBe("split-plugin");
    expect(run.result).toBe("done");
    expect(run.unparsedLines).toBe(0);
  });

  it("turns non-protocol stdout into warnings instead of failing", async () => {
    const unparsed: string[] = [];
    const plugin = fixture(
      "noisy-plugin",
      `${HELLO.replace("PLUGIN", '"noisy-plugin"')}
       process.stdout.write("a stray console.log\\n");
       process.stderr.write("some stderr\\n");
       process.stdout.write(JSON.stringify({t:"result",ok:true,data:null})+"\\n");`,
    );

    const run = await spawnPlugin({
      ...runOptions(plugin),
      verb: "sync",
      onUnparsed: (line) => unparsed.push(line),
    });

    expect(run.exitCode).toBe(0);
    expect(run.error).toBeNull();
    expect(unparsed).toEqual(["a stray console.log"]);
    expect(run.stderrTail).toContain("some stderr");
  });

  it("prefers the error event over the exit code", async () => {
    const plugin = fixture(
      "erroring-plugin",
      `${HELLO.replace("PLUGIN", '"erroring-plugin"')}
       process.stdout.write(JSON.stringify({t:"error",ok:false,code:"NEEDS_CREDENTIAL",message:"cookie please",retryable:false,hint:"paste one"})+"\\n");
       process.exit(1);`,
    );

    const run = await spawnPlugin({ ...runOptions(plugin), verb: "sync" });

    expect(run.exitCode).toBe(1);
    expect(run.error).toMatchObject({
      code: "NEEDS_CREDENTIAL",
      message: "cookie please",
      hint: "paste one",
    });
  });

  it("kills a plugin that never says hello", async () => {
    const plugin = fixture("silent-plugin", `setTimeout(() => {}, 60_000);`);

    const run = await spawnPlugin({
      ...runOptions(plugin),
      verb: "sync",
      timeouts: { hello: 300, idle: 60_000 },
    });

    expect(run.killedBy).toBe("hello-timeout");
    expect(run.error).toMatchObject({ code: "INTERNAL" });
  });

  it("kills a plugin that goes silent mid-run", async () => {
    const plugin = fixture(
      "stalling-plugin",
      `${HELLO.replace("PLUGIN", '"stalling-plugin"')}
       setTimeout(() => {}, 60_000);`,
    );

    const run = await spawnPlugin({
      ...runOptions(plugin),
      verb: "sync",
      timeouts: { hello: 5_000, idle: 300 },
    });

    expect(run.killedBy).toBe("idle-timeout");
    expect(run.error).toMatchObject({ code: "NETWORK", retryable: true });
  });

  it("stops a running plugin when its signal aborts", async () => {
    const plugin = fixture(
      "long-plugin",
      `${HELLO.replace("PLUGIN", '"long-plugin"')}
       setInterval(() => process.stdout.write(JSON.stringify({t:"progress",phase:"page",current:1,total:9})+"\\n"), 40);`,
    );

    const controller = new AbortController();
    const started = spawnPlugin({
      ...runOptions(plugin),
      verb: "sync",
      signal: controller.signal,
      timeouts: { hello: 5_000, idle: 60_000 },
      onEvent: (event) => {
        if (event.t === "progress") controller.abort();
      },
    });

    const run = await started;
    expect(run.killedBy).toBe("cancel");
    expect(run.error).toMatchObject({ code: "CANCELLED" });
  });
});

describe("helloCheck", () => {
  const options = (plugin: PluginRunTarget) => ({
    plugin,
    tmpDir: root,
    sdkDir: root,
    sandbox: "off" as const,
  });

  it("accepts a plugin that announces itself correctly", async () => {
    const plugin = fixture("hello-ok", HELLO.replace("PLUGIN", '"hello-ok"'));
    const result = await helloCheck(options(plugin));
    expect(result.ok).toBe(true);
  });

  it("refuses a plugin that claims another id", async () => {
    const plugin = fixture("hello-liar", HELLO.replace("PLUGIN", '"somebody-else"'));
    const result = await helloCheck(options(plugin));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("somebody-else");
  });

  it("refuses a plugin that speaks another protocol version", async () => {
    const plugin = fixture(
      "hello-future",
      `process.stdout.write(JSON.stringify({t:"hello",v:99,plugin:"hello-future",version:"1.0.0",sdk:"9.0.0"})+"\\n");`,
    );
    const result = await helloCheck(options(plugin));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("v99");
  });

  it("refuses a plugin that crashes before hello", async () => {
    const plugin = fixture("hello-crash", `process.stderr.write("boom\\n"); process.exit(1);`);
    const result = await helloCheck(options(plugin));
    expect(result).toMatchObject({ ok: false });
  });
});
