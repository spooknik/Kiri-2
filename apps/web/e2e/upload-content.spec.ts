import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { buildZip } from "../test/zip-fixture";
import {
  addSeriesManually,
  chapterReadHref,
  pollChapterList,
  sharedAccounts,
  signInViaUI,
  solidPng,
  uniqueTitle,
} from "./helpers";

/**
 * Phase 2 content/reader walkthrough: create a MANHWA series, upload a
 * chapter as loose images, read it in the strip reader to the end, upload a
 * second chapter as a zip (which exercises the importer's natural sort
 * across archive entries), edit that chapter, then delete it. A last,
 * optional step checks both uploads show up as succeeded jobs on the admin
 * jobs dashboard.
 *
 * Deliberately named `upload-content.spec.ts`, not `content.spec.ts`:
 * Playwright's test-file discovery sorts spec files alphabetically within
 * `testDir` (verified against the installed package —
 * `node_modules/playwright/lib/runner/index.js`'s `collectFiles` does
 * `entries.sort((a, b) => a.name.localeCompare(b.name))`), and this file
 * signs in as the admin account tracker.spec.ts's step 1 creates via
 * `/setup` (see `sharedAccounts` in helpers.ts) instead of creating its own
 * — `/setup` only works once per (fresh) database, and every sign-up after
 * that needs an admin-issued invite, which this file has no session to
 * request without an existing admin. `content.spec.ts` would sort *before*
 * both `smoke.spec.ts` and `tracker.spec.ts` (`c` < `s` < `t`), which would
 * run it first against a still-empty database: there would be no admin to
 * sign in as yet, and creating one here would break smoke.spec.ts's "fresh
 * database, zero users, `/` redirects to `/setup`" assumption for the run
 * that follows. `upload-content.spec.ts` (`u` > `t`) sorts after both
 * without editing either existing spec's content or their own ordering.
 *
 * The series is created as MANHWA so the reader defaults to the vertical
 * "strip" mode (`STRIP_MEDIA_TYPES` in src/lib/reader/prefs.ts) — scrolling
 * to the bottom of the strip is how this file reaches the chapter end card.
 */
