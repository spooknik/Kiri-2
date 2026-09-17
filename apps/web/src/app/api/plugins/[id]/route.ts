/**
 * GET    /api/plugins/:id — one plugin (admin).
 * PATCH  /api/plugins/:id — enable or disable it (admin).
 * DELETE /api/plugins/:id — uninstall it (admin). Series keep their chapters;
 *                           their source is parked as NEEDS_PLUGIN so
 *                           re-installing the plugin picks them back up.
 */
import { z } from "zod";
import { notFound, withAuth } from "@/lib/api";
import { updatePluginSchema } from "@/lib/contracts/plugins";
import { setPluginStatus, uninstallPlugin } from "@/lib/plugins/installer";
import { getPluginView } from "@/lib/plugins/registry";
import { clearResolveCache } from "@/lib/plugins/resolve";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().min(1).max(64) });

export const GET = withAuth({ role: "admin", params: paramsSchema }, async ({ params }) => {
  const plugin = await getPluginView(params.id);
  if (!plugin) throw notFound("Plugin");
  return plugin;
});

export const PATCH = withAuth(
  { role: "admin", params: paramsSchema, body: updatePluginSchema },
  async ({ user, params, body }) => {
    if (body.status === undefined) {
      const plugin = await getPluginView(params.id);
      if (!plugin) throw notFound("Plugin");
      return plugin;
    }
    const updated = await setPluginStatus(params.id, body.status, user.id);
    if (!updated) throw notFound("Plugin");
    // Enabling or disabling changes who answers a URL.
    clearResolveCache();
    return updated;
  },
);

export const DELETE = withAuth(
  { role: "admin", params: paramsSchema },
  async ({ user, params }) => {
    const plugin = await getPluginView(params.id);
    if (!plugin) throw notFound("Plugin");
    await uninstallPlugin(params.id, user.id);
    clearResolveCache();
    return undefined;
  },
);
