// Dev utility: capture the app shell with a real session for visual review.
// Usage: node scripts/screenshot-shell.mjs http://localhost:3005 out/screenshots
// Requires an empty user table (creates the first admin through /setup's API).
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const base = process.argv[2] ?? "http://localhost:3005";
const outDir = path.resolve(process.argv[3] ?? "out/screenshots");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: scheme,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const shot = async (route, name) => {
    await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
    await page.screenshot({ path: path.join(outDir, `${name}-${scheme}.png`), fullPage: true });
    console.log(`${scheme}: ${route} -> ${page.url()}`);
  };

  if (scheme === "light") {
    await shot("/setup", "setup");
    const res = await page.request.post(`${base}/api/auth/sign-up/email`, {
      data: {
        email: "admin@example.com",
        password: "correct-horse-battery",
        name: "Admin",
        displayName: "Steven",
      },
    });
    console.log("sign-up:", res.status());
  } else {
    const res = await page.request.post(`${base}/api/auth/sign-in/email`, {
      data: { email: "admin@example.com", password: "correct-horse-battery" },
    });
    console.log("sign-in:", res.status());
  }

  await shot("/", "home");
  await shot("/add", "add");
  await shot("/profile", "profile");
  await page.request.post(`${base}/api/auth/sign-out`);
  await shot("/login", "login");
  await context.close();
}
await browser.close();
