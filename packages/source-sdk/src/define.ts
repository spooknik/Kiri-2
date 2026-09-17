/**
 * `definePlugin` — everything a content-source plugin does *not* have to write.
 *
 * It owns the whole subprocess ABI: argv parsing, the `hello` handshake and SDK
 * compatibility check, JSON-lines events, `SIGTERM`/`SIGINT` → `AbortSignal`,
 * error → exit code mapping, manifest merging and per-chapter checkpointing.
 * A plugin supplies four small hooks — `resolve`, `listChapters`, `listPages`
 * and optionally `fetchCover`/`downloadPage` — and nothing else.
 *
 * ```js
 * definePlugin({
 *   id: "example",
 *   hosts: ["example.com"],
 *   async resolve(url, ctx) { … },
 *   async listChapters(series, ctx) { … },
 *   async listPages(chapter, ctx) { … },
 * });
 * ```
 */
import { Buffer } from "node:buffer";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { format } from "node:util";

import { createBrowserApi, type BrowserApi } from "./browser.js";
import { downloadAll, sniffImageType, toManifestImage, type PageRef } from "./download.js";
import { readEnv, type PluginEnv } from "./env.js";
import { PluginError } from "./errors.js";
import { HttpClient, type HttpClientOptions } from "./http.js";
import {
  chapterDirName,
  mergeDiscoveredChapters,
  readManifest,
  writeManifest,
  type DiscoveredChapter,
  type Manifest,
  type ManifestChapter,
} from "./manifest.js";
import {
  emit,
  EXIT_CODES,
  PROTOCOL_VERSION,
  type LogLevel,
  type ProgressPhase,
} from "./protocol.js";
import { satisfies } from "./semver.js";
import { SDK_VERSION } from "./version.js";

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export interface SettingSpec {
  key: string;
  type: "string" | "number" | "boolean" | "select";
  default?: unknown;
  label?: string;
  description?: string;
  options?: { value: string; label: string }[];
  required?: boolean;
}

/** What `resolve` answers for a pasted URL. */
export interface ResolvedSeries {
  /** `false` means "not my site" — the host asks the next plugin. */
  handled: boolean;
  /** Canonical URL stored on the source (no tracking params, no locale). */
  normalizedUrl: string;
  /** Stable, human-readable identifier at the source. */
  slug: string;
  title?: string;
  /** `MANGA | MANHWA | MANHUA | COMIC | LIGHT_NOVEL | NOVEL | BOOK | OTHER`. */
  mediaType?: string;
  coverUrl?: string;
  /** Source-side id, when it differs from the slug. */
  externalId?: string;
}

/** One chapter as listed by the source. */
export type ChapterStub = DiscoveredChapter;

/** One page of a chapter. */
export type PageStub = PageRef;

/** The chapter handed to `listPages` — a manifest entry, already merged. */
export type ChapterInput = ManifestChapter;

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ProgressInput {
  phase: ProgressPhase;
  current: number;
  total: number;
  chapterSlug?: string;
  bytes?: number;
}

/** Everything a hook is given. */
export interface Ctx {
  /** Shared HTTP client: retries, rate limit, cookie and User-Agent applied. */
  http: HttpClient;
  /** Headless Chromium helper (optional peer dependency `playwright`). */
  browser: BrowserApi;
  log: Logger;
  progress(progress: ProgressInput): void;
  /** Raw `Cookie:` header value from the host, if any. */
  cookie?: string;
  userAgent?: string;
  /** `Source.configJson`, validated by the host against `settings`. */
  settings: Record<string, unknown>;
  /** Aborted on SIGTERM/SIGINT — pass it to every await you own. */
  signal: AbortSignal;
  /** Series directory for `sync`/`verify`; `""` for `resolve`/`discover`. */
  outputDir: string;
  verbose: boolean;
  env: PluginEnv;
  descriptor?: PluginDescriptor;
}

export interface PluginSpec {
  /** Must equal the descriptor id and the install directory name. */
  id: string;
  name?: string;
  version?: string;
  /** Hosts this plugin claims; the descriptor's list is authoritative. */
  hosts: string[];
  /** Defaults for the shared `HttpClient`. */
  http?: HttpClientOptions;
  /** Page download concurrency; `KIRI_CONCURRENCY` wins when set. */
  concurrency?: number;
  settings?: SettingSpec[];

