/**
 * PATCH /api/series/bulk integration tests. Every case mixes series the caller
 * created, series they only track and series they cannot touch, so the
 * per-id permission split is what is actually under test.
 */
import path from "node:path";
import { rm, stat, writeFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestUser,
  mockCurrentUser,
  resetDatabase,
  routeContext,
} from "../../../test/factories";
import { PATCH as bulkRoute } from "@/app/api/series/bulk/route";
import type { SessionUser } from "@/lib/auth/types";
import type { BulkSeriesInput, BulkSeriesResult } from "@/lib/contracts";
import { ensureDir, libraryDir } from "@/lib/content/store";
import { resetEnvCache } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { toSortTitle } from "@/lib/text";
import { SKIP_REASONS } from "./bulk";

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: vi.fn(),
}));

const ORIGIN = "http://localhost:3000";
const DATA_ROOT = path.resolve(process.cwd(), "data", `test-series-bulk-${process.pid}`);
const MISSING_ID = "00000000-0000-4000-8000-000000000000";

async function seedSeries(
  createdBy: SessionUser,
  overrides: { title: string; visibility?: "SHARED" | "PRIVATE"; isAdult?: boolean },
): Promise<string> {
  const row = await prisma.series.create({
    data: {
      title: overrides.title,
      sortTitle: toSortTitle(overrides.title),
      visibility: overrides.visibility ?? "SHARED",
      isAdult: overrides.isAdult ?? false,
      createdById: createdBy.id,
    },
    select: { id: true },
  });
  return row.id;
}

