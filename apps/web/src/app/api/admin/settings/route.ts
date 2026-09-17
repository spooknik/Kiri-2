/**
 * GET   /api/admin/settings — instance settings.
 * PATCH /api/admin/settings — update them; the audit entry names the keys that
 *                             actually changed.
 */
import { withAuth } from "@/lib/api";
import { getSettingsView, updateSettingsView } from "@/lib/admin/settings";
import { updateSettingsSchema } from "@/lib/contracts/admin";

export const dynamic = "force-dynamic";

export const GET = withAuth({ role: "admin" }, () => getSettingsView());

export const PATCH = withAuth({ role: "admin", body: updateSettingsSchema }, ({ user, body }) =>
  updateSettingsView(user, body),
);
