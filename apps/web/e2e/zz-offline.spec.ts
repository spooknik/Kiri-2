import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  addSeriesManually,
  completeSetup,
  pollChapterList,
  sharedAccounts,
  signInViaUI,
  solidPng,
  uniqueEmail,
  uniqueTitle,
} from "./helpers";

/**
 * Phase 5 offline/PWA walkthrough: download a series, pull the plug, and read
 * it — then plug back in and watch the reading progress land on the server.
 *
 * WHY THE FILE IS NAMED `zz-offline.spec.ts`
 * ------------------------------------------
 * Playwright discovers spec files in alphabetical order within `testDir`
 * (`collectFiles` in playwright/lib/runner/index.js sorts by name), and this
 * file signs in as the admin account `tracker.spec.ts` step 1 creates through
 * `/setup` (see `sharedAccounts` in helpers.ts). A file literally named
 * `offline.spec.ts` would sort before `smoke.spec.ts` and `tracker.spec.ts`
 * (`o` < `s` < `t`) and run first against a still-empty database: there would
 * be no admin to sign in as, and creating one here would break smoke.spec.ts's
 * "fresh database, zero users, `/` redirects to `/setup`" assumption. The `zz-`
 * prefix is the same trick `upload-content.spec.ts` documents for the same
 * reason — it sorts after every existing spec without editing any of them.
 *
 * Run on its own (`npx playwright test e2e/zz-offline.spec.ts`) the global
 * setup still boots a *fresh* database, so `beforeAll` falls back to running
 * `/setup` itself. In a full run `sharedAccounts.admin` is already set and that
 * branch never fires.
 *
 * WHAT THIS PROVES
 * ----------------
 *  - `/sw.js` and `/manifest.json` are actually served, and `start_url` is `/`;
 *  - the service worker installs, activates and claims the page;
 *  - "Download for offline" fills CacheStorage and writes a `ready` catalog row
 *    in IndexedDB;
 *  - with the network cut, `/` still renders Kiri (never the browser's error
 *    page) and `/read` renders a real page image out of the cache;
 *  - reading to the end offline queues a sync op instead of losing it;
 *  - coming back online drains that queue: the server ends up with the chapter
 *    read and the reading position saved;
 *  - the hub lists the download and "Remove" clears it.
 *
 * The series is created as MANHWA so the reader defaults to vertical strip mode
 * (`STRIP_MEDIA_TYPES` in src/lib/reader/prefs.ts) — scrolling that strip to the
 * bottom is how this file reaches the last page, exactly as upload-content does.
 */

interface CatalogRow {
  seriesId: string;
  title: string;
  state: string;
  downloadedBytes: number;
  chapters: { id: string; state: string }[];
}

/** Read the offline catalog straight out of IndexedDB in the page. */
async function readCatalog(page: Page): Promise<CatalogRow[]> {
  return page.evaluate(
    () =>
      new Promise<CatalogRow[]>((resolve) => {
        const request = indexedDB.open("kiri-offline");
        request.onerror = () => resolve([]);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("catalog")) {
            db.close();
            resolve([]);
            return;
          }
          const all = db.transaction("catalog", "readonly").objectStore("catalog").getAll();
          all.onsuccess = () => {
            resolve(all.result as CatalogRow[]);
            db.close();
          };
          all.onerror = () => {
            resolve([]);
            db.close();
          };
        };
      }),
  );
}

/**
 * The coalescing keys of everything waiting in the sync queue
 * (`position:<seriesId>`, `chapterRead:<chapterId>`, `note:<noteId>` — see
 * `coalesceKey` in src/lib/offline/sync-queue.ts).
 */
async function readPendingOpKeys(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const request = indexedDB.open("kiri-offline");
        request.onerror = () => resolve([]);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("ops")) {
            db.close();
            resolve([]);
            return;
          }
          const all = db.transaction("ops", "readonly").objectStore("ops").getAll();
          all.onsuccess = () => {
            resolve((all.result as { key: string }[]).map((row) => row.key));
            db.close();
          };
          all.onerror = () => {
            resolve([]);
            db.close();
          };
        };
      }),
  );
}

