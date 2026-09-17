"use client";

/**
 * Feature slots on the series page that are owned by separate modules:
 * the content-source section (plugins) and the notes section. Keeping the
 * mount point here means those modules never edit series-view.tsx.
 */
import { NotesSection } from "@/components/series/notes/notes-section";
import { SourceSection } from "@/components/series/source/source-section";

export interface SeriesExtrasProps {
  seriesId: string;
  canEdit: boolean;
}

export function SeriesExtras({ seriesId, canEdit }: SeriesExtrasProps) {
  return (
    <>
      <SourceSection seriesId={seriesId} canEdit={canEdit} />
      <NotesSection seriesId={seriesId} canEdit={canEdit} />
    </>
  );
}
