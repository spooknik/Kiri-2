import { notFound } from "next/navigation";
import { SeriesView } from "@/components/series/series-view";
import { requireUser } from "@/lib/auth/session";

// Series ids are UUID primary keys (see prisma/schema.prisma); reject anything else up
// front instead of round-tripping a doomed request to the API.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function SeriesPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    notFound();
  }

  return <SeriesView id={id} />;
}
