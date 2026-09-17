/**
 * The per-series content source.
 *
 *   GET    — the current source (view access: the panel is read-only for
 *            people who can see the series but not edit it).
 *   PUT    — bind a URL: resolve it, create or replace the source, and start a
 *            first sync straight away.
 *   PATCH  — auto-sync mode/interval and plugin settings.
 *   DELETE — unbind. Chapters, pages and files stay.
 *
 * Every mutation is creator-or-admin; the checks live in
 * `src/lib/plugins/source.ts` so no caller can skip them.
 */
import { z } from "zod";
import { withAuth } from "@/lib/api";
import { configureSourceSchema, updateSourceSchema } from "@/lib/contracts/plugins";
import { configureSource, getSourceView, unbindSource, updateSource } from "@/lib/plugins/source";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

export const GET = withAuth({ params: paramsSchema }, ({ user, params }) =>
  getSourceView(user, params.id),
);

export const PUT = withAuth(
  { params: paramsSchema, body: configureSourceSchema },
  ({ user, params, body }) => configureSource(user, params.id, body),
);

export const PATCH = withAuth(
  { params: paramsSchema, body: updateSourceSchema },
  ({ user, params, body }) => updateSource(user, params.id, body),
);

export const DELETE = withAuth({ params: paramsSchema }, async ({ user, params }) => {
  await unbindSource(user, params.id);
  return undefined;
});