  resolve(url: string, ctx: Ctx): Promise<ResolvedSeries | null> | ResolvedSeries | null;
  listChapters(
    series: ResolvedSeries,
    ctx: Ctx,
  ): Promise<readonly ChapterStub[]> | readonly ChapterStub[];
  listPages(chapter: ChapterInput, ctx: Ctx): Promise<readonly PageStub[]> | readonly PageStub[];
  /** Override page fetching (signed URLs, decryption). Default: `ctx.http`. */
  downloadPage?(page: PageStub, ctx: Ctx): Promise<Buffer | null> | Buffer | null;
  /** Cover bytes for the series; written once as `cover.<ext>`. */
  fetchCover?(series: ResolvedSeries, ctx: Ctx): Promise<Buffer | null> | Buffer | null;
}

export interface PluginDescriptor {
  id: string;
  name?: string;
  version?: string;
  sdk?: string;
  entry?: string;
  hosts?: string[];
  capabilities?: string[];
  mediaTypes?: string[];
  adult?: boolean;
  homepage?: string;
  license?: string;
  minKiriVersion?: string;
  settings?: SettingSpec[];
}

/* -------------------------------------------------------------------------- */
/* argv                                                                       */
/* -------------------------------------------------------------------------- */

export const VERBS = ["hello", "resolve", "discover", "sync", "verify"] as const;
export type Verb = (typeof VERBS)[number];

/** Usage failures exit 2; the closed error-code set has no `USAGE` member. */
class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const USAGE = [
  "usage:",
  "  node <entry> hello",
  "  node <entry> resolve <url>",
  "  node <entry> discover <url>",
  "  node <entry> sync <url> --output <dir> [--limit n] [--force] [--chapter slug]…",
  "  node <entry> verify --output <dir>",
].join("\n");

export interface ParsedArgv {
  verb: Verb;
  url?: string;
  output?: string;
  limit?: number;
  force: boolean;
  chapters: string[];
}

export function parseArgv(argv: readonly string[]): ParsedArgv {
  const verb = argv[0];
  if (verb === undefined) throw new UsageError(`Missing verb.\n${USAGE}`);
  if (!(VERBS as readonly string[]).includes(verb)) {
    throw new UsageError(`Unknown verb "${verb}".\n${USAGE}`);
  }

  const parsed: ParsedArgv = { verb: verb as Verb, force: false, chapters: [] };
  const positional: string[] = [];

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);
    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`--${name} needs a value.\n${USAGE}`);
      }
      index += 1;
      return next;
    };

    switch (name) {
      case "output":
        parsed.output = takeValue();
        break;
      case "limit": {
        const value = Number.parseInt(takeValue(), 10);
        if (!Number.isFinite(value) || value < 1) {
          throw new UsageError(`--limit must be a positive integer.\n${USAGE}`);
        }
        parsed.limit = value;
        break;
      }
      case "force":
        parsed.force = true;
        break;
      case "chapter":
        parsed.chapters.push(takeValue());
        break;
      default:
        throw new UsageError(`Unknown option "--${name}".\n${USAGE}`);
    }
  }

  if (positional.length > 1) {
    throw new UsageError(`Unexpected argument "${positional[1]}".\n${USAGE}`);
  }
  if (positional[0] !== undefined) parsed.url = positional[0];

  if (
    (parsed.verb === "resolve" || parsed.verb === "discover" || parsed.verb === "sync") &&
    !parsed.url
  ) {
    throw new UsageError(`${parsed.verb} needs a <url>.\n${USAGE}`);
  }
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* Descriptor                                                                 */
/* -------------------------------------------------------------------------- */

const DESCRIPTOR_FILE = "kiri-plugin.json";

