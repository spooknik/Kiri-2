/**
 * Plain headless Chromium, for sites that build their page list in JavaScript.
 *
 * **Neutral by policy.** This helper launches stock Chromium with Playwright's
 * default arguments and does nothing else: no stealth patches, no
 * `navigator.webdriver` deletion, no TLS/JA3 fingerprint spoofing, no CAPTCHA
 * or challenge solving. A plugin that needs those must vendor them itself and
 * declare the `browser` capability; Kiri core stays neutral (see the
 * "neutral SDK" section of `docs/PLUGINS.md`).
 *
 * `playwright` is an **optional peer dependency**: it is only loaded when a
 * plugin actually calls one of these functions, and a missing install produces
 * a clear `INTERNAL` error instead of a module-resolution stack trace.
 */
import { PluginError } from "./errors.js";

/* Structural types — the SDK never imports Playwright's own types, so it stays
 * type-checkable (and installable) without Playwright present. */

export interface PlaywrightCookie {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
}

export interface PageLike {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  content(): Promise<string>;
  title(): Promise<string>;
  waitForSelector(selector: string, options?: Record<string, unknown>): Promise<unknown>;
  waitForTimeout(timeout: number): Promise<void>;
  evaluate<T = unknown>(fn: string | ((...args: never[]) => T), arg?: unknown): Promise<T>;
  close(): Promise<void>;
}

export interface BrowserContextLike {
  addCookies(cookies: PlaywrightCookie[]): Promise<void>;
  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

export interface BrowserLike {
  newContext(options?: Record<string, unknown>): Promise<BrowserContextLike>;
  close(): Promise<void>;
}

interface PlaywrightModule {
  chromium: {
    launch(options?: Record<string, unknown>): Promise<BrowserLike>;
  };
}

export interface BrowserOptions {
  /** Raw `Cookie:` header value; set for the domain of `url` (or `cookieUrl`). */
  cookie?: string;
  userAgent?: string;
  /** Always defaults to `true`; `false` is for local plugin development only. */
  headless?: boolean;
  /** Chromium binary; defaults to `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. */
  executablePath?: string;
  /** Origin the cookie belongs to when it differs from the page URL. */
  cookieUrl?: string;
  locale?: string;
  viewport?: { width: number; height: number };
  extraHeaders?: Record<string, string>;
  /** Navigation/launch timeout in ms. Default 45 000. */
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
}

export interface PageOptions extends BrowserOptions {
  /** Navigated to before the callback runs. */
  url?: string;
  /** Playwright wait state; default `domcontentloaded`. */
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
  /** Selector awaited after navigation (useful for JS-rendered readers). */
  waitForSelector?: string;
}

const DEFAULT_TIMEOUT_MS = 45_000;

/** Split a `Cookie:` header into Playwright cookies scoped to `url`. */
export function parseCookieHeader(header: string, url: string): PlaywrightCookie[] {
  const cookies: PlaywrightCookie[] = [];
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    cookies.push({
      name: trimmed.slice(0, separator).trim(),
      value: trimmed.slice(separator + 1).trim(),
      url,
    });
  }
  return cookies;
}

async function loadPlaywright(): Promise<PlaywrightModule> {
  // A non-literal specifier keeps TypeScript from requiring the optional peer
  // dependency's types at build time.
  const specifier = "playwright";
  try {
    return (await import(specifier)) as unknown as PlaywrightModule;
  } catch (cause) {
    throw new PluginError(
      "INTERNAL",
      'playwright is not installed. Add it to your plugin\'s dependencies (npm i playwright) and declare the "browser" capability in kiri-plugin.json.',
      { cause },
    );
  }
}

/**
 * Launch Chromium, hand the browser to `fn`, and always close it — including
 * when `fn` throws or the host cancels the job.
 */
export async function withBrowser<T>(
  fn: (browser: BrowserLike) => Promise<T>,
  options: BrowserOptions = {},
): Promise<T> {
  if (options.signal?.aborted) throw new PluginError("CANCELLED", "Cancelled");
  const playwright = await loadPlaywright();
  const env = options.env ?? process.env;
  const executablePath = options.executablePath ?? env["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"];

  const launchOptions: Record<string, unknown> = {
    headless: options.headless ?? true,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  if (executablePath) launchOptions["executablePath"] = executablePath;

  let browser: BrowserLike;
  try {
    browser = await playwright.chromium.launch(launchOptions);
  } catch (cause) {
    throw new PluginError(
      "INTERNAL",
      `Could not launch Chromium: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        hint: "Use the kiri:browser image (or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) so a Chromium binary is available.",
        cause,
      },
    );
  }

  const onAbort = (): void => {
    void browser.close().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fn(browser);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    await browser.close().catch(() => undefined);
  }
}

/**
 * Open one page in a fresh context (cookies + User-Agent applied), optionally
 * navigate to `options.url`, then hand it to `fn`.
 */
export async function withPage<T>(
  fn: (page: PageLike) => Promise<T>,
  options: PageOptions = {},
): Promise<T> {
  return withBrowser(async (browser) => {
    const contextOptions: Record<string, unknown> = {};
    const env = options.env ?? process.env;
    const userAgent = options.userAgent ?? env["KIRI_USER_AGENT"];
    if (userAgent) contextOptions["userAgent"] = userAgent;
    if (options.locale) contextOptions["locale"] = options.locale;
    if (options.viewport) contextOptions["viewport"] = options.viewport;

    const context = await browser.newContext(contextOptions);
    try {
      const cookie = options.cookie ?? env["KIRI_COOKIE"];
      const cookieUrl = options.cookieUrl ?? options.url;
      if (cookie && cookieUrl) {
        await context.addCookies(parseCookieHeader(cookie, cookieUrl));
      }
      if (options.extraHeaders) await context.setExtraHTTPHeaders(options.extraHeaders);

      const page = await context.newPage();
      if (options.url) {
        await page.goto(options.url, {
          waitUntil: options.waitUntil ?? "domcontentloaded",
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
        if (options.waitForSelector) {
          await page.waitForSelector(options.waitForSelector, {
            timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          });
        }
      }
      return await fn(page);
    } finally {
      await context.close().catch(() => undefined);
    }
  }, options);
}

/** Fetch a page's rendered HTML — the common case, in one call. */
export async function pageHtml(url: string, options: PageOptions = {}): Promise<string> {
  return withPage((page) => page.content(), { ...options, url });
}

/** The browser surface handed to plugins as `ctx.browser`. */
export interface BrowserApi {
  withBrowser<T>(fn: (browser: BrowserLike) => Promise<T>, options?: BrowserOptions): Promise<T>;
  withPage<T>(fn: (page: PageLike) => Promise<T>, options?: PageOptions): Promise<T>;
  pageHtml(url: string, options?: PageOptions): Promise<string>;
}

/** Bind cookie/User-Agent/signal defaults so plugins can call `ctx.browser.*`. */
export function createBrowserApi(defaults: BrowserOptions): BrowserApi {
  const merge = <T extends BrowserOptions>(options?: T): T =>
    ({ ...defaults, ...(options ?? {}) }) as T;
  return {
    withBrowser: (fn, options) => withBrowser(fn, merge(options)),
    withPage: (fn, options) => withPage(fn, merge(options)),
    pageHtml: (url, options) => pageHtml(url, merge(options)),
  };
}
