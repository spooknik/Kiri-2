/**
 * Series and library-entry write paths.
 *
 * Routes stay thin: they validate with the contract schemas and call these
 * functions, which own authorization (`src/lib/authz.ts`), de-duplication,
 * cover storage and book-club enrollment. Everything that can throw throws an
 * `ApiError`, so `withAuth` maps it to the right status without route-level
 * try/catch.
 */
import type { Prisma } from "@/generated/prisma/client";
import { ApiError, badRequest, forbidden, notFound } from "@/lib/api";
import type { SessionUser } from "@/lib/auth/types";
import { isAdmin } from "@/lib/auth/types";
import { assertCanEditSeries, assertCanViewSeries } from "@/lib/authz";
import type {
  CreateSeriesInput,
  LibraryEntryView,
  SeriesDetail,
  UpdateEntryInput,
  UpdateSeriesInput,
} from "@/lib/contracts";
import { removeLibraryDir } from "@/lib/content/store";
import { tryDeleteCover, tryStoreCoverFromUrl } from "@/lib/cover-storage";
import { prisma } from "@/lib/prisma";
import { normalizeTags, toSortTitle } from "@/lib/text";
import { enrollAllUsers } from "./book-club";
import { findVisibleSeriesIdByMalId } from "./dedupe";
import {
  memberInclude,
  seriesIncludeFor,
  toEntryView,
  toSeriesDetail,
  type MemberRow,
  type SeriesRow,
} from "./serialize";

/** Upper bound on the members list of a shared series. */
const MAX_MEMBERS = 200;

/** The columns every authorization check and write path needs. */
const ACCESS_SELECT = {
  id: true,
  title: true,
  visibility: true,
  isAdult: true,
  isBookClub: true,
  createdById: true,
  coverFile: true,
  malId: true,
  externalIds: true,
} satisfies Prisma.SeriesSelect;

export type SeriesAccessRow = Prisma.SeriesGetPayload<{ select: typeof ACCESS_SELECT }>;

/** Trimmed-empty optional text collapses to null so the column stays clean. */
function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function toJsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  return {};
}

function alreadyInLibrary(existingSeriesId: string): ApiError {
  return new ApiError(409, "CONFLICT", "This series is already in the library", {
    existingSeriesId,
  });
}

/** PRIVATE and book club are mutually exclusive (plan: "Core tracker"). */
function assertVisibilityAllowsBookClub(visibility: string, isBookClub: boolean): void {
  if (visibility === "PRIVATE" && isBookClub) {
    throw badRequest("A private series cannot be a book club pick");
  }
}

export async function loadSeriesForAccess(id: string): Promise<SeriesAccessRow> {
  const series = await prisma.series.findUnique({ where: { id }, select: ACCESS_SELECT });
  if (!series) throw notFound("Series");
  return series;
}

async function loadMembers(seriesId: string): Promise<MemberRow[]> {
  return prisma.libraryEntry.findMany({
    where: { seriesId },
    include: memberInclude,
    orderBy: { updatedAt: "desc" },
    take: MAX_MEMBERS,
  });
}

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

export async function getSeriesDetail(user: SessionUser, id: string): Promise<SeriesDetail> {
  const row: SeriesRow | null = await prisma.series.findUnique({
    where: { id },
    include: seriesIncludeFor(user.id),
  });
  if (!row) throw notFound("Series");
  assertCanViewSeries(user, row);
  const members = row.visibility === "SHARED" ? await loadMembers(id) : [];
  return toSeriesDetail(row, user, members);
}

/* -------------------------------------------------------------------------- */
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

