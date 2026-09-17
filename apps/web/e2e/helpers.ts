/**
 * Shared helpers for the e2e specs: unique test data, the setup/register/login
 * UI flows, a manual "add series" flow, small `page.request` wrappers for the
 * admin/API-driven parts of the scenarios (invites, private-series checks,
 * notification polling, chapter-processing polling), and a couple of Phase 2
 * (content/reader) fixtures.
 *
 * Kept UI-selector-driven wherever the task exercises a form (accessible
 * name / label text, matching the real components under src/components and
 * src/app) rather than CSS, except where an href is the least ambiguous way
 * to find a specific series card/chapter row among others on the same page.
 */
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import sharp from "sharp";

let counter = 0;

/** Unique, readable email — avoids collisions across tests sharing one DB for the run. */
export function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@e2e.test`;
}

/** Unique series title — avoids collisions with a previous run's leftovers, if any. */
export function uniqueTitle(prefix: string): string {
  counter += 1;
  return `${prefix} ${Date.now()}-${counter}`;
}

export interface Credentials {
  displayName: string;
  email: string;
  password: string;
}

const SERIES_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Fills and submits the `/setup` first-run form. Only valid while the
 * instance has zero users — the resulting account becomes admin and the
 * form signs it in (redirecting to `/`).
 */
export async function completeSetup(page: Page, creds: Credentials): Promise<void> {
  await page.goto("/setup");
  await page.getByLabel("Display name").fill(creds.displayName);
  await page.getByLabel("Email").fill(creds.email);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("button", { name: "Create admin account" }).click();
  await expect(page).toHaveURL("/");
}

/**
 * Fills and submits `/register?invite=<token>` as a new user. `email` is
 * only typed in when the field is editable (an invite pinned to an address
 * renders it locked/prefilled).
 */
export async function registerViaInvite(
  page: Page,
  inviteUrl: string,
  creds: Pick<Credentials, "displayName" | "password"> & { email?: string },
): Promise<void> {
  const target = new URL(inviteUrl);
  await page.goto(`${target.pathname}${target.search}`);
  await page.getByLabel("Display name").fill(creds.displayName);
  if (creds.email) {
    const emailField = page.getByLabel("Email");
    if (await emailField.isEditable()) {
      await emailField.fill(creds.email);
    }
  }
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL("/");
}

/** Signs an existing user in through the `/login` UI form. */
export async function signInViaUI(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
}

/** `POST /api/admin/invites` — call with a request context that carries an admin session. */
export async function createInvite(
  request: APIRequestContext,
  opts: { role?: "admin" | "member"; expiresInDays?: number; email?: string } = {},
): Promise<{ url: string; id: string }> {
  const data: Record<string, unknown> = {
    role: opts.role ?? "member",
    expiresInDays: opts.expiresInDays ?? 7,
  };
  if (opts.email) data.email = opts.email;
  const res = await request.post("/api/admin/invites", { data });
  if (!res.ok()) {
    throw new Error(`createInvite failed: ${res.status()} ${await res.text()}`);
  }
  return res.json();
}

export interface ManualSeriesInput {
  title: string;
  /** Option label, e.g. "Manhwa" (see MEDIA_TYPE_LABELS). */
  mediaType?: string;
  /** Option label, e.g. "Reading" (see READING_STATUS_LABELS). */
  status?: string;
  currentChapter?: string;
}

/**
 * Drives `/add` → Manual tab → fill → submit, and returns the new series id
 * parsed from the resulting `/series/<id>` redirect (see useCreateSeries in
 * src/hooks/use-series.ts).
 */
export async function addSeriesManually(page: Page, input: ManualSeriesInput): Promise<string> {
  await page.goto("/add");
  await page.getByRole("tab", { name: "Manual" }).click();
  // getByRole (not getByLabel): the "Title" field is `required`, so its
  // <label> renders a trailing " *" marker (src/components/ui/label.tsx) —
  // that text is inside the label element itself, so getByLabel("Title")
  // never equals it exactly, while the marker's aria-hidden span is (rightly)
  // excluded from the accessible name getByRole matches against, and
  // disambiguates it from "Original title" the same way.
  await page.getByRole("textbox", { name: "Title", exact: true }).fill(input.title);
  if (input.mediaType) {
    await page.getByLabel("Type").selectOption({ label: input.mediaType });
  }
  if (input.status) {
    await page.getByLabel("Your status").selectOption({ label: input.status });
  }
  if (input.currentChapter !== undefined) {
    await page.getByLabel("Current chapter").fill(input.currentChapter);
  }
  await page.getByRole("button", { name: "Add to library" }).click();
  await page.waitForURL(/\/series\/.+/);
  const match = page.url().match(SERIES_ID_RE);
  if (!match) {
    throw new Error(`Unexpected URL after creating series: ${page.url()}`);
  }
  return match[0];
}

interface NotificationItem {
  type: string;
  title: string;
  message: string;
  seriesId: string | null;
}

/**
 * Polls `GET /api/notifications` (the same endpoint the header bell polls)
 * until an item matches `predicate` or `timeoutMs` elapses.
 */
export async function waitForNotification(
  request: APIRequestContext,
  predicate: (item: NotificationItem) => boolean,
  timeoutMs = 15_000,
): Promise<NotificationItem | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request.get("/api/notifications");
    if (res.ok()) {
      const body = (await res.json()) as { items: NotificationItem[] };
      const found = body.items.find(predicate);
      if (found) return found;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** CSS locator for a series card on `/` by its known id — unambiguous among many cards. */
export function seriesCardHref(seriesId: string): string {
  return `a[href="/series/${seriesId}"]`;
}

// ---------------------------------------------------------------------------
// Phase 2 (content/reader) fixtures
// ---------------------------------------------------------------------------

/**
 * Cross-file handoff for the admin account tracker.spec.ts's step 1 creates
 * via `/setup` (the instance's only admin — `/setup` only works once, and
 * every subsequent sign-up needs an admin-issued invite, so a later spec
 * that needs an admin session has to sign back in as this one rather than
 * create its own).
 *
 * Playwright runs every spec file assigned to a worker in that same worker's
 * Node process (verified empirically: a plain module-level export mutated by
 * one test file is visible, unchanged, to a later one in the same run), so a
 * plain mutable object is enough here — no on-disk state required. This only
 * resolves once tracker.spec.ts's "first run" step has actually executed, so
 * it only works for a spec file whose name sorts after "tracker.spec.ts" in
 * Playwright's alphabetical test-file discovery order (see content spec's
 * top-of-file comment for why it isn't literally named `content.spec.ts`).
 */
export const sharedAccounts: { admin?: Credentials } = {};

interface ChapterListItemLike {
  id: string;
  title: string;
  status: string;
  pageCount: number;
  read: boolean;
  sortIndex: number;
}

interface ChapterListResponseLike {
  chapters: ChapterListItemLike[];
  position: { chapterId: string | null; pageIndex: number } | null;
  readCount: number;
}

/**
 * Polls `GET /api/series/:id/chapters` (the same endpoint `useChapters`
 * polls) until `predicate` is satisfied — the authoritative wait for a
 * background job (upload import, etc.) to finish, independent of the UI's
 * own polling cadence. Throws with the last response body on timeout so a
 * failure is diagnosable without re-running under `--debug`.
 */
export async function pollChapterList(
  request: APIRequestContext,
  seriesId: string,
  predicate: (body: ChapterListResponseLike) => boolean,
  timeoutMs = 30_000,
): Promise<ChapterListResponseLike> {
  const deadline = Date.now() + timeoutMs;
  let last: ChapterListResponseLike | null = null;
  for (;;) {
    const res = await request.get(`/api/series/${seriesId}/chapters`);
    if (res.ok()) {
      last = (await res.json()) as ChapterListResponseLike;
      if (predicate(last)) return last;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `pollChapterList timed out after ${timeoutMs}ms for series ${seriesId}. Last body: ${JSON.stringify(last)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
}

/**
 * CSS locator (starts-with, not exact) for a link into the reader for one
 * chapter — matches the chapter row's plain "Read" link
 * (`/read?series=<id>&chapter=<id>`, see `buildReadHref` in
 * src/lib/reader-url.ts) *and* the dashboard's "Continue reading" /
 * "Start reading"/"Continue reading" links, which append `&page=<n>`.
 * Stable across title/number edits, unlike matching row text.
 */
export function chapterReadHref(seriesId: string, chapterId: string): string {
  return `a[href^="/read?series=${seriesId}&chapter=${chapterId}"]`;
}

/** A solid-colour PNG buffer at the given size, for chapter-upload fixtures (sharp is already a project dependency — see package.json). */
export async function solidPng(
  width: number,
  height: number,
  color: { r: number; g: number; b: number },
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: color },
  })
    .png()
    .toBuffer();
}
