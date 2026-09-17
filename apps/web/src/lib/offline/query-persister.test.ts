import { describe, expect, it } from "vitest";
import { contentQueryKeys } from "@/lib/content-query-keys";
import { queryKeys } from "@/lib/query-keys";
import { readerKeys } from "@/lib/reader/query-keys";
import { shouldPersistQueryKey } from "@/lib/offline/query-persister";

/**
 * The allow-list is written as string roots, so it can silently drift from the
 * key factories it is supposed to describe. These assertions tie the two
 * together.
 */
describe("shouldPersistQueryKey", () => {
  it("persists the caches a cold offline launch needs", () => {
    expect(shouldPersistQueryKey(queryKeys.libraryAll)).toBe(true);
    expect(shouldPersistQueryKey(queryKeys.library({ status: "READING" }))).toBe(true);
    expect(shouldPersistQueryKey(queryKeys.series("abc"))).toBe(true);
    expect(shouldPersistQueryKey(queryKeys.notifications)).toBe(true);
    expect(shouldPersistQueryKey(contentQueryKeys.chapters("abc"))).toBe(true);
    expect(shouldPersistQueryKey(contentQueryKeys.continueReading)).toBe(true);
    expect(shouldPersistQueryKey(readerKeys.chapters("abc"))).toBe(true);
    expect(shouldPersistQueryKey(readerKeys.chapter("abc"))).toBe(true);
  });

  it("does not persist volatile or privileged caches", () => {
    expect(shouldPersistQueryKey(contentQueryKeys.jobsAll)).toBe(false);
    expect(shouldPersistQueryKey(contentQueryKeys.runnerStatus)).toBe(false);
    expect(shouldPersistQueryKey(queryKeys.admin.users)).toBe(false);
    expect(shouldPersistQueryKey(queryKeys.malSearch("naruto"))).toBe(false);
    expect(shouldPersistQueryKey(queryKeys.profile)).toBe(false);
  });

  it("ignores keys whose root is not a string", () => {
    expect(shouldPersistQueryKey([])).toBe(false);
    expect(shouldPersistQueryKey([{ scope: "library" }])).toBe(false);
  });
});