async function loadDescriptor(
  env: PluginEnv,
  entryPath: string | undefined,
): Promise<{ descriptor: PluginDescriptor; dir: string } | null> {
  const candidates: string[] = [];
  if (env.pluginDir) candidates.push(path.resolve(env.pluginDir));
  if (entryPath) {
    let dir = path.dirname(path.resolve(entryPath));
    for (let depth = 0; depth < 4; depth += 1) {
      candidates.push(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  candidates.push(process.cwd());

  for (const dir of candidates) {
    try {
      const text = await readFile(path.join(dir, DESCRIPTOR_FILE), "utf8");
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return { descriptor: parsed as PluginDescriptor, dir };
      }
    } catch {
      // Not here (or unreadable) — try the next candidate.
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

export interface RunOptions {
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Defaults to `process.argv[1]` (used to locate `kiri-plugin.json`). */
  entryPath?: string;
  /** Set false in tests to keep `process.exitCode` untouched. */
  manageProcess?: boolean;
}

interface RunOutcome {
  exitCode: number;
}

function makeLogger(verbose: boolean): Logger {
  const write = (level: LogLevel, args: unknown[]): void => {
    if (level === "debug" && !verbose) return;
    emit({ t: "log", level, msg: format(...args) });
  };
  return {
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
  };
}

/**
 * stdout belongs to the protocol, so a stray `console.log` in plugin code would
 * corrupt the stream. Everything is rerouted into `log` events instead.
 */
function captureConsole(logger: Logger): () => void {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  console.log = (...args: unknown[]) => logger.info(...args);
  console.info = (...args: unknown[]) => logger.info(...args);
  console.warn = (...args: unknown[]) => logger.warn(...args);
  console.error = (...args: unknown[]) => logger.error(...args);
  console.debug = (...args: unknown[]) => logger.debug(...args);
  return () => Object.assign(console, original);
}

function emitChapter(chapter: {
  slug: string;
  title?: string;
  number?: number;
  imageCount?: number;
  status?: ManifestChapter["status"];
}): void {
  emit({
    t: "chapter",
    slug: chapter.slug,
    title: chapter.title ?? chapter.slug,
    number: chapter.number ?? null,
    pageCount: chapter.imageCount ?? 0,
    status: chapter.status ?? "pending",
  });
}

async function fileExists(file: string): Promise<boolean> {
  const info = await stat(file).catch(() => null);
  return info?.isFile() === true && info.size > 0;
}

async function writeCover(dir: string, body: Buffer): Promise<string> {
  const type = sniffImageType(body);
  if (!type) throw new PluginError("PARSE", "fetchCover returned bytes that are not an image");
  const fileName = `cover${type.ext}`;
  const temp = path.join(dir, `.cover.${process.pid}.${Date.now()}.part`);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(temp, body);
    await rename(temp, path.join(dir, fileName));
  } catch (cause) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw new PluginError("IO", `Cannot write ${fileName}: ${(cause as Error).message}`, { cause });
  }
  return fileName;
}

async function resolveOrThrow(spec: PluginSpec, url: string, ctx: Ctx): Promise<ResolvedSeries> {
  const resolved = await spec.resolve(url, ctx);
  if (!resolved || resolved.handled !== true) {
    throw new PluginError("UNSUPPORTED_URL", `${spec.id} does not handle ${url}`);
  }
  return resolved;
}

function countStatuses(manifest: Manifest): { completed: number; failed: number } {
  let completed = 0;
  let failed = 0;
  for (const chapter of manifest.chapters) {
    if (chapter.status === "completed") completed += 1;
    else if (chapter.status === "failed") failed += 1;
  }
  return { completed, failed };
}

/** Stop the whole sync instead of failing chapter after chapter. */
const FATAL_CODES = new Set(["NEEDS_CREDENTIAL", "RATE_LIMITED", "BLOCKED", "CANCELLED"]);

async function runSync(
  spec: PluginSpec,
  ctx: Ctx,
  cli: ParsedArgv,
  outputDir: string,
): Promise<unknown> {
  const url = cli.url as string;

  ctx.progress({ phase: "resolve", current: 0, total: 1 });
  const series = await resolveOrThrow(spec, url, ctx);
  ctx.progress({ phase: "resolve", current: 1, total: 1 });

  let manifest = await readManifest(outputDir, {
    site: spec.id,
    series: {
      url: series.normalizedUrl,
      slug: series.slug,
      ...(series.title === undefined ? {} : { title: series.title }),
    },
  });
  manifest.site = spec.id;
  manifest.series.url = series.normalizedUrl;
  manifest.series.slug = series.slug;
  if (series.title) manifest.series.title = series.title;
  if (series.mediaType) manifest.series.mediaType = series.mediaType;
  if (series.externalId) manifest.series.id = series.externalId;

  // Cover: fetched once, never re-fetched while the file is on disk.
  if (spec.fetchCover) {
    const existingCover = manifest.series.coverFile;
    const hasCover = existingCover ? await fileExists(path.join(outputDir, existingCover)) : false;
    if (!hasCover) {
      ctx.progress({ phase: "cover", current: 0, total: 1 });
      try {
        const body = await spec.fetchCover(series, ctx);
        if (body && body.length > 0) {
          manifest.series.coverFile = await writeCover(outputDir, body);
        }
      } catch (error) {
        // A missing cover must never fail a sync.
        ctx.log.warn(`Could not fetch the cover: ${PluginError.from(error).message}`);
      }
      ctx.progress({ phase: "cover", current: 1, total: 1 });
    }
  }

  ctx.progress({ phase: "discover", current: 0, total: 1 });
  const discovered = await spec.listChapters(series, ctx);
  manifest = mergeDiscoveredChapters(manifest, discovered);
  await writeManifest(outputDir, manifest);
  ctx.progress({
    phase: "discover",
    current: manifest.chapters.length,
    total: manifest.chapters.length,
  });
  for (const chapter of manifest.chapters) emitChapter(chapter);

  const wanted = new Set(cli.chapters);
  let targets = manifest.chapters.filter((chapter) => {
    if (wanted.size > 0) return wanted.has(chapter.slug);
    if (chapter.missingFromSource === true && chapter.status !== "completed") return false;
    if (chapter.status === "completed") return cli.force === true;
    return true;
  });
  if (cli.limit !== undefined) targets = targets.slice(0, cli.limit);

  if (wanted.size > 0) {
    const missing = [...wanted].filter(
      (slug) => !manifest.chapters.some((chapter) => chapter.slug === slug),
    );
    if (missing.length > 0) {
      throw new PluginError("NOT_FOUND", `No such chapter: ${missing.join(", ")}`);
    }
  }

  let pagesDownloaded = 0;
  const concurrency = ctx.env.concurrency ?? spec.concurrency ?? 4;

  for (const [position, chapter] of targets.entries()) {
    if (ctx.signal.aborted) throw new PluginError("CANCELLED", "Cancelled");
    ctx.progress({
      phase: "chapter",
      current: position + 1,
      total: targets.length,
      chapterSlug: chapter.slug,
    });
    chapter.status = "downloading";
    emitChapter(chapter);

    try {
      const pages = await spec.listPages(chapter, ctx);
      if (pages.length === 0) {
        throw new PluginError("PARSE", `No pages found for chapter "${chapter.slug}"`);
      }
      const chapterDir = path.join(outputDir, chapterDirName(chapter.slug));
      const result = await downloadAll(pages, {
        http: ctx.http,
        dir: chapterDir,
        concurrency,
        force: cli.force,
        existing: chapter.images,
        signal: ctx.signal,
        onProgress: ({ completed, total, bytes }) =>
          ctx.progress({
            phase: "page",
            current: completed,
            total,
            chapterSlug: chapter.slug,
            bytes,
          }),
        ...(spec.downloadPage
          ? { download: (page: PageStub) => spec.downloadPage?.(page, ctx) ?? null }
          : {}),
      });

      chapter.images = result.images.map(toManifestImage);
      chapter.imageCount = chapter.images.length;
      chapter.status = "completed";
      chapter.downloadedAt = new Date().toISOString();
      delete chapter.lastError;
      pagesDownloaded += result.downloaded;
      emitChapter(chapter);
    } catch (error) {
      const pluginError = PluginError.from(error);
      if (pluginError.code === "CANCELLED") {
        // A killed chapter is resumable, not broken.
        chapter.status = "pending";
        await writeManifest(outputDir, manifest);
        throw pluginError;
      }
      chapter.status = "failed";
      chapter.lastError = pluginError.message;
      ctx.log.error(`Chapter "${chapter.slug}" failed: ${pluginError.message}`);
      emitChapter(chapter);
      if (FATAL_CODES.has(pluginError.code)) {
        await writeManifest(outputDir, manifest);
        throw pluginError;
      }
    }
    // Checkpoint after every chapter: a kill -9 here still leaves a manifest
    // that describes exactly what is on disk.
    await writeManifest(outputDir, manifest);
  }

  const { completed, failed } = countStatuses(manifest);
  return {
    chaptersTotal: manifest.chapters.length,
    chaptersCompleted: completed,
    chaptersFailed: failed,
    pagesDownloaded,
  };
}

async function runVerify(ctx: Ctx, outputDir: string): Promise<unknown> {
  const manifest = await readManifest(outputDir);
  let pagesVerified = 0;
  let pagesMissing = 0;

  for (const [position, chapter] of manifest.chapters.entries()) {
    if (ctx.signal.aborted) throw new PluginError("CANCELLED", "Cancelled");
    ctx.progress({
      phase: "verify",
      current: position + 1,
      total: manifest.chapters.length,
      chapterSlug: chapter.slug,
    });

    const chapterDir = path.join(outputDir, chapterDirName(chapter.slug));
    let missing = 0;
    for (const image of chapter.images) {
      const info = await stat(path.join(chapterDir, image.file)).catch(() => null);
      if (info?.isFile() === true && info.size > 0) {
        image.bytes = info.size;
        pagesVerified += 1;
      } else {
        missing += 1;
        pagesMissing += 1;
      }
    }

    chapter.imageCount = chapter.images.length;
    if (chapter.images.length === 0) {
      chapter.status = chapter.status === "failed" ? "failed" : "pending";
    } else if (missing === 0) {
      chapter.status = "completed";
      delete chapter.lastError;
    } else {
      chapter.status = "pending";
      chapter.lastError = `${missing} of ${chapter.images.length} files are missing on disk`;
    }
    emitChapter(chapter);
  }

  await writeManifest(outputDir, manifest);
  const { completed, failed } = countStatuses(manifest);
  return {
    chaptersTotal: manifest.chapters.length,
    chaptersCompleted: completed,
    chaptersFailed: failed,
    pagesVerified,
    pagesMissing,
  };
}

/**
 * Run one CLI invocation. Exposed for tests and advanced hosts; plugins call
 * {@link definePlugin}, which wires this to `process.argv`.
 */
export async function runPluginCli(
  spec: PluginSpec,
  argv: readonly string[],
  options: RunOptions = {},
): Promise<RunOutcome> {
  const source = options.env ?? process.env;
  const env = readEnv(source);
  const entryPath = options.entryPath ?? process.argv[1];
  const loaded = await loadDescriptor(env, entryPath);
  const descriptor = loaded?.descriptor;

  // 1. hello, always the first line on stdout.
  emit({
    t: "hello",
    v: PROTOCOL_VERSION,
    plugin: descriptor?.id ?? spec.id,
    version: descriptor?.version ?? spec.version ?? "0.0.0",
    sdk: SDK_VERSION,
  });

  const controller = new AbortController();
  const logger = makeLogger(env.verbose);
  const restoreConsole = captureConsole(logger);
  const onSignal = (signal: NodeJS.Signals): void => {
    if (!controller.signal.aborted) {
      controller.abort(new PluginError("CANCELLED", `Cancelled by ${signal}`));
    }
  };
  const sigterm = (): void => onSignal("SIGTERM");
  const sigint = (): void => onSignal("SIGINT");
  process.on("SIGTERM", sigterm);
  process.on("SIGINT", sigint);

  const finish = (exitCode: number): RunOutcome => {
    restoreConsole();
    process.off("SIGTERM", sigterm);
    process.off("SIGINT", sigint);
    if (options.manageProcess !== false) {
      process.exitCode = exitCode;
      // Belt and braces: if a stray handle (a keep-alive socket, Chromium)
      // holds the loop open, leave anyway once stdout has drained.
      const timer = setTimeout(() => process.exit(exitCode), 3000);
      timer.unref();
    }
    return { exitCode };
  };

  try {
    // 2. SDK compatibility: the descriptor's range against the SDK actually in
    //    use (the host announces it via KIRI_SDK_VERSION).
    const effectiveSdk = env.sdkVersion ?? SDK_VERSION;
    if (descriptor?.sdk && !satisfies(effectiveSdk, descriptor.sdk)) {
      emit({
        t: "error",
        ok: false,
        code: "INTERNAL",
        message: `Plugin requires @kiri/source-sdk ${descriptor.sdk} but ${effectiveSdk} is installed`,
        retryable: false,
        hint: "Update the plugin, or update Kiri to a version that ships a matching SDK.",
      });
      return finish(EXIT_CODES.SDK_INCOMPATIBLE);
    }

    if (env.settingsError) logger.warn(env.settingsError);

    const cli = parseArgv(argv);
    const outputDir = cli.output ?? env.outputDir;
    if ((cli.verb === "sync" || cli.verb === "verify") && !outputDir) {
      throw new UsageError(`${cli.verb} needs --output <dir> (or KIRI_OUTPUT_DIR).\n${USAGE}`);
    }

    const ctx: Ctx = {
      http: new HttpClient({
        ...(spec.http ?? {}),
        signal: controller.signal,
        ...(env.cookie === undefined ? {} : { cookie: env.cookie }),
        ...(env.userAgent === undefined ? {} : { userAgent: env.userAgent }),
        onRetry: (info) =>
          logger.debug(
            `retry ${info.attempt}/${info.maxAttempts} in ${info.delayMs} ms — ${info.reason}`,
          ),
        env: source,
      }),
      browser: createBrowserApi({
        ...(env.cookie === undefined ? {} : { cookie: env.cookie }),
        ...(env.userAgent === undefined ? {} : { userAgent: env.userAgent }),
        ...(env.chromiumExecutablePath === undefined
          ? {}
          : { executablePath: env.chromiumExecutablePath }),
        signal: controller.signal,
        env: source,
      }),
      log: logger,
      progress: (progress) => emit({ t: "progress", ...progress }),
      ...(env.cookie === undefined ? {} : { cookie: env.cookie }),
      ...(env.userAgent === undefined ? {} : { userAgent: env.userAgent }),
      settings: env.settings,
      signal: controller.signal,
      outputDir: outputDir ?? "",
      verbose: env.verbose,
      env,
      ...(descriptor === undefined ? {} : { descriptor }),
    };

    switch (cli.verb) {
      case "hello":
        return finish(EXIT_CODES.OK);

      case "resolve": {
        const resolved = await spec.resolve(cli.url as string, ctx);
        emit({
          t: "result",
          ok: true,
          data: resolved && resolved.handled ? resolved : { handled: false },
        });
        return finish(EXIT_CODES.OK);
      }

      case "discover": {
        const series = await resolveOrThrow(spec, cli.url as string, ctx);
        const chapters = await spec.listChapters(series, ctx);
        chapters.forEach((chapter, index) => {
          ctx.progress({ phase: "discover", current: index + 1, total: chapters.length });
          emitChapter({
            slug: chapter.slug,
            ...(chapter.title === undefined ? {} : { title: chapter.title }),
            ...(chapter.number === undefined ? {} : { number: chapter.number }),
          });
        });
        emit({
          t: "result",
          ok: true,
          data: { chapterCount: chapters.length, series },
        });
        return finish(EXIT_CODES.OK);
      }

      case "sync": {
        const data = await runSync(spec, ctx, cli, outputDir as string);
        emit({ t: "result", ok: true, data });
        return finish(EXIT_CODES.OK);
      }

      case "verify": {
        const data = await runVerify(ctx, outputDir as string);
        emit({ t: "result", ok: true, data });
        return finish(EXIT_CODES.OK);
      }
    }
  } catch (error) {
    if (error instanceof UsageError) {
      emit({
        t: "error",
        ok: false,
        code: "INTERNAL",
        message: error.message,
        retryable: false,
        hint: "This is a host/plugin ABI mismatch — check the verb and its options.",
      });
      return finish(EXIT_CODES.USAGE);
    }
    const pluginError = PluginError.from(error);
    emit(pluginError.toEvent());
    return finish(pluginError.exitCode);
  }
}

/**
 * Declare a plugin and hand `process.argv` to the SDK.
 *
 * Auto-runs on import — a plugin entry file is a program, not a library. Set
 * `KIRI_PLUGIN_NO_AUTORUN=1` to import the module without running it (unit
 * tests of a plugin's own hooks).
 */
export function definePlugin(spec: PluginSpec): PluginSpec {
  const autorun = process.env["KIRI_PLUGIN_NO_AUTORUN"] === undefined;
  if (autorun) {
    void runPluginCli(spec, process.argv.slice(2)).catch((error: unknown) => {
      // Last-resort net: runPluginCli handles its own errors, so reaching here
      // means the SDK itself broke.
      const pluginError = PluginError.from(error);
      emit(pluginError.toEvent());
      process.exitCode = pluginError.exitCode;
    });
  }
  return spec;
}
