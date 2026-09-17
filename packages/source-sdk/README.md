# @kiri/source-sdk

The SDK for writing [Kiri](https://github.com/spooknik/Kiri2) content-source
plugins. A plugin is a small Node program that Kiri spawns
(`node <entry> <verb> …`); this package implements the whole contract so a
plugin only describes _its site_.

```js
import { definePlugin, parseError } from "@kiri/source-sdk";

export default definePlugin({
  id: "example",
  hosts: ["example.com"],

  async resolve(url, ctx) {
    const parsed = new URL(url);
    if (parsed.hostname !== "example.com") return null;
    const slug = parsed.pathname.split("/")[2];
    if (!slug) return null;
    return { handled: true, normalizedUrl: `https://example.com/manga/${slug}/`, slug };
  },

  async listChapters(series, ctx) {
    const html = await ctx.http.fetchText(series.normalizedUrl);
    // … → [{ slug, url, title, number }]
  },

  async listPages(chapter, ctx) {
    const html = await ctx.http.fetchText(chapter.url);
    // … → [{ index, url, referer }]
  },
});
```

| Module        | What you get                                                                              |
| ------------- | ----------------------------------------------------------------------------------------- |
| `define.ts`   | `definePlugin` — argv, `hello`, events, manifest, checkpoints, exit codes                 |
| `http.ts`     | `HttpClient` — retries, backoff + jitter, `Retry-After`, token bucket, cookie/UA          |
| `download.ts` | `downloadImage` / `downloadAll` — temp+rename, sha256, format sniffing, dimensions        |
| `manifest.ts` | manifest v2 read/merge/write (atomic) and the path helpers                                |
| `browser.ts`  | `withBrowser` / `withPage` / `pageHtml` — plain headless Chromium (optional `playwright`) |
| `errors.ts`   | `PluginError` + the closed error-code set                                                 |
| `protocol.ts` | the JSON-lines event types, `emit`, `parseEventLine`                                      |
| `env.ts`      | typed reader for the `KIRI_*` environment                                                 |
| `testing.ts`  | `@kiri/source-sdk/testing`: fixture server, plugin runner, tmp dirs                       |

Zero runtime dependencies. `playwright` is an optional peer dependency, loaded
only if a plugin uses the browser helper.

**Neutral by policy.** The SDK provides HTTP retries, rate limiting, cookie and
User-Agent pass-through and a plain headless browser. It deliberately contains
no TLS-fingerprint spoofing, no stealth patches and no challenge solving; a
Cloudflare interstitial is _detected_ and reported as `NEEDS_CREDENTIAL` so the
user can supply a cookie.

Full authoring guide: [`docs/PLUGINS.md`](../../docs/PLUGINS.md).
Working example: [`packages/source-template`](../source-template).
