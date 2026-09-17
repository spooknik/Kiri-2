/**
 * Dev server for the fixture site.
 *
 *   node serve.mjs            # http://127.0.0.1:8787
 *   node serve.mjs 9000       # a different port
 *
 * It reuses `startFixtureServer` from `@kiri/source-sdk/testing`, the same
 * helper the SDK's own tests use, so what you develop against is exactly what
 * CI runs against.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startFixtureServer } from "@kiri/source-sdk/testing";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number.parseInt(process.argv[2] ?? process.env.PORT ?? "8787", 10);

const server = await startFixtureServer(path.join(here, "fixture-site"), { port });

process.stdout.write(
  [
    `Fixture site on ${server.baseUrl}`,
    `  series: ${server.baseUrl}/series/starlight-express/`,
    "",
    "Try:",
    `  node src/index.mjs resolve ${server.baseUrl}/series/starlight-express/`,
    `  node src/index.mjs discover ${server.baseUrl}/series/starlight-express/`,
    `  node src/index.mjs sync ${server.baseUrl}/series/starlight-express/ --output ./out`,
    `  node src/index.mjs verify --output ./out`,
    "",
  ].join("\n"),
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
