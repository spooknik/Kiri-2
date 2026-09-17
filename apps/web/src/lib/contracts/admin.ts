/**
 * Admin contract: users, invites, instance settings, audit log. Every route
 * under /api/admin requires role "admin" (withAuth({ role: "admin" })).
 */
import { z } from "zod";

export const ROLES = ["admin", "member"] as const;
export type Role = (typeof ROLES)[number];

export const REGISTRATION_MODES = ["INVITE", "OPEN", "CLOSED"] as const;
export type RegistrationMode = (typeof REGISTRATION_MODES)[number];

// Users -----------------------------------------------------------------------

export interface AdminUserView {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  banned: boolean;
  banReason: string | null;
  mustSetPassword: boolean;
  createdAt: string;
  seriesCreated: number;
  seriesTracked: number;
}

/** PATCH /api/admin/users/:id — an admin cannot demote or ban themselves. */
export const updateUserSchema = z.object({
  role: z.enum(ROLES).optional(),
  banned: z.boolean().optional(),
  banReason: z.string().trim().max(300).nullish(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

// Invites ---------------------------------------------------------------------

export const INVITE_STATUSES = ["PENDING", "ACCEPTED", "REVOKED", "EXPIRED"] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

export const createInviteSchema = z.object({
  email: z.email().max(200).nullish(),
  role: z.enum(ROLES).default("member"),
  expiresInDays: z.number().int().min(1).max(90).default(14),
});
export type CreateInviteInput = z.infer<typeof createInviteSchema>;

export interface InviteView {
  id: string;
  email: string | null;
  role: Role;
  status: InviteStatus;
  expiresAt: string;
  createdAt: string;
  createdBy: { id: string; displayName: string };
  redeemedBy: { id: string; displayName: string } | null;
  /** Only present in the POST response; the raw token is never stored. */
  url?: string;
}

// Settings --------------------------------------------------------------------

export const AUTO_SYNC_PRESETS_MINUTES = [360, 720, 1440, 2880, 10080] as const;

export const updateSettingsSchema = z.object({
  instanceName: z.string().trim().min(1).max(60).optional(),
  registrationMode: z.enum(REGISTRATION_MODES).optional(),
  autoSyncEnabled: z.boolean().optional(),
  autoSyncIntervalMinutes: z.number().int().min(60).max(43_200).optional(),
  verbosePluginLogging: z.boolean().optional(),
  notificationRetentionDays: z.number().int().min(7).max(3650).optional(),
  jobLogRetentionDays: z.number().int().min(1).max(365).optional(),
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export interface AppSettingsView {
  instanceName: string;
  registrationMode: RegistrationMode;
  autoSyncEnabled: boolean;
  autoSyncIntervalMinutes: number;
  verbosePluginLogging: boolean;
  notificationRetentionDays: number;
  jobLogRetentionDays: number;
  updatedAt: string;
}

// Audit -----------------------------------------------------------------------

export const auditQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export interface AuditEntryView {
  id: string;
  actor: { id: string; displayName: string } | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AuditPage {
  items: AuditEntryView[];
  nextCursor: string | null;
}
