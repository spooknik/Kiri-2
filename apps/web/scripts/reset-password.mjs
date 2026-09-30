#!/usr/bin/env node
/**
 * Print a one-time password reset link for a Kiri account — including your own
 * admin account, which the web UI deliberately won't reset.
 *
 * Run it inside the Kiri container, where APP_SECRET is already set:
 *
 *   docker exec -it <kiri-app-container> node /app/reset-password.mjs you@example.com
 *
 * (In Portainer: Containers → the app container → Console → /bin/sh.)
 *
 * It asks the running server over loopback, signing the request with a key
 * derived from APP_SECRET (src/lib/auth/cli-signature.ts). Plain Node, no
 * dependencies, because the production image has no TypeScript toolchain.
 *
 * Environment: APP_SECRET (required), KIRI_URL (default http://127.0.0.1:$PORT,
 * PORT defaulting to 3000).
 */
import { createHmac, hkdfSync } from "node:crypto";
import { pathToFileURL } from "node:url";

export const CLI_SIGNATURE_HEADER = "x-kiri-cli-signature";

/** Must match signCliRequest in src/lib/auth/cli-signature.ts. */
export function signCliRequest(secret, timestamp, body) {
  const key = Buffer.from(hkdfSync("sha256", secret, "kiri-cli", "password-reset/v1", 32));
  const mac = createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

async function main(argv) {
  const email = argv[0];
  if (!email || email === "-h" || email === "--help") {
    console.error("Usage: node reset-password.mjs <email>");
    return 2;
  }
  const secret = process.env.APP_SECRET;
  if (!secret) {
    console.error("APP_SECRET is not set. Run this inside the Kiri container.");
    return 2;
  }

  const base = (process.env.KIRI_URL ?? `http://127.0.0.1:${process.env.PORT ?? "3000"}`).replace(
    /\/+$/,
    "",
  );
  const body = JSON.stringify({ email });
  const timestamp = Math.floor(Date.now() / 1000);

  let response;
  try {
    response = await fetch(`${base}/api/cli/password-reset`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CLI_SIGNATURE_HEADER]: signCliRequest(secret, timestamp, body),
      },
      body,
    });
  } catch (error) {
    console.error(`Could not reach Kiri at ${base}: ${error.message}`);
    return 1;
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    console.error(payload?.error?.message ?? `Request failed with HTTP ${response.status}`);
    return 1;
  }

  console.log(`Password reset link for ${payload.email}`);
  console.log(`(single use, expires ${new Date(payload.expiresAt).toLocaleString()}):`);
  console.log("");
  console.log(payload.url);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
