/**
 * Series authorization.
 *
 * Pure predicates over a `SessionUser` and the three series columns that decide
 * access, plus the matching Prisma `where` fragment so list queries filter in
 * the database instead of the browser (V1 filtered adult content client-side).
 *
 * Rules, in one place:
 *   - PRIVATE series are visible to their creator only. Admins included: a
 *     private shelf is private; admin tooling that must touch one goes through
 *     dedicated admin routes, never the library;
 *   - adult series are visible to their creator, or to users who enabled
 *     showAdult — a personal preference that applies to admins too;
 *   - editing is creator-or-admin, but never without view access.
 */
import type { Prisma, Visibility } from "@/generated/prisma/client";
import { forbidden, notFound } from "@/lib/api";
import { isAdmin, type SessionUser } from "@/lib/auth/types";

/** The minimum series shape the access rules need. */
export interface SeriesAccess {
  visibility: Visibility;
  isAdult: boolean;
  createdById: string;
}

function isCreator(user: SessionUser, series: SeriesAccess): boolean {
  return series.createdById === user.id;
}

export function canViewSeries(user: SessionUser, series: SeriesAccess): boolean {
  if (isCreator(user, series)) return true;
  if (series.visibility === "PRIVATE") return false;
  if (series.isAdult && !user.showAdult) return false;
  return true;
}

export function canEditSeries(user: SessionUser, series: SeriesAccess): boolean {
  if (!canViewSeries(user, series)) return false;
  return isAdmin(user) || isCreator(user, series);
}

/**
 * Throws instead of returning false. A private series the user may not see is
 * reported as 404 so its existence is not leaked; an adult series hidden by the
 * user's own preference is a 403, because the user can flip that switch.
 */
export function assertCanViewSeries(user: SessionUser, series: SeriesAccess): void {
  if (isCreator(user, series)) return;
  if (series.visibility === "PRIVATE") {
    throw notFound("Series");
  }
  if (series.isAdult && !user.showAdult) {
    throw forbidden("Adult content is hidden by your profile settings");
  }
}

/** View check first, so a private series stays a 404 rather than a 403. */
export function assertCanEditSeries(user: SessionUser, series: SeriesAccess): void {
  assertCanViewSeries(user, series);
  if (!canEditSeries(user, series)) {
    throw forbidden("Only the series creator or an admin can change this series");
  }
}

export function requireAdmin(user: SessionUser): void {
  if (!isAdmin(user)) {
    throw forbidden("Admin access required");
  }
}

/**
 * `where` fragment mirroring `canViewSeries` for list queries. Top-level keys
 * are ANDed by Prisma, so the visibility OR and the adult OR both apply.
 */
export function visibleSeriesWhere(user: SessionUser): Prisma.SeriesWhereInput {
  return {
    OR: [{ visibility: "SHARED" }, { createdById: user.id }],
    ...(user.showAdult ? {} : { AND: [{ OR: [{ isAdult: false }, { createdById: user.id }] }] }),
  };
}
