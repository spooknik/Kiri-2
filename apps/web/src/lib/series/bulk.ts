/**
 * Bulk library actions (`PATCH /api/series/bulk`).
 *
 * Permission is decided per id, not per request: a selection may mix series
 * the user created, series they only track and series they cannot see at all.
 * Anything that cannot be applied lands in `skipped` with a reason the UI can
 * show verbatim, so a 20-row selection never fails as a whole.
 */
import type { Prisma } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth/types";
import { isAdmin } from "@/lib/auth/types";
import { canEditSeries, canViewSeries } from "@/lib/authz";
import type { BulkSeriesInput, BulkSeriesResult } from "@/lib/contracts";
import { removeLibraryDir } from "@/lib/content/store";
import { tryDeleteCover } from "@/lib/cover-storage";
import { prisma } from "@/lib/prisma";
import { enrollAllUsers } from "./book-club";

const ACCESS_SELECT = {
  id: true,
  visibility: true,
  isAdult: true,
  createdById: true,
  isBookClub: true,
} satisfies Prisma.SeriesSelect;

type AccessRow = Prisma.SeriesGetPayload<{ select: typeof ACCESS_SELECT }>;

export const SKIP_REASONS = {
  notFound: "Series not found",
  noAccess: "You do not have access to this series",
  notTracking: "You are not tracking this series",
  notEditable: "Only the series creator or an admin can change this series",
  privateBookClub: "A private series cannot be a book club pick",
  notAdmin: "Only admins can mark a series as book club",
} as const;

export async function bulkUpdateSeries(
  user: SessionUser,
  input: BulkSeriesInput,
): Promise<BulkSeriesResult> {
  const ids = Array.from(new Set(input.ids));
  const rows = await prisma.series.findMany({
    where: { id: { in: ids } },
    select: ACCESS_SELECT,
  });
  const byId = new Map(rows.map((row) => [row.id, row]));

  const skipped: { id: string; reason: string }[] = [];
  const visible: AccessRow[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      skipped.push({ id, reason: SKIP_REASONS.notFound });
    } else if (!canViewSeries(user, row)) {
      skipped.push({ id, reason: SKIP_REASONS.noAccess });
    } else {
      visible.push(row);
    }
  }

  switch (input.action.type) {
    case "setStatus": {
      const status = input.action.status;
      const tracked = await partitionTracked(user, visible, skipped);
      const result = await prisma.libraryEntry.updateMany({
        where: { userId: user.id, seriesId: { in: tracked } },
        data: { status },
      });
      return { affected: result.count, skipped };
    }
    case "untrack": {
      const tracked = await partitionTracked(user, visible, skipped);
      const result = await prisma.libraryEntry.deleteMany({
        where: { userId: user.id, seriesId: { in: tracked } },
      });
      return { affected: result.count, skipped };
    }
    case "setBookClub": {
      const isBookClub = input.action.isBookClub;
      // Same admin-only rule as `createSeries`/`updateSeries`: a member can
      // untrack or edit their own series, but cannot force it into book club
      // (which auto-enrolls every user). Turning it off stays open to anyone
      // who can edit the series.
      const requiresAdmin = isBookClub && !isAdmin(user);
      const editable: string[] = [];
      for (const row of visible) {
        if (!canEditSeries(user, row)) {
          skipped.push({ id: row.id, reason: SKIP_REASONS.notEditable });
        } else if (requiresAdmin) {
          skipped.push({ id: row.id, reason: SKIP_REASONS.notAdmin });
        } else if (isBookClub && row.visibility === "PRIVATE") {
          skipped.push({ id: row.id, reason: SKIP_REASONS.privateBookClub });
        } else {
          editable.push(row.id);
        }
      }
      const result = await prisma.series.updateMany({
        where: { id: { in: editable } },
        data: { isBookClub, updatedAt: new Date() },
      });
      if (isBookClub) {
        for (const id of editable) {
          await enrollAllUsers(id, { actorId: user.id });
        }
      }
      return { affected: result.count, skipped };
    }
    case "delete": {
      const deletable: string[] = [];
      for (const row of visible) {
        if (!canEditSeries(user, row)) {
          skipped.push({ id: row.id, reason: SKIP_REASONS.notEditable });
        } else {
          deletable.push(row.id);
        }
      }
      for (const id of deletable) {
        await tryDeleteCover(id);
        try {
          await removeLibraryDir(id);
        } catch (error) {
          // Same non-fatal handling as the single-series delete path
          // (`service.ts` `deleteSeries`): a filesystem hiccup logs and moves
          // on rather than failing the whole bulk action.
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(`[series] could not remove the library directory for ${id}: ${reason}`);
        }
      }
      const result = await prisma.series.deleteMany({ where: { id: { in: deletable } } });
      return { affected: result.count, skipped };
    }
  }
}

/** Split the visible rows into "I track this" and a skip reason for the rest. */
async function partitionTracked(
  user: SessionUser,
  visible: AccessRow[],
  skipped: { id: string; reason: string }[],
): Promise<string[]> {
  if (visible.length === 0) return [];
  const entries = await prisma.libraryEntry.findMany({
    where: { userId: user.id, seriesId: { in: visible.map((row) => row.id) } },
    select: { seriesId: true },
  });
  const tracked = new Set(entries.map((entry) => entry.seriesId));
  const result: string[] = [];
  for (const row of visible) {
    if (tracked.has(row.id)) {
      result.push(row.id);
    } else {
      skipped.push({ id: row.id, reason: SKIP_REASONS.notTracking });
    }
  }
  return result;
}
