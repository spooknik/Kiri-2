import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  addSeriesManually,
  completeSetup,
  createInvite,
  registerViaInvite,
  seriesCardHref,
  sharedAccounts,
  uniqueEmail,
  waitForNotification,
} from "./helpers";

/**
 * Phase 1 tracker walkthrough, run as one ordered story against the shared
 * database the global setup boots fresh for this run (see
 * e2e/global-setup.ts). `playwright.config.ts` runs the whole suite with
 * `workers: 1` / `fullyParallel: false`, and `test.describe.serial` below
 * additionally stops the file at the first failing step, since every step
 * depends on state the previous one created (admin account, invite, series,
 * chapter progress, ...).
 *
 * Two browser contexts are kept open for the whole file — `adminPage` (the
 * first account, created in step 1) and `memberPage` (the invited account,
 * created in step 2) — so their sessions persist exactly like two people
 * using the app side by side.
 */
test.describe.serial("Kiri tracker walkthrough", () => {
  let adminContext: BrowserContext;
  let memberContext: BrowserContext;
  let adminPage: Page;
  let memberPage: Page;

  let inviteUrl: string;
  let seriesId: string;
  let privateSeriesId: string;

  const SERIES_TITLE = "E2E Test Series";

  const admin = {
    displayName: "Admin One",
    email: uniqueEmail("admin"),
    password: "AdminPassw0rd!",
  };
  const member = {
    displayName: "Member One",
    email: uniqueEmail("member"),
    password: "MemberPassw0rd!",
  };

  test.beforeAll(async ({ browser }) => {
    adminContext = await browser.newContext();
    adminPage = await adminContext.newPage();
  });

  test.afterAll(async () => {
    await adminPage?.close();
    await adminContext?.close();
    await memberPage?.close();
    await memberContext?.close();
  });

  test("1. first run: / lands on /setup, creating the admin signs in to an empty library", async () => {
    await adminPage.goto("/");
    await expect(adminPage).toHaveURL(/\/setup$/);
    await expect(adminPage.getByRole("heading", { name: "Welcome to Kiri" })).toBeVisible();

    await completeSetup(adminPage, admin);

    await expect(adminPage).toHaveURL("/");
    await expect(adminPage.getByText("Your library is empty")).toBeVisible();

    // Hand these off for any later spec file that needs an admin session:
    // `/setup` only works once (zero users), so a second admin account can
    // never be created again on this database. See `sharedAccounts` in
    // helpers.ts.
    sharedAccounts.admin = admin;
  });

  test("2. invite flow: admin invites a member; registering without an invite is refused", async ({
    browser,
  }) => {
    const invite = await createInvite(adminPage.request, { role: "member", expiresInDays: 7 });
    expect(invite.url).toContain("/register?invite=");
    inviteUrl = invite.url;

    memberContext = await browser.newContext();
    memberPage = await memberContext.newPage();
    await registerViaInvite(memberPage, inviteUrl, member);

    await expect(memberPage).toHaveURL("/");
    await expect(memberPage.getByText("Your library is empty")).toBeVisible();

    // Registering with no invite at all: the /register screen itself refuses.
    // Reuses adminPage rather than opening a third context — session state
    // doesn't matter for this check (the page decides from user count +
    // registration mode, not who's signed in), and test 3 navigates adminPage
    // elsewhere immediately anyway.
    await adminPage.goto("/register");
    await expect(
      adminPage.getByText("This instance is invite only. Ask an admin for an invite link."),
    ).toBeVisible();

    // ...and the underlying endpoint refuses it too (403), independent of the UI.
    const rejected = await adminPage.request.post("/api/auth/sign-up/email", {
      data: {
        name: "No Invite",
        displayName: "No Invite",
        email: uniqueEmail("noinvite"),
        password: "NoInvitePassw0rd!",
      },
    });
    expect(rejected.status()).toBe(403);
  });

  test("3. add series: manual form creates the series and an initial entry", async () => {
    seriesId = await addSeriesManually(adminPage, {
      title: SERIES_TITLE,
      mediaType: "Manhwa",
      status: "Reading",
      currentChapter: "3",
    });

    await expect(adminPage).toHaveURL(new RegExp(`/series/${seriesId}$`));
    await expect(adminPage.getByRole("heading", { name: SERIES_TITLE })).toBeVisible();
    await expect(adminPage.getByRole("heading", { name: "My progress" })).toBeVisible();
    await expect(adminPage.getByLabel("Current chapter")).toHaveValue("3");
  });

  test("4. progress: +1 chapter persists on the series page and on the library card", async () => {
    await adminPage.getByRole("button", { name: "+1 chapter" }).click();
    await expect(adminPage.getByLabel("Current chapter")).toHaveValue("4");

    await adminPage.reload();
    await expect(adminPage.getByLabel("Current chapter")).toHaveValue("4");

    await adminPage.goto("/");
    const card = adminPage.locator(seriesCardHref(seriesId));
    await expect(card).toBeVisible();
    await expect(card.getByText("Reading", { exact: true })).toBeVisible();
    await expect(card.getByText(/Ch\.\s*4\b/)).toBeVisible();

    await card.getByRole("button", { name: "+1 chapter" }).click();
    await expect(card.getByText(/Ch\.\s*5\b/)).toBeVisible();
  });

  test("5. sharing: the member tracks the admin's series; both show up in Members", async () => {
    await memberPage.goto("/");
    // The member isn't tracking anything yet, and the library defaults to
    // "Mine" (see DEFAULT_LIBRARY_FILTERS.scope = "tracked" in
    // src/lib/library-filters.ts), so switch to "All" to see shared series.
    await expect(memberPage.getByText(/\d+ series/)).toBeVisible();
    await memberPage.getByRole("switch", { name: "All", exact: true }).click();

    const card = memberPage.locator(seriesCardHref(seriesId));
    await expect(card).toBeVisible();
    await card.click();
    await expect(memberPage).toHaveURL(new RegExp(`/series/${seriesId}$`));

    await expect(memberPage.getByRole("heading", { name: "Track this series" })).toBeVisible();
    await memberPage.getByLabel("Starting status").selectOption({ label: "Reading" });
    await memberPage.getByRole("button", { name: "Track this series" }).click();
    await expect(memberPage.getByRole("heading", { name: "My progress" })).toBeVisible();

    await adminPage.goto(`/series/${seriesId}`);
    await expect(adminPage.getByRole("heading", { name: "Members" })).toBeVisible();
    // Each member row is an <li> carrying its own "Updated <relative time>"
    // text (src/components/series/members-card.tsx) — a stable anchor to
    // scope the name lookup so it can't match the "Added by ..." byline.
    const memberRows = adminPage.locator("li", { hasText: "Updated" });
    await expect(memberRows.filter({ hasText: admin.displayName })).toHaveCount(1);
    await expect(memberRows.filter({ hasText: member.displayName })).toHaveCount(1);
  });

  test("6. privacy: a private series is invisible to the member", async () => {
    const title = "E2E Private Series";
    const created = await adminPage.request.post("/api/series", {
      data: { title, visibility: "PRIVATE" },
    });
    expect(created.ok()).toBeTruthy();
    privateSeriesId = ((await created.json()) as { id: string }).id;

    const memberGet = await memberPage.request.get(`/api/series/${privateSeriesId}`);
    expect(memberGet.status()).toBe(404);

    const memberLibrary = await memberPage.request.get("/api/library?scope=all&limit=100");
    expect(memberLibrary.ok()).toBeTruthy();
    const body = (await memberLibrary.json()) as { items: { title: string }[] };
    expect(body.items.some((item) => item.title === title)).toBe(false);
  });

  test("7. book club: flipping the switch notifies the member", async () => {
    await adminPage.goto(`/series/${seriesId}`);
    await adminPage.getByRole("button", { name: "Edit" }).click();

    const dialog = adminPage.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Edit series" })).toBeVisible();
    await dialog.getByRole("switch", { name: "Book club" }).click();
    await dialog.getByRole("button", { name: "Save changes" }).click();

    // The edit dialog closes itself on success (src/components/series/edit-series-dialog.tsx
    // calls onClose() in the mutation's onSuccess).
    await expect(dialog).toBeHidden();
    // Scoped to <span> — the dialog's own "Book club" switch label (a
    // <label>, not a <span>) stays mounted in the DOM even once the dialog
    // is hidden, so a bare getByText("Book club") is a strict-mode
    // violation regardless of the wait above.
    await expect(adminPage.locator("span", { hasText: "Book club" })).toBeVisible();

    const notification = await waitForNotification(
      memberPage.request,
      (item) => item.type === "BOOK_CLUB_ADDED" && item.seriesId === seriesId,
    );
    expect(notification).not.toBeNull();
    expect(notification?.title.toLowerCase()).toContain("book club");

    await memberPage.goto("/");
    const card = memberPage.locator(seriesCardHref(seriesId));
    await expect(card.getByText("Book club")).toBeVisible();
  });

  test("8. delete: the admin removes the series; it disappears for everyone", async () => {
    await adminPage.goto(`/series/${seriesId}`);
    // Only the danger-zone trigger matches "Delete series" while the confirm
    // dialog is closed, so this click is unambiguous.
    await adminPage.getByRole("button", { name: "Delete series" }).click();

    const dialog = adminPage.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: `Delete ${SERIES_TITLE}?` })).toBeVisible();
    await dialog.getByRole("button", { name: "Delete series" }).click();

    await expect(adminPage).toHaveURL("/");
    await expect(adminPage.locator(seriesCardHref(seriesId))).toHaveCount(0);

    const memberGet = await memberPage.request.get(`/api/series/${seriesId}`);
    expect(memberGet.status()).toBe(404);
  });
});
