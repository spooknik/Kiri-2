import type { NextConfig } from "next";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * App version shown in the UI and /api/version.
 * Docker builds pass NEXT_PUBLIC_APP_VERSION as a build arg (the .git dir is
 * outside the image build context); local builds fall back to `git describe`,
 * then to package.json version + build date.
 */
function resolveAppVersion(): string {
  const fromEnv = process.env.NEXT_PUBLIC_APP_VERSION?.trim();
  if (fromEnv && fromEnv !== "dev") {
    return fromEnv;
  }
  try {
    return execSync("git describe --tags --always --dirty", { encoding: "utf-8" }).trim();
  } catch {
    try {
      const pkg = JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf-8")) as {
        version?: string;
      };
      return `${pkg.version ?? "0.0.0"}+${new Date().toISOString().slice(0, 10)}`;
    } catch {
      return "dev";
    }
  }
}

/**
 * `script-src` needs `'unsafe-eval'` in dev only, for Turbopack/webpack HMR
 * (`eval()`-based module wrapping). Production never gets it.
 */
const scriptSrc =
  process.env.NODE_ENV === "production"
    ? "script-src 'self' 'unsafe-inline'"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";

/**
 * `img-src` allows `https:` broadly rather than an allowlist of specific CDN
 * hosts. Covers are not limited to a fixed set of origins: MAL search results
 * (`MalSearchResult.coverUrl`, rendered directly in
 * `components/series/mal-search-panel.tsx`) come from Jikan/MAL/MangaDex CDNs,
 * and the series form's cover preview (`components/series/series-form.tsx`)
 * plus plugin `resolve` answers (`ResolvedSource.coverUrl`,
 * `lib/plugins/resolve.ts`) can point at any site a plugin knows how to scrape.
 * A fixed host allowlist would break every third-party plugin's cover art, so
 * this trades a narrower CSP for one that does not silently blank out covers;
 * `default-src 'self'` plus `connect-src 'self'` still block those hosts from
 * being used for anything but passive `<img>` loads.
 */
const CSP = [
  "default-src 'self'",
  scriptSrc,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // Browsers ignore Strict-Transport-Security on a plain-http response, so
  // sending it unconditionally is safe for local/dev http servers (localhost,
  // Docker on http) — it only takes effect once the app is actually served
  // over https, which is how it reaches production behind Cloudflare/TLS.
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "Content-Security-Policy", value: CSP },
];

const nextConfig: NextConfig = {
  output: "standalone",
  // Monorepo: trace files from the repo root so workspace packages land in the
  // standalone output.
  outputFileTracingRoot: path.join(__dirname, "../../"),
  images: {
    // Content images are served by our own routes and cached by the service
    // worker; Next's optimizer would only add a second cache layer.
    unoptimized: true,
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: resolveAppVersion(),
  },
  // Native addons and ESM-only packages must not be bundled by Turbopack.
  serverExternalPackages: [
    "sharp",
    "pg",
    "@prisma/adapter-pg",
    "embedded-postgres",
    "@napi-rs/canvas",
    "pdfjs-dist",
  ],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