export async function createSeries(
  user: SessionUser,
  input: CreateSeriesInput,
): Promise<SeriesDetail> {
  // Only admins can launch a series straight into book club (which
  // auto-enrolls every user, see `enrollAllUsers` below) — a member sending
  // `isBookClub: true` is rejected outright rather than silently downgraded,
  // so the request fails loudly instead of the caller assuming it worked.
  if (input.isBookClub && !isAdmin(user)) {
    throw forbidden("Only admins can mark a series as book club");
  }
  assertVisibilityAllowsBookClub(input.visibility, input.isBookClub);

  const malId = input.malId ?? null;
  if (malId !== null) {
    const existingSeriesId = await findVisibleSeriesIdByMalId(user, malId);
    if (existingSeriesId) throw alreadyInLibrary(existingSeriesId);
  }

  const created = await prisma.series.create({
    data: {
      title: input.title,
      sortTitle: toSortTitle(input.title),
      originalTitle: emptyToNull(input.originalTitle),
      synopsis: emptyToNull(input.synopsis),
      mediaType: input.mediaType,
      visibility: input.visibility,
      isAdult: input.isAdult,
      isBookClub: input.isBookClub,
      publicationYear: input.publicationYear ?? null,
      totalChapters: input.totalChapters ?? null,
      totalVolumes: input.totalVolumes ?? null,
      tags: normalizeTags(input.tags),
      sourceUrl: emptyToNull(input.sourceUrl),
      malId,
      externalIds: malId === null ? {} : { malId },
      createdBy: { connect: { id: user.id } },
      // The creator always tracks what they add.
      library: {
        create: {
          userId: user.id,
          status: input.status,
          currentChapter: input.currentChapter,
        },
      },
    },
    select: { id: true },
  });

  // Covers are decoration: a failed download must not lose the series.
  if (input.coverUrl) {
    const coverFile = await tryStoreCoverFromUrl(created.id, input.coverUrl);
    if (coverFile) {
      await prisma.series.update({ where: { id: created.id }, data: { coverFile } });
    }
  }

  if (input.isBookClub) {
    await enrollAllUsers(created.id, { actorId: user.id });
  }

  return getSeriesDetail(user, created.id);
}

/* -------------------------------------------------------------------------- */
/* Update                                                                     */
/* -------------------------------------------------------------------------- */

export async function updateSeries(
  user: SessionUser,
  id: string,
  patch: UpdateSeriesInput,
): Promise<SeriesDetail> {
  const current = await loadSeriesForAccess(id);
  assertCanEditSeries(user, current);

  // Same admin-only rule as create: a member cannot flip a series into book
  // club, even one they created. Turning it *off* is unrestricted — anyone who
  // can edit the series can undo a book-club pick.
  if (patch.isBookClub === true && !isAdmin(user)) {
    throw forbidden("Only admins can mark a series as book club");
  }

  const nextVisibility = patch.visibility ?? current.visibility;
  const nextBookClub = patch.isBookClub ?? current.isBookClub;
  assertVisibilityAllowsBookClub(nextVisibility, nextBookClub);

  const data: Prisma.SeriesUpdateInput = {};

  if (patch.title !== undefined) {
    data.title = patch.title;
    data.sortTitle = toSortTitle(patch.title);
  }
  if (patch.originalTitle !== undefined) data.originalTitle = emptyToNull(patch.originalTitle);
  if (patch.synopsis !== undefined) data.synopsis = emptyToNull(patch.synopsis);
  if (patch.mediaType !== undefined) data.mediaType = patch.mediaType;
  if (patch.visibility !== undefined) data.visibility = patch.visibility;
  if (patch.isAdult !== undefined) data.isAdult = patch.isAdult;
  if (patch.isBookClub !== undefined) data.isBookClub = patch.isBookClub;
  if (patch.publicationYear !== undefined) data.publicationYear = patch.publicationYear ?? null;
  if (patch.totalChapters !== undefined) data.totalChapters = patch.totalChapters ?? null;
  if (patch.totalVolumes !== undefined) data.totalVolumes = patch.totalVolumes ?? null;
  if (patch.tags !== undefined) data.tags = normalizeTags(patch.tags);
  if (patch.sourceUrl !== undefined) data.sourceUrl = emptyToNull(patch.sourceUrl);

  if (patch.malId !== undefined) {
    const malId = patch.malId ?? null;
    if (malId !== null && malId !== current.malId) {
      const existingSeriesId = await findVisibleSeriesIdByMalId(user, malId, {
        excludeSeriesId: id,
      });
      if (existingSeriesId) throw alreadyInLibrary(existingSeriesId);
    }
    const externalIds = toJsonObject(current.externalIds);
    if (malId === null) {
      delete externalIds.malId;
    } else {
      externalIds.malId = malId;
    }
    data.malId = malId;
    data.externalIds = externalIds as Prisma.InputJsonValue;
  }

  if (patch.removeCover === true) {
    await tryDeleteCover(id);
    data.coverFile = null;
  }
  if (patch.coverUrl) {
    const coverFile = await tryStoreCoverFromUrl(id, patch.coverUrl);
    if (coverFile) data.coverFile = coverFile;
  }

  // Explicit so the cover cache-buster moves even when nothing else changed.
  data.updatedAt = new Date();
  await prisma.series.update({ where: { id }, data });

  // Idempotent: re-running repairs a partially enrolled series, and the
  // dedupeKey stops anyone being notified twice.
  if (patch.isBookClub === true) {
    await enrollAllUsers(id, { actorId: user.id });
  }

  return getSeriesDetail(user, id);
}

