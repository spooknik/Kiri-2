/**
 * The signed-in user's own profile: preferences plus the reading stats shown
 * on /profile.
 *
 * Password changes and session management are better-auth's job (the client
 * calls `changePassword` / `listSessions` / `revokeSession` directly), so they
 * are deliberately absent here.
 */
import type { Prisma } from "@/generated/prisma/client";
import { notFound } from "@/lib/api";
import type { UserRole } from "@/lib/auth/types";
import {
  OPTIMIZER_FORMATS,
  type ProfileView,
  type UpdateProfileInput,
} from "@/lib/contracts/profile";
import { READING_STATUSES, type ReadingStatus } from "@/lib/contracts/series";
import { prisma } from "@/lib/prisma";

const profileSelect = {
  id: true,
  email: true,
  displayName: true,
  role: true,
  showAdult: true,
  showSpoilers: true,
  optimizerFormat: true,
  optimizerQuality: true,
  mustSetPassword: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

interface ProfileRow {
  id: string;
  email: string;
  displayName: string;
  role: string;
  showAdult: boolean;
  showSpoilers: boolean;
  optimizerFormat: string;
  optimizerQuality: number;
  mustSetPassword: boolean;
  createdAt: Date;
}

function normalizeRole(role: string): UserRole {
  return role === "admin" ? "admin" : "member";
}

/** The column is a plain string; anything unknown falls back to the only format we ship. */
function normalizeOptimizerFormat(value: string): (typeof OPTIMIZER_FORMATS)[number] {
  const match = OPTIMIZER_FORMATS.find((format) => format === value);
  return match ?? "WEBP";
}

/** Every status is present with a zero so the UI never has to fill gaps. */
async function loadStats(userId: string): Promise<ProfileView["stats"]> {
  const [tracked, grouped, created] = await Promise.all([
    prisma.libraryEntry.count({ where: { userId } }),
    prisma.libraryEntry.groupBy({
      by: ["status"],
      where: { userId },
      _count: { _all: true },
    }),
    prisma.series.count({ where: { createdById: userId } }),
  ]);

  const byStatus = Object.fromEntries(READING_STATUSES.map((status) => [status, 0])) as Record<
    ReadingStatus,
    number
  >;
  for (const row of grouped) {
    byStatus[row.status] = row._count._all;
  }

  return { tracked, byStatus, created };
}

async function toView(row: ProfileRow): Promise<ProfileView> {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: normalizeRole(row.role),
    showAdult: row.showAdult,
    showSpoilers: row.showSpoilers,
    optimizerFormat: normalizeOptimizerFormat(row.optimizerFormat),
    optimizerQuality: row.optimizerQuality,
    mustSetPassword: row.mustSetPassword,
    createdAt: row.createdAt.toISOString(),
    stats: await loadStats(row.id),
  };
}

export async function getProfile(userId: string): Promise<ProfileView> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: profileSelect });
  if (!row) throw notFound("User");
  return toView(row);
}

/**
 * Apply a partial profile update. `displayName` is mirrored onto better-auth's
 * `name` column so both the session user and better-auth's own responses agree.
 */
export async function updateProfile(
  userId: string,
  input: UpdateProfileInput,
): Promise<ProfileView> {
  const data: Prisma.UserUpdateInput = {};
  if (input.displayName !== undefined) {
    data.displayName = input.displayName;
    data.name = input.displayName;
  }
  if (input.showAdult !== undefined) data.showAdult = input.showAdult;
  if (input.showSpoilers !== undefined) data.showSpoilers = input.showSpoilers;
  if (input.optimizerFormat !== undefined) data.optimizerFormat = input.optimizerFormat;
  if (input.optimizerQuality !== undefined) data.optimizerQuality = input.optimizerQuality;

  const row = await prisma.user.update({
    where: { id: userId },
    data,
    select: profileSelect,
  });
  return toView(row);
}