test.describe.serial("Kiri content/reader walkthrough", () => {
  let adminContext: BrowserContext;
  let page: Page;
  let tmpDir: string;

  let seriesId: string;
  let chapter1Id: string;
  let chapter2Id: string;

  const SERIES_TITLE = uniqueTitle("E2E Content Series");

  test.beforeAll(async ({ browser }) => {
    if (!sharedAccounts.admin) {
      throw new Error(
        "sharedAccounts.admin is unset — tracker.spec.ts's step 1 must run before this file. " +
          "See this file's top comment for why it must sort after tracker.spec.ts.",
      );
    }
    adminContext = await browser.newContext();
    page = await adminContext.newPage();
    await signInViaUI(page, sharedAccounts.admin.email, sharedAccounts.admin.password);
    tmpDir = await mkdtemp(path.join(tmpdir(), "kiri-e2e-content-"));
  });

  test.afterAll(async () => {
    await page?.close();
    await adminContext?.close();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  test("1. create series: manual form creates a MANHWA series with an empty chapters section", async () => {
    seriesId = await addSeriesManually(page, {
      title: SERIES_TITLE,
      mediaType: "Manhwa",
      status: "Reading",
    });

    await expect(page.getByRole("heading", { name: SERIES_TITLE })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Chapters" })).toBeVisible();
    await expect(page.getByText("No chapters yet.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload chapter" })).toBeVisible();
    // No readable chapter yet, so ChaptersSection renders no
    // "Start reading"/"Continue reading" CTA (buildContinueReadingHref
    // returns null — src/lib/reader-url.ts). The CTA is a Button with an
    // `href` (src/components/ui/button.tsx renders a Next Link for that),
    // so it's a "link", not a "button", once it does appear.
    await expect(page.getByRole("link", { name: /reading$/ })).toHaveCount(0);
  });

  test("2. upload chapter 1: three loose PNGs process into a 3-page chapter", async () => {
    const colors = [
      { r: 220, g: 40, b: 40 },
      { r: 40, g: 180, b: 60 },
      { r: 40, g: 90, b: 220 },
    ];
    const paths = await Promise.all(
      colors.map(async (color, i) => {
        const buffer = await solidPng(400, 600, color);
        const filePath = path.join(tmpDir, `page-${i + 1}.png`);
        await writeFile(filePath, buffer);
        return filePath;
      }),
    );

    await page.getByRole("button", { name: "Upload chapter" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Upload chapter" })).toBeVisible();
    // "Title" is `required`, so its <label> (src/components/ui/label.tsx)
    // renders a trailing " *" in an aria-hidden span: excluded from the
    // accessible *name* getByRole computes (so this matches "Title"
    // exactly), but not from the raw label text getByLabel matches against
    // (so getByLabel("Title", { exact: true }) never resolves) — same
    // reasoning as addSeriesManually's Title lookup in helpers.ts.
    await dialog.getByRole("textbox", { name: "Title", exact: true }).fill("Chapter 1");
    await dialog.getByLabel("Number").fill("1");
    await dialog.getByLabel("File", { exact: true }).setInputFiles(paths);
    await dialog.getByRole("button", { name: "Upload" }).click();

    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // Best-effort: JobStatusStrip (src/components/jobs/job-status-strip.tsx)
    // only renders QUEUED/RUNNING/FAILED jobs, and the runner starts
    // processing immediately on enqueue (triggerJobProcessing() in
    // src/app/api/series/[id]/chapters/import/route.ts) — three tiny local
    // PNGs can finish before the strip's own poll (useSeriesJobs, 3s
    // interval) ever observes a QUEUED/RUNNING row. So this checks for it
    // without failing the test when it's missed; the API poll below is the
    // authoritative wait.
    const jobStripSeen = await page
      .getByText("Chapter upload")
      .first()
      .isVisible()
      .catch(() => false);
    test.info().annotations.push({
      type: "job-strip-observed",
      description: String(jobStripSeen),
    });

    const list = await pollChapterList(
      page.request,
      seriesId,
      (body) => body.chapters.length === 1 && body.chapters[0]?.status === "COMPLETED",
    );
    chapter1Id = list.chapters[0]!.id;
    expect(list.chapters[0]!.pageCount).toBe(3);

    await page.goto(`/series/${seriesId}`);
    const row = page
      .locator("li")
      .filter({ has: page.locator(chapterReadHref(seriesId, chapter1Id)) });
    await expect(row).toContainText("Chapter 1");
    await expect(row).toContainText("3 pages");
  });

  test("3. read chapter 1 to the end: reader shows a page image, marks it read, saves position", async () => {
    const row = page
      .locator("li")
      .filter({ has: page.locator(chapterReadHref(seriesId, chapter1Id)) });
    await row.locator(chapterReadHref(seriesId, chapter1Id)).click();
    await page.waitForURL(new RegExp(`/read\\?series=${seriesId}&chapter=${chapter1Id}`));

    await page.waitForFunction(() => {
      const img = document.querySelector('img[src*="/api/pages/"]') as HTMLImageElement | null;
      return Boolean(img && img.complete && img.naturalWidth > 0);
    });

    // MANHWA defaults to strip mode (src/lib/reader/prefs.ts), whose
    // scrollable container carries data-testid="strip-scroll"
    // (src/components/reader/strip-view.tsx) and appends the end card
    // (data-testid="chapter-end-card", chapter-end-card.tsx) right after the
    // last page inside the same scroller.
    const strip = page.getByTestId("strip-scroll");
    await expect(strip).toBeVisible();
    const endCard = page.getByTestId("chapter-end-card");
    await expect
      .poll(
        async () => {
          await strip.evaluate((el) => {
            el.scrollTop = el.scrollHeight;
          });
          return endCard.isVisible();
        },
        {
          timeout: 10_000,
          message: "chapter end card never became visible after scrolling to bottom",
        },
      )
      .toBe(true);
    // Single chapter in this series, so there's no next chapter.
    await expect(endCard).toContainText("You're caught up");

    // Reaching the last page marks the chapter read automatically
    // (src/hooks/use-reader.ts); position saves on a 600 ms debounce
    // (src/lib/reader/progress.ts) — both PUTs are independent of any
    // button click.
    const list = await pollChapterList(
      page.request,
      seriesId,
      (body) => body.chapters[0]?.read === true && body.position?.chapterId === chapter1Id,
      10_000,
    );
    expect(list.chapters[0]!.read).toBe(true);
    expect(list.position?.chapterId).toBe(chapter1Id);
  });

  test("4. series page shows the read state; dashboard shows Continue reading", async () => {
    await page.goto(`/series/${seriesId}`);
    const row = page
      .locator("li")
      .filter({ has: page.locator(chapterReadHref(seriesId, chapter1Id)) });
    await expect(row.getByRole("button", { name: "Mark as unread" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Continue reading" })).toBeVisible();

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Continue reading" })).toBeVisible();
    const continueLink = page.locator(chapterReadHref(seriesId, chapter1Id));
    await expect(continueLink).toBeVisible();
    await expect(continueLink).toContainText(SERIES_TITLE);
  });

  test("5. upload chapter 2 as a zip: archive entries land in natural (not archive/lexicographic) order", async () => {
    // The task's literal example filenames (b-2.png / a-10.png / c-1.png)
    // don't actually exercise natural-vs-lexicographic ordering: the real
    // algorithm (naturalCompare, src/lib/uploads/archive.ts:65) tokenizes
    // each name into alternating digit/non-digit runs and compares them
    // left to right, so the very first token — the differing leading letter
    // "a"/"b"/"c" — already decides the order under *both* a naive string
    // sort and the real natural sort, giving the identical result
    // (a-10, b-2, c-1) either way. Using a shared "page-" prefix instead
    // makes the digit run the deciding token, which is what actually proves
    // natural sort (2 before 10) beats naive lexicographic sort (which
    // would put "page-10" before "page-2").
    const entries = [
      { name: "page-2.png", width: 301 },
      { name: "page-10.png", width: 302 },
      { name: "page-1.png", width: 300 },
    ];
    const zipEntries = await Promise.all(
      entries.map(async (entry) => ({
        name: entry.name,
        data: await solidPng(entry.width, 400, { r: 120, g: 60, b: 200 }),
      })),
    );
    const zipBuffer = buildZip(zipEntries);

    await page.goto(`/series/${seriesId}`);
    await page.getByRole("button", { name: "Upload chapter" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Upload chapter" })).toBeVisible();
    await dialog.getByRole("textbox", { name: "Title", exact: true }).fill("Chapter 2");
    await dialog.getByLabel("Number").fill("2");
    await dialog
      .getByLabel("File", { exact: true })
      .setInputFiles({ name: "chapter-2.zip", mimeType: "application/zip", buffer: zipBuffer });
    await dialog.getByRole("button", { name: "Upload" }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    const list = await pollChapterList(
      page.request,
      seriesId,
      (body) =>
        body.chapters.length === 2 &&
        body.chapters.every((c) => c.status === "COMPLETED" || c.title !== "Chapter 2"),
    );
    const chapter2 = list.chapters.find((c) => c.title === "Chapter 2");
    expect(chapter2).toBeTruthy();
    chapter2Id = chapter2!.id;
    expect(chapter2!.pageCount).toBe(3);

    const detailRes = await page.request.get(`/api/chapters/${chapter2Id}`);
    expect(detailRes.ok()).toBeTruthy();
    const detail = (await detailRes.json()) as { pages: { width: number | null }[] };
    expect(detail.pages.map((p) => p.width)).toEqual([300, 301, 302]);
  });

  test("6. edit chapter 2's title, then delete it", async () => {
    await page.goto(`/series/${seriesId}`);
    const row = page
      .locator("li")
      .filter({ has: page.locator(chapterReadHref(seriesId, chapter2Id)) });

    await row.getByRole("button", { name: "Chapter actions" }).click();
    await row.getByRole("menuitem", { name: "Edit" }).click();

    const editDialog = page.getByRole("dialog");
    await expect(editDialog.getByRole("heading", { name: "Edit chapter" })).toBeVisible();
    // One EditChapterDialog is mounted per chapter row; field ids are unique
    // via useId, so scope the lookup to the open dialog and match by role.
    await editDialog.getByRole("textbox", { name: "Title", exact: true }).fill("Chapter Two");
    await editDialog.getByRole("button", { name: "Save changes" }).click();
    await expect(editDialog).toBeHidden();

    await expect(row).toContainText("Chapter Two");

    await row.getByRole("button", { name: "Chapter actions" }).click();
    await row.getByRole("menuitem", { name: "Delete" }).click();

    const deleteDialog = page.getByRole("dialog");
    await expect(
      deleteDialog.getByRole("heading", { name: 'Delete "Chapter Two"?' }),
    ).toBeVisible();
    await deleteDialog.getByRole("button", { name: "Delete chapter" }).click();
    await expect(deleteDialog).toBeHidden();

    await expect(row).toHaveCount(0);
    const detailRes = await page.request.get(`/api/chapters/${chapter2Id}`);
    expect(detailRes.status()).toBe(404);
  });

  test("7. (optional) /admin/jobs lists both chapter uploads as succeeded", async () => {
    await page.goto("/admin/jobs");
    // Default filter is "Active" (QUEUED/RUNNING) — see AdminJobsView; both
    // of this series' jobs are SUCCEEDED by now, so switch to "All".
    await page.getByRole("switch", { name: "All", exact: true }).click();

    await expect(page.locator(`a[href="/series/${seriesId}"]`)).toHaveCount(2);
    await expect(page.getByText("Chapter upload")).toHaveCount(2);
    await expect(page.getByText("Succeeded")).toHaveCount(2);
  });
});