/* -------------------------------------------------------------------------- */
/* Delete                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Delete the series for everyone. V1 left the cover directory behind
 * (`series/[id]/route.ts:282`); here the content store is cleaned first -- the
 * cover *and* the library directory with every ripped chapter, which the row
 * cascade cannot reach -- and a filesystem hiccup is logged rather than
 * blocking the delete.
 */
export async function deleteSeries(user: SessionUser, id: string): Promise<void> {
  const current = await loadSeriesForAccess(id);
  assertCanEditSeries(user, current);
  await tryDeleteCover(id);
  try {
    await removeLibraryDir(id);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[series] could not remove the library directory for ${id}: ${reason}`);
  }
  await prisma.series.delete({ where: { id } });
}

/* -------------------------------------------------------------------------- */
/* Library entries                                                            */
/* -------------------------------------------------------------------------- */

export async function upsertEntry(
  user: SessionUser,
  seriesId: string,
  input: UpdateEntryInput,
): Promise<LibraryEntryView> {
  const series = await loadSeriesForAccess(seriesId);
  assertCanViewSeries(user, series);

  const update: Prisma.LibraryEntryUpdateInput = { updatedAt: new Date() };
  if (input.status !== undefined) update.status = input.status;
  if (input.currentChapter !== undefined) update.currentChapter = input.currentChapter;
  if (input.rating !== undefined) update.rating = input.rating ?? null;
  if (input.notes !== undefined) update.notes = emptyToNull(input.notes);
  if (input.favorite !== undefined) update.favorite = input.favorite;

  const entry = await prisma.libraryEntry.upsert({
    where: { userId_seriesId: { userId: user.id, seriesId } },
    create: {
      userId: user.id,
      seriesId,
      status: input.status ?? "PLAN_TO_READ",
      currentChapter: input.currentChapter ?? 0,
      rating: input.rating ?? null,
      notes: emptyToNull(input.notes),
      favorite: input.favorite ?? false,
    },
    update,
  });
  return toEntryView(entry);
}

/**
 * Stop tracking. The series itself always stays -- including when the creator
 * untracks their own -- so a shared shelf never disappears from under the
 * other members.
 */
export async function removeEntry(user: SessionUser, seriesId: string): Promise<void> {
  const series = await loadSeriesForAccess(seriesId);
  assertCanViewSeries(user, series);
  await prisma.libraryEntry.deleteMany({ where: { userId: user.id, seriesId } });
}