test.describe.serial("Kiri offline/PWA walkthrough", () => {
  let context: BrowserContext;
  let page: Page;
  let tmpDir: string;

  let seriesId: string;
  let chapterId: string;

  const SERIES_TITLE = uniqueTitle("E2E Offline Series");

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    tmpDir = await mkdtemp(path.join(tmpdir(), "kiri-e2e-offline-"));

    if (sharedAccounts.admin) {
      await signInViaUI(page, sharedAccounts.admin.email, sharedAccounts.admin.password);
    } else {
      // Running this file on its own: the global setup booted a fresh database,
      // so `/setup` is still available and creates the admin.
      const admin = {
        displayName: "Offline Admin",
        email: uniqueEmail("offline-admin"),
        password: "OfflinePassw0rd!",
      };
      await completeSetup(page, admin);
      sharedAccounts.admin = admin;
    }
  });

  test.afterAll(async () => {
    // Leave the browser online whatever happened above, so teardown can talk to
    // the server.
    if (context) await context.setOffline(false).catch(() => {});
    await page?.close();
    await context?.close();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  test("1. PWA assets: /manifest.json and /sw.js are served, start_url is /", async () => {
    const manifestRes = await page.request.get("/manifest.json");
    expect(manifestRes.status()).toBe(200);
    const manifest = (await manifestRes.json()) as {
      start_url: string;
      display: string;
      icons: { src: string }[];
    };
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons.length).toBeGreaterThan(0);

    // Built by `serwist build` after `next build`; `next start` serves it from
    // public/. A 404 here means offline mode is entirely absent.
    const swRes = await page.request.get("/sw.js");
    expect(swRes.status()).toBe(200);
    expect(await swRes.text()).toContain("reader-images");
  });

  test("2. seed content: a MANHWA series with one 3-page chapter", async () => {
    seriesId = await addSeriesManually(page, {
      title: SERIES_TITLE,
      mediaType: "Manhwa",
      status: "Reading",
    });

    const colors = [
      { r: 210, g: 60, b: 60 },
      { r: 60, g: 190, b: 90 },
      { r: 60, g: 90, b: 210 },
    ];
    const paths = await Promise.all(
      colors.map(async (color, i) => {
        const buffer = await solidPng(400, 600, color);
        const filePath = path.join(tmpDir, `offline-page-${i + 1}.png`);
        await writeFile(filePath, buffer);
        return filePath;
      }),
    );

    await page.getByRole("button", { name: "Upload chapter" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Upload chapter" })).toBeVisible();
    await dialog.getByRole("textbox", { name: "Title", exact: true }).fill("Offline Chapter 1");
    await dialog.getByLabel("Number").fill("1");
    await dialog.getByLabel("File", { exact: true }).setInputFiles(paths);
    await dialog.getByRole("button", { name: "Upload" }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    const list = await pollChapterList(
      page.request,
      seriesId,
      (body) => body.chapters.length === 1 && body.chapters[0]?.status === "COMPLETED",
    );
    chapterId = list.chapters[0]!.id;
    expect(list.chapters[0]!.pageCount).toBe(3);
  });

  test("3. service worker: installs, activates and takes control of the page", async () => {
    // Visit the dashboard while online so the `pages` cache has a copy of "/"
    // — the cold-launch document for the installed PWA.
    await page.goto("/");
    await expect(page.locator(`a[href="/series/${seriesId}"]`)).toBeVisible();

    const state = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return registration.active?.state ?? "none";
    });
    expect(state).toBe("activated");

    // clientsClaim means the already-open page ends up controlled too.
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, {
      timeout: 15_000,
    });

    // One more navigation, now definitely handled by the worker, so "/" and the
    // series page are both in the `pages` cache.
    await page.goto(`/series/${seriesId}`);
    await page.goto("/");
    await page.goto(`/series/${seriesId}`);
  });

  test("4. download: 'Download for offline' fills the caches and the catalog", async () => {
    await page.getByRole("button", { name: "Download for offline" }).click();

    await expect
      .poll(async () => (await readCatalog(page)).find((row) => row.seriesId === seriesId)?.state, {
        timeout: 30_000,
        message: "the catalog row never reached the ready state",
      })
      .toBe("ready");

    const row = (await readCatalog(page)).find((entry) => entry.seriesId === seriesId);
    expect(row?.title).toBe(SERIES_TITLE);
    expect(row?.chapters).toHaveLength(1);
    expect(row?.chapters[0]?.state).toBe("ready");
    expect(row?.downloadedBytes).toBeGreaterThan(0);

    // The control itself reflects it (scoped: a success toast with the same
    // words is on screen at the same moment).
    await expect(
      page.getByTestId("download-control").getByText(/Available offline ·/),
    ).toBeVisible();

    // Every page image is in `reader-images`, keyed by the URL the reader asks for.
    const cachedImages = await page.evaluate(async (id: string) => {
      const response = await fetch(`/api/series/${id}/offline-manifest`, { cache: "no-store" });
      const manifest = (await response.json()) as {
        chapters: { pages: { url: string }[] }[];
      };
      const cache = await caches.open("reader-images");
      const found = await Promise.all(
        manifest.chapters
          .flatMap((chapter) => chapter.pages)
          .map(async (image) => Boolean(await cache.match(image.url, { ignoreVary: true }))),
      );
      return { total: found.length, cached: found.filter(Boolean).length };
    }, seriesId);
    expect(cachedImages.total).toBe(3);
    expect(cachedImages.cached).toBe(3);
  });

  test("5. offline: '/' still renders Kiri instead of the browser error page", async () => {
    await context.setOffline(true);

    const response = await page.goto("/");
    // A served response (from the service worker) — not a net::ERR page.
    expect(response, "navigating to / offline produced no response at all").not.toBeNull();

    // Either the cached library shell or the offline hub is acceptable; what is
    // not acceptable is Chromium's "No internet" page, which has neither.
    const shell = page.getByRole("navigation", { name: "Primary" });
    const hub = page.getByRole("heading", { name: "Offline", exact: true });
    await expect
      .poll(async () => (await shell.isVisible()) || (await hub.isVisible()), {
        timeout: 15_000,
        message: "offline / rendered neither the app shell nor the offline hub",
      })
      .toBe(true);
  });

  test("6. offline reading: the reader loads a page image from the cache", async () => {
    // Same URL `buildReadHref` produces for the series page's "Read" link.
    await page.goto(`/read?series=${seriesId}&chapter=${chapterId}`);
    await page.waitForFunction(
      () => {
        const img = document.querySelector('img[src*="/api/pages/"]') as HTMLImageElement | null;
        return Boolean(img && img.complete && img.naturalWidth > 0);
      },
      null,
      { timeout: 20_000 },
    );

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
        { timeout: 15_000, message: "the chapter end card never appeared offline" },
      )
      .toBe(true);
  });

  test("7. offline writes: reaching the end queues sync ops instead of losing them", async () => {
    // Both writes the reader makes at the end of a chapter must be queued: the
    // read marker (immediate) and the reading position (600 ms debounce, see
    // PROGRESS_DEBOUNCE_MS). Waiting for both here is also what keeps the
    // navigation below from racing the debounce.
    await expect
      .poll(
        async () => {
          const keys = await readPendingOpKeys(page);
          return {
            position: keys.some((key) => key.startsWith("position:")),
            chapterRead: keys.some((key) => key.startsWith("chapterRead:")),
          };
        },
        { timeout: 15_000, message: "reading to the end offline queued nothing" },
      )
      .toEqual({ position: true, chapterRead: true });

    // The hub surfaces the same number.
    await page.goto("/offline");
    await expect(page.getByRole("heading", { name: "Offline", exact: true })).toBeVisible();
    await expect(page.getByText("You're offline")).toBeVisible();
    await expect(page.getByTestId("pending-sync")).toHaveAttribute("data-pending", /[2-9]/);
    await expect(page.locator(`[data-series-id="${seriesId}"]`)).toContainText(SERIES_TITLE);
  });

  test("8. back online: the queue drains and the server has the progress", async () => {
    await context.setOffline(false);
    // The `online` event reaches OfflineBootstrap, which flushes.
    await expect
      .poll(async () => (await readPendingOpKeys(page)).length, {
        timeout: 30_000,
        message: "the sync queue never drained",
      })
      .toBe(0);

    const list = await pollChapterList(
      page.request,
      seriesId,
      (body) => body.chapters[0]?.read === true && body.position?.chapterId === chapterId,
      20_000,
    );
    expect(list.chapters[0]!.read).toBe(true);
    expect(list.position?.chapterId).toBe(chapterId);
    // Three pages, 0-based: the last page is index 2.
    expect(list.position?.pageIndex).toBe(2);

    await expect(page.getByTestId("pending-sync")).toHaveAttribute("data-pending", "0");
  });

  test("9. hub: Remove clears the download", async () => {
    await page.goto("/offline");
    const card = page.locator(`[data-series-id="${seriesId}"]`);
    await expect(card).toBeVisible();

    await card.getByRole("button", { name: `Remove ${SERIES_TITLE} from offline storage` }).click();

    await expect(card).toHaveCount(0);
    await expect
      .poll(async () => (await readCatalog(page)).some((row) => row.seriesId === seriesId), {
        timeout: 10_000,
        message: "the catalog row survived Remove",
      })
      .toBe(false);
    await expect(page.getByText("Nothing downloaded yet")).toBeVisible();
  });
});
