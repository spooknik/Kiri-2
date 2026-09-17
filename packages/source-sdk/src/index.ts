/**
 * `@kiri/source-sdk` — the SDK Kiri content-source plugins are written against.
 *
 * A plugin is a small Node program: Kiri spawns `node <entry> <verb> …`, reads
 * JSON-lines events from its stdout and ingests the `manifest.json` it writes.
 * `definePlugin` implements that whole contract, so a plugin only describes
 * *this site*: how to recognise a URL, list chapters, list pages.
 *
 * ```js
 * import { definePlugin } from "@kiri/source-sdk";
 *
 * definePlugin({
 *   id: "example",
 *   hosts: ["example.com"],
 *   resolve(url, ctx) { … },
 *   listChapters(series, ctx) { … },
 *   listPages(chapter, ctx) { … },
 * });
 * ```
 *
 * The SDK is deliberately **neutral**: HTTP retries, rate limiting, cookie and
 * User-Agent pass-through and a plain headless browser helper. No
 * TLS-fingerprint spoofing, no stealth patches, no challenge solving — see the
 * "neutral SDK" section of `docs/PLUGINS.md`.
 *
 * Test helpers live in the separate entry point `@kiri/source-sdk/testing`.
 */

export * from "./protocol.js";
export * from "./errors.js";
export * from "./env.js";
export * from "./semver.js";
export * from "./http.js";
export * from "./download.js";
export * from "./manifest.js";
export * from "./browser.js";
export * from "./define.js";
export { SDK_VERSION } from "./version.js";
