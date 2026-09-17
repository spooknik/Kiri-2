import { BookX } from "lucide-react";
import { Button, EmptyState } from "@/components/ui";

/**
 * Shared 404 UI: rendered by `not-found.tsx` (malformed series id, caught
 * server-side) and by `SeriesView` (well-formed id, but the API 404s —
 * deleted, private, or never existed).
 */
export function SeriesNotFound() {
  return (
    <EmptyState
      icon={BookX}
      title="Series not found"
      description="It may have been removed, or you may not have access to it."
      action={
        <Button href="/" variant="secondary">
          Back to library
        </Button>
      }
    />
  );
}
