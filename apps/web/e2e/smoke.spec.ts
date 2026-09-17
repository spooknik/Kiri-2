import { expect, test } from "@playwright/test";

test("health endpoint reports a working database", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { status: string; database: string };
  expect(body.status).toBe("ok");
  expect(body.database).toBe("ok");
});

test("home page renders", async ({ page }) => {
  // The e2e database starts fresh (see global-setup.ts), so there are no
  // users yet: "/" redirects to "/login", which itself redirects to
  // "/setup" (src/app/(auth)/login/page.tsx redirects when the user count
  // is zero). This deliberately doesn't submit the setup form — it runs
  // before tracker.spec.ts, whose first step performs the actual sign-up on
  // this same still-empty database.
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { name: "Welcome to Kiri" })).toBeVisible();
});
