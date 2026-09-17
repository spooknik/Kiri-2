/**
 * GET /api/library integration tests: scope, filters, visibility, full-text
 * search, every sort, cursor pagination and the status counters.
 *
 * The fixtures are written straight through Prisma so timestamps are exact
 * (the sorts depend on them); the reads all go through the route handler.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestUser,
  mockCurrentUser,
  resetDatabase,
  routeContext,
} from "../../../test/factories";
import { GET as libraryRoute } from "@/app/api/library/route";
import type { SessionUser } from "@/lib/auth/types";
import type { LibraryPage, MediaType, ReadingStatus, Visibility } from "@/lib/contracts";
import { prisma } from "@/lib/prisma";
import { toSortTitle } from "@/lib/text";

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session")>()),
  getCurrentUser: vi.fn(),
}));

const ORIGIN = "http://localhost:3000";

interface SeedSeriesOptions {
  title: string;
  createdBy: SessionUser;
  synopsis?: string;
  tags?: string[];
  mediaType?: MediaType;
  visibility?: Visibility;
  isAdult?: boolean;
  isBookClub?: boolean;
  createdAt?: string;
  updatedAt?: string;
  lastChapterAt?: string | null;
}

async function seedSeries(options: SeedSeriesOptions): Promise<string> {
  const row = await prisma.series.create({
    data: {
      title: options.title,
      sortTitle: toSortTitle(options.title),
      synopsis: options.synopsis ?? null,
      tags: options.tags ?? [],
      mediaType: options.mediaType ?? "MANGA",
      visibility: options.visibility ?? "SHARED",
      isAdult: options.isAdult ?? false,
      isBookClub: options.isBookClub ?? false,
      createdById: options.createdBy.id,
      ...(options.createdAt ? { createdAt: new Date(options.createdAt) } : {}),
      ...(options.updatedAt ? { updatedAt: new Date(options.updatedAt) } : {}),
      lastChapterAt: options.lastChapterAt ? new Date(options.lastChapterAt) : null,
    },
    select: { id: true },
  });
  return row.id;
}

async function track(
  user: SessionUser,
  seriesId: string,
  data: { status?: ReadingStatus; favorite?: boolean; updatedAt?: string } = {},
): Promise<void> {
  await prisma.libraryEntry.create({
    data: {
      userId: user.id,
      seriesId,
      status: data.status ?? "PLAN_TO_READ",
      favorite: data.favorite ?? false,
      ...(data.updatedAt ? { updatedAt: new Date(data.updatedAt) } : {}),
    },
  });
}

async function library(params: Record<string, string> = {}): Promise<LibraryPage> {
  const url = new URL("/api/library", ORIGIN);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await libraryRoute(new NextRequest(url), routeContext({}));
  expect(response.status).toBe(200);
  return (await response.json()) as LibraryPage;
}

function titles(page: LibraryPage): string[] {
  return page.items.map((item) => item.title);
}

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* Scope and filters                                                          */
/* -------------------------------------------------------------------------- */