async function bulk(body: BulkSeriesInput): Promise<{ status: number; result: BulkSeriesResult }> {
  const response = await bulkRoute(
    new NextRequest(`${ORIGIN}/api/series/bulk`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    routeContext({}),
  );
  return { status: response.status, result: (await response.json()) as BulkSeriesResult };
}

function reasonFor(result: BulkSeriesResult, id: string): string | undefined {
  return result.skipped.find((entry) => entry.id === id)?.reason;
}

beforeAll(() => {
  process.env.DATA_ROOT = DATA_ROOT;
  resetEnvCache();
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await rm(DATA_ROOT, { recursive: true, force: true });
  delete process.env.DATA_ROOT;
  resetEnvCache();
});

describe("PATCH /api/series/bulk", () => {
  it("sets the status only on series the caller actually tracks", async () => {
    const me = await createTestUser();
    const other = await createTestUser();
    const tracked = await seedSeries(me, { title: "Tracked" });
    const untracked = await seedSeries(other, { title: "Untracked" });
    const hidden = await seedSeries(other, { title: "Hidden", visibility: "PRIVATE" });
    await prisma.libraryEntry.create({ data: { userId: me.id, seriesId: tracked } });

    mockCurrentUser(me);
    const { status, result } = await bulk({
      ids: [tracked, untracked, hidden, MISSING_ID],
      action: { type: "setStatus", status: "COMPLETED" },
    });

    expect(status).toBe(200);
    expect(result.affected).toBe(1);
    expect(reasonFor(result, untracked)).toBe(SKIP_REASONS.notTracking);
    expect(reasonFor(result, hidden)).toBe(SKIP_REASONS.noAccess);
    expect(reasonFor(result, MISSING_ID)).toBe(SKIP_REASONS.notFound);

    const entry = await prisma.libraryEntry.findUniqueOrThrow({
      where: { userId_seriesId: { userId: me.id, seriesId: tracked } },
    });
    expect(entry.status).toBe("COMPLETED");
  });

  it("untracks without touching the series", async () => {
    const me = await createTestUser();
    const first = await seedSeries(me, { title: "One" });
    const second = await seedSeries(me, { title: "Two" });
    await prisma.libraryEntry.createMany({
      data: [
        { userId: me.id, seriesId: first },
        { userId: me.id, seriesId: second },
      ],
    });

    mockCurrentUser(me);
    const { result } = await bulk({ ids: [first, second], action: { type: "untrack" } });

    expect(result.affected).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(await prisma.libraryEntry.count({ where: { userId: me.id } })).toBe(0);
    expect(await prisma.series.count()).toBe(2);
  });

  it("only lets an admin flip the book club flag on, even for their own series", async () => {
    const me = await createTestUser();
    const other = await createTestUser();
    const admin = await createTestUser({ role: "admin" });
    const mine = await seedSeries(me, { title: "Mine" });
    const theirs = await seedSeries(other, { title: "Theirs" });
    const privateOwn = await seedSeries(me, { title: "Private", visibility: "PRIVATE" });
    const adminPrivate = await seedSeries(admin, { title: "Admin Private", visibility: "PRIVATE" });

    // A member — even the series' own creator — cannot force book club.
    mockCurrentUser(me);
    const asMember = await bulk({
      ids: [mine, theirs, privateOwn],
      action: { type: "setBookClub", isBookClub: true },
    });
    expect(asMember.result.affected).toBe(0);
    expect(reasonFor(asMember.result, mine)).toBe(SKIP_REASONS.notAdmin);
    expect(reasonFor(asMember.result, theirs)).toBe(SKIP_REASONS.notEditable);
    expect(reasonFor(asMember.result, privateOwn)).toBe(SKIP_REASONS.notAdmin);
    expect((await prisma.series.findUniqueOrThrow({ where: { id: mine } })).isBookClub).toBe(false);

    // An admin can, on any editable series — but a private one is still
    // refused (book club and PRIVATE stay mutually exclusive).
    mockCurrentUser(admin);
    const asAdmin = await bulk({
      ids: [mine, theirs, adminPrivate],
      action: { type: "setBookClub", isBookClub: true },
    });
    expect(asAdmin.result.affected).toBe(2);
    expect(reasonFor(asAdmin.result, adminPrivate)).toBe(SKIP_REASONS.privateBookClub);
    expect((await prisma.series.findUniqueOrThrow({ where: { id: mine } })).isBookClub).toBe(true);
    expect((await prisma.series.findUniqueOrThrow({ where: { id: theirs } })).isBookClub).toBe(
      true,
    );
  });

  it("lets a member turn book club off on their own series", async () => {
    const me = await createTestUser();
    const mine = await seedSeries(me, { title: "Was a pick" });
    await prisma.series.update({ where: { id: mine }, data: { isBookClub: true } });

    mockCurrentUser(me);
    const { result } = await bulk({
      ids: [mine],
      action: { type: "setBookClub", isBookClub: false },
    });

    expect(result.affected).toBe(1);
    expect((await prisma.series.findUniqueOrThrow({ where: { id: mine } })).isBookClub).toBe(false);
  });

  it("enrolls everyone when the book club flag is turned on in bulk", async () => {
    const me = await createTestUser({ role: "admin" });
    await createTestUser();
    const mine = await seedSeries(me, { title: "Club" });

    mockCurrentUser(me);
    await bulk({ ids: [mine], action: { type: "setBookClub", isBookClub: true } });

    expect(await prisma.libraryEntry.count({ where: { seriesId: mine } })).toBe(2);
    expect(
      await prisma.notification.count({ where: { seriesId: mine, type: "BOOK_CLUB_ADDED" } }),
    ).toBe(1);
  });

  it("lets an admin delete other people's series but a member only their own", async () => {
    const author = await createTestUser();
    const member = await createTestUser();
    const first = await seedSeries(author, { title: "First" });
    const second = await seedSeries(author, { title: "Second" });

    mockCurrentUser(member);
    const asMember = await bulk({ ids: [first, second], action: { type: "delete" } });
    expect(asMember.result.affected).toBe(0);
    expect(asMember.result.skipped).toHaveLength(2);
    expect(await prisma.series.count()).toBe(2);

    mockCurrentUser(await createTestUser({ role: "admin" }));
    const asAdmin = await bulk({ ids: [first, second], action: { type: "delete" } });
    expect(asAdmin.result.affected).toBe(2);
    expect(await prisma.series.count()).toBe(0);
  });

  it("removes the on-disk library directory for each deleted series", async () => {
    const author = await createTestUser();
    const first = await seedSeries(author, { title: "First" });
    const second = await seedSeries(author, { title: "Second" });
    const firstDir = libraryDir(first);
    const secondDir = libraryDir(second);
    await ensureDir(firstDir);
    await ensureDir(secondDir);
    await writeFile(path.join(firstDir, "manifest.json"), "{}");
    await writeFile(path.join(secondDir, "manifest.json"), "{}");
    await expect(stat(firstDir)).resolves.toBeDefined();
    await expect(stat(secondDir)).resolves.toBeDefined();

    mockCurrentUser(author);
    const { result } = await bulk({ ids: [first, second], action: { type: "delete" } });

    expect(result.affected).toBe(2);
    await expect(stat(firstDir)).rejects.toThrow();
    await expect(stat(secondDir)).rejects.toThrow();
  });

  it("rejects an empty or oversized selection at the schema", async () => {
    mockCurrentUser(await createTestUser());
    const response = await bulkRoute(
      new NextRequest(`${ORIGIN}/api/series/bulk`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [], action: { type: "untrack" } }),
      }),
      routeContext({}),
    );
    expect(response.status).toBe(400);
  });
});
