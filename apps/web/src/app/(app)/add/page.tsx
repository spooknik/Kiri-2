"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { TabPanel, Tabs } from "@/components/ui";
import { useUpdateEntry } from "@/hooks/use-entry";
import { useCreateSeries, useMalSearch } from "@/hooks/use-series";
import { ExistingSeriesCard } from "@/components/series/existing-series-card";
import { MalSearchPanel } from "@/components/series/mal-search-panel";
import { SeriesForm } from "@/components/series/series-form";
import {
  EMPTY_SERIES_FORM_VALUES,
  getExistingSeriesId,
  malResultToFormValues,
  toChapterNumber,
  type SeriesFormValues,
} from "@/components/series/series-form-utils";
import type { MalSearchResult } from "@/lib/contracts/search";

type AddTab = "search" | "manual";

const SEARCH_DEBOUNCE_MS = 400;

export default function AddSeriesPage() {
  const router = useRouter();
  const [tab, setTab] = useState<AddTab>("search");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedMalId, setSelectedMalId] = useState<number | null>(null);
  const [values, setValues] = useState<SeriesFormValues>(EMPTY_SERIES_FORM_VALUES);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const search = useMalSearch(debouncedQuery);
  const createSeries = useCreateSeries();
  const existingSeriesId = getExistingSeriesId(createSeries.error);
  // Only ever `.mutate()`d once `existingSeriesId` is set; the placeholder id
  // when it isn't is never invoked.
  const trackExisting = useUpdateEntry(existingSeriesId ?? "");

  function handleSelectResult(result: MalSearchResult) {
    setSelectedMalId(result.malId);
    setValues((prev) => malResultToFormValues(result, prev));
  }

  function handleTrackExisting() {
    if (!existingSeriesId) return;
    trackExisting.mutate(
      { status: values.status, currentChapter: toChapterNumber(values.currentChapter) },
      { onSuccess: () => router.push(`/series/${existingSeriesId}`) },
    );
  }

  const formError = createSeries.error && !existingSeriesId ? createSeries.error.message : null;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold text-foreground">Add a series</h1>

      <Tabs
        items={[
          { value: "search", label: "Search MyAnimeList" },
          { value: "manual", label: "Manual" },
        ]}
        value={tab}
        onValueChange={(v) => setTab(v as AddTab)}
      >
        <TabPanel value="search" activeValue={tab}>
          <MalSearchPanel
            query={query}
            onQueryChange={setQuery}
            results={search.data?.results ?? []}
            isLoading={search.isFetching}
            isError={search.isError}
            selectedMalId={selectedMalId}
            onSelect={handleSelectResult}
          />
        </TabPanel>
        <TabPanel value="manual" activeValue={tab}>
          <p className="text-sm text-muted">Fill in the details below.</p>
        </TabPanel>
      </Tabs>

      {existingSeriesId ? (
        <ExistingSeriesCard
          onTrack={handleTrackExisting}
          onOpen={() => router.push(`/series/${existingSeriesId}`)}
          loading={trackExisting.isPending}
        />
      ) : null}

      <SeriesForm
        values={values}
        onValuesChange={setValues}
        showInitialProgress
        submitLabel="Add to library"
        submitting={createSeries.isPending}
        formError={formError}
        onValidSubmit={(input) => createSeries.mutate(input)}
      />
    </div>
  );
}
