/**
 * Housekeeping that keeps the database from growing without bound.
 *
 * V1 never expired notifications; here they age out after
 * `AppSetting.notificationRetentionDays`, invites that nobody redeemed are
 * flipped to EXPIRED so the admin list tells the truth, and better-auth's
 * `session` / `verification` rows are dropped once past their own expiry
 * (better-auth only ignores them, it never deletes them).
 *
 * Scheduled from src/instrumentation.ts today; Phase 2's job runner will take
 * this over as a periodic job. It never throws — a failed sweep must not take
 * the server down — and reports whatever it managed to delete.
 */
import { InviteStatus } from "@/generated/prisma/client";
import { purgeOldJobTmpDirs } from "@/lib/jobs/tmp";
import { purgeOldNotifications } from "@/lib/notifications";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/settings";
import { purgeExpiredUploads } from "@/lib/uploads/sessions";

export interface RetentionResult {
  notificationsPurged: number;
  invitesExpired: number;
  sessionsDeleted: number;
  verificationsDeleted: number;
  /** Chunked-upload sessions past their 24 h expiry. */
  uploadsPurged: number;
  /** `DATA_ROOT/tmp/jobs/*` directories a crashed worker left behind. */
  jobTmpDirsRemoved: number;
  durationMs: number;
  /** Set when a step threw; earlier counts are still reported. */
  error: string | null;
}

export async function runRetention(): Promise<RetentionResult> {
  const startedAt = Date.now();
  const result: RetentionResult = {
    notificationsPurged: 0,
    invitesExpired: 0,
    sessionsDeleted: 0,
    verificationsDeleted: 0,
    uploadsPurged: 0,
    jobTmpDirsRemoved: 0,
    durationMs: 0,
    error: null,
  };

  try {
    const settings = await getAppSettings();
    result.notificationsPurged = await purgeOldNotifications(settings.notificationRetentionDays);

    const now = new Date();
    const expired = await prisma.invite.updateMany({
      where: { status: InviteStatus.PENDING, expiresAt: { lte: now } },
      data: { status: InviteStatus.EXPIRED },
    });
    result.invitesExpired = expired.count;

    const sessions = await prisma.session.deleteMany({ where: { expiresAt: { lt: now } } });
    result.sessionsDeleted = sessions.count;

    const verifications = await prisma.verification.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    result.verificationsDeleted = verifications.count;

    // Disk, not rows: abandoned chunked uploads and the scratch directories of
    // jobs whose worker was killed before it could clean up after itself.
    result.uploadsPurged = await purgeExpiredUploads();
    result.jobTmpDirsRemoved = await purgeOldJobTmpDirs();
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.error("[retention] sweep failed", error);
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}