describe("GET /api/library scope and filters", () => {
  let me: SessionUser;
  let other: SessionUser;

  beforeEach(async () => {
    me = await createTestUser();
    other = await createTestUser();
    mockCurrentUser(me);
  });

  it("defaults to the series I track", async () => {
    const mine = await seedSeries({ title: "Tracked", createdBy: other });
    await seedSeries({ title: "Untracked", createdBy: other });
    await track(me, mine);

    const page = await library();
    expect(titles(page)).toEqual(["Tracked"]);
    expect(page.total).toBe(1);
  });

  it("scope=created lists what I added, tracked or not", async () => {
    await seedSeries({ title: "Mine", createdBy: me });
    const theirs = await seedSeries({ title: "Theirs", createdBy: other });
    await track(me, theirs);

    expect(titles(await library({ scope: "created" }))).toEqual(["Mine"]);
  });

  it("scope=all lists everything visible", async () => {
    await seedSeries({ title: "Mine", createdBy: me });
    await seedSeries({ title: "Theirs", createdBy: other });

    const page = await library({ scope: "all", sort: "title" });
    expect(titles(page)).toEqual(["Mine", "Theirs"]);
  });

  it("filters by my entry status", async () => {
    const reading = await seedSeries({ title: "Reading", createdBy: me });
    const planned = await seedSeries({ title: "Planned", createdBy: me });
    await track(me, reading, { status: "READING" });
    await track(me, planned, { status: "PLAN_TO_READ" });

    expect(titles(await library({ status: "READING" }))).toEqual(["Reading"]);
  });

  it("filters by media type, tag, book club and favourite", async () => {
    const novel = await seedSeries({
      title: "Novel",
      createdBy: me,
      mediaType: "LIGHT_NOVEL",
      tags: ["Isekai", "Drama"],
      isBookClub: true,
    });
    const manga = await seedSeries({ title: "Manga", createdBy: me, tags: ["Drama"] });
    await track(me, novel, { favorite: true });
    await track(me, manga);

    expect(titles(await library({ mediaType: "LIGHT_NOVEL" }))).toEqual(["Novel"]);
    expect(titles(await library({ tag: "Isekai" }))).toEqual(["Novel"]);
    expect(titles(await library({ tag: "Drama", sort: "title" }))).toEqual(["Manga", "Novel"]);
    expect(titles(await library({ bookClub: "1" }))).toEqual(["Novel"]);
    expect(titles(await library({ favorite: "1" }))).toEqual(["Novel"]);
  });

  it("status and favourite imply tracking even under scope=all", async () => {
    const tracked = await seedSeries({ title: "Tracked", createdBy: other });
    await seedSeries({ title: "Untracked", createdBy: other });
    await track(me, tracked, { status: "READING" });

    expect(titles(await library({ scope: "all", status: "READING" }))).toEqual(["Tracked"]);
  });

  it("counts my entries by status with every key present", async () => {
    const a = await seedSeries({ title: "A", createdBy: me });
    const b = await seedSeries({ title: "B", createdBy: me });
    await track(me, a, { status: "READING" });
    await track(me, b, { status: "COMPLETED" });

    const page = await library({ scope: "all" });
    expect(page.statusCounts).toEqual({
      READING: 1,
      COMPLETED: 1,
      ON_HOLD: 0,
      DROPPED: 0,
      PLAN_TO_READ: 0,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Visibility and adult filtering                                             */
/* -------------------------------------------------------------------------- */

describe("GET /api/library visibility", () => {
  it("never lists another user's private series", async () => {
    const me = await createTestUser();
    const other = await createTestUser();
    await seedSeries({ title: "Their secret", createdBy: other, visibility: "PRIVATE" });
    const mine = await seedSeries({ title: "My secret", createdBy: me, visibility: "PRIVATE" });
    await track(me, mine);

    mockCurrentUser(me);
    const page = await library({ scope: "all" });
    expect(titles(page)).toEqual(["My secret"]);
    expect(page.total).toBe(1);
  });

  it("hides adult series unless the reader opted in", async () => {
    const author = await createTestUser();
    await seedSeries({ title: "Adult", createdBy: author, isAdult: true });
    await seedSeries({ title: "Safe", createdBy: author });

    mockCurrentUser(await createTestUser({ showAdult: false }));
    expect(titles(await library({ scope: "all" }))).toEqual(["Safe"]);

    mockCurrentUser(await createTestUser({ showAdult: true }));
    expect(titles(await library({ scope: "all", sort: "title" }))).toEqual(["Adult", "Safe"]);
  });

  it("still shows the creator their own adult series", async () => {
    const author = await createTestUser({ showAdult: false });
    await seedSeries({ title: "Mine adult", createdBy: author, isAdult: true });

    mockCurrentUser(author);
    expect(titles(await library({ scope: "all" }))).toEqual(["Mine adult"]);
  });

  it("honours adult=only and adult=exclude for opted-in readers", async () => {
    const reader = await createTestUser({ showAdult: true });
    await seedSeries({ title: "Adult", createdBy: reader, isAdult: true });
    await seedSeries({ title: "Safe", createdBy: reader });

    mockCurrentUser(reader);
    expect(titles(await library({ scope: "all", adult: "only" }))).toEqual(["Adult"]);
    expect(titles(await library({ scope: "all", adult: "exclude" }))).toEqual(["Safe"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Full-text search                                                           */
/* -------------------------------------------------------------------------- */

describe("GET /api/library search", () => {
  let me: SessionUser;

  beforeEach(async () => {
    me = await createTestUser();
    mockCurrentUser(me);
    await seedSeries({
      title: "Spice and Wolf",
      createdBy: me,
      tags: ["Romance", "Historical"],
      synopsis: "A travelling merchant meets a wolf deity.",
    });
    await seedSeries({
      title: "Vinland Saga",
      createdBy: me,
      tags: ["Historical", "Action"],
      synopsis: "Vikings, revenge and farming.",
    });
    await seedSeries({ title: "Blue Period", createdBy: me, tags: ["Art"] });
  });

  it("matches on the title", async () => {
    expect(titles(await library({ scope: "all", q: "vinland" }))).toEqual(["Vinland Saga"]);
  });

  it("matches on tags", async () => {
    const page = await library({ scope: "all", q: "historical" });
    expect(titles(page).sort()).toEqual(["Spice and Wolf", "Vinland Saga"]);
    expect(page.total).toBe(2);
  });

  it("matches a stemmed word in the synopsis", async () => {
    expect(titles(await library({ scope: "all", q: "farm" }))).toEqual(["Vinland Saga"]);
  });

  it("ranks title hits above synopsis hits", async () => {
    await seedSeries({
      title: "Merchant Tales",
      createdBy: me,
      synopsis: "Nothing to do with wolves.",
    });
    const page = await library({ scope: "all", q: "merchant" });
    expect(titles(page)[0]).toBe("Merchant Tales");
  });

  it("returns an empty page for a term nothing matches", async () => {
    const page = await library({ scope: "all", q: "nonexistentterm" });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.nextCursor).toBeNull();
    // The counters are unfiltered, so they survive an empty result page.
    expect(Object.keys(page.statusCounts)).toHaveLength(5);
  });

  it("combines search with filters", async () => {
    expect(titles(await library({ scope: "all", q: "historical", tag: "Action" }))).toEqual([
      "Vinland Saga",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Sorting and pagination                                                     */
/* -------------------------------------------------------------------------- */

describe("GET /api/library sorting", () => {
  let me: SessionUser;

  beforeEach(async () => {
    me = await createTestUser();
    mockCurrentUser(me);

    const berserk = await seedSeries({
      title: "Berserk",
      createdBy: me,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-03-01T00:00:00.000Z",
      lastChapterAt: "2024-02-01T00:00:00.000Z",
    });
    const apothecary = await seedSeries({
      title: "The Apothecary Diaries",
      createdBy: me,
      createdAt: "2024-01-03T00:00:00.000Z",
      updatedAt: "2024-03-03T00:00:00.000Z",
      lastChapterAt: null,
    });
    const claymore = await seedSeries({
      title: "Claymore",
      createdBy: me,
      createdAt: "2024-01-02T00:00:00.000Z",
      updatedAt: "2024-03-02T00:00:00.000Z",
      lastChapterAt: "2024-02-05T00:00:00.000Z",
    });

    await track(me, berserk, { updatedAt: "2024-04-03T00:00:00.000Z" });
    await track(me, apothecary, { updatedAt: "2024-04-01T00:00:00.000Z" });
    await track(me, claymore, { updatedAt: "2024-04-02T00:00:00.000Z" });
  });

  it("sorts by updated (newest first) by default", async () => {
    expect(titles(await library())).toEqual(["The Apothecary Diaries", "Claymore", "Berserk"]);
  });

  it("sorts by sort title, ignoring a leading article", async () => {
    expect(titles(await library({ sort: "title" }))).toEqual([
      "The Apothecary Diaries",
      "Berserk",
      "Claymore",
    ]);
  });

  it("sorts by added date", async () => {
    expect(titles(await library({ sort: "added" }))).toEqual([
      "The Apothecary Diaries",
      "Claymore",
      "Berserk",
    ]);
  });

  it("sorts by last chapter with nulls last", async () => {
    expect(titles(await library({ sort: "lastChapter" }))).toEqual([
      "Claymore",
      "Berserk",
      "The Apothecary Diaries",
    ]);
  });

  it("sorts by my own progress timestamp", async () => {
    expect(titles(await library({ sort: "progress" }))).toEqual([
      "Berserk",
      "Claymore",
      "The Apothecary Diaries",
    ]);
  });

  it("honours an explicit order override", async () => {
    expect(titles(await library({ sort: "title", order: "desc" }))).toEqual([
      "Claymore",
      "Berserk",
      "The Apothecary Diaries",
    ]);
  });

  it("paginates without duplicates or gaps on every sort", async () => {
    for (const sort of ["updated", "title", "added", "lastChapter", "progress"]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let guard = 0;
      do {
        const page: LibraryPage = await library({
          sort,
          limit: "2",
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...titles(page));
        cursor = page.nextCursor;
        guard += 1;
      } while (cursor && guard < 10);

      expect(new Set(seen).size, `duplicates in ${sort}`).toBe(3);
      expect(seen, `page order for ${sort}`).toEqual(titles(await library({ sort, limit: "10" })));
    }
  });

  it("paginates search results by relevance", async () => {
    // "saga" hits one title (weight A) and two tag lists (weight B), so the
    // page boundary falls inside a rank tie and the id tie-break has to hold.
    await seedSeries({ title: "Gamma Saga", createdBy: me });
    await seedSeries({ title: "Alpha", createdBy: me, tags: ["saga"] });
    await seedSeries({ title: "Beta", createdBy: me, tags: ["saga"] });

    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const page: LibraryPage = await library({
        scope: "all",
        q: "saga",
        limit: "1",
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...titles(page));
      cursor = page.nextCursor;
      guard += 1;
    } while (cursor && guard < 10);

    expect(seen).toHaveLength(3);
    expect(seen[0]).toBe("Gamma Saga");
    expect(seen).toEqual(titles(await library({ scope: "all", q: "saga", limit: "10" })));
  });

  it("rejects a cursor it did not issue", async () => {
    const response = await libraryRoute(
      new NextRequest(`${ORIGIN}/api/library?cursor=not-a-cursor`),
      routeContext({}),
    );
    expect(response.status).toBe(400);
  });
});
