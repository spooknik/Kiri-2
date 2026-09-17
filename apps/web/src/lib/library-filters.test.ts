// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { DEFAULT_LIBRARY_FILTERS, useLibraryFilters } from "./library-filters";

const STORAGE_KEY = "kiri.library.filters";

afterEach(cleanup);

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("useLibraryFilters", () => {
  it("starts with defaults and has scope/sort/adult set", () => {
    const { result } = renderHook(() => useLibraryFilters());
    expect(result.current.filters).toEqual(DEFAULT_LIBRARY_FILTERS);
    expect(result.current.filters.scope).toBe("tracked");
    expect(result.current.filters.sort).toBe("updated");
    expect(result.current.filters.adult).toBe("include");
  });

  it("hydrates from a previously persisted value after mount", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_LIBRARY_FILTERS, status: "READING", scope: "all" }),
    );

    const { result } = renderHook(() => useLibraryFilters());
    await act(async () => {});

    expect(result.current.filters.status).toBe("READING");
    expect(result.current.filters.scope).toBe("all");
  });

  it("persists filter changes to localStorage", async () => {
    const { result } = renderHook(() => useLibraryFilters());
    await act(async () => {});

    act(() => {
      result.current.setFilters((prev) => ({ ...prev, favorite: "1" }));
    });

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as {
      favorite?: string;
    };
    expect(stored.favorite).toBe("1");
  });

  it("reflects q in the ?q= URL search param, and clears it when q is unset", async () => {
    const { result } = renderHook(() => useLibraryFilters());
    await act(async () => {});

    act(() => {
      result.current.setFilters((prev) => ({ ...prev, q: "one piece" }));
    });
    expect(new URLSearchParams(window.location.search).get("q")).toBe("one piece");

    act(() => {
      result.current.setFilters((prev) => ({ ...prev, q: undefined }));
    });
    expect(new URLSearchParams(window.location.search).get("q")).toBeNull();
  });

  it("prefers a ?q= URL param over a stored value on load", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_LIBRARY_FILTERS, q: "stored" }),
    );
    window.history.replaceState(null, "", "/?q=from-url");

    const { result } = renderHook(() => useLibraryFilters());
    await act(async () => {});

    expect(result.current.filters.q).toBe("from-url");
  });

  it("falls back to defaults when localStorage holds invalid JSON", async () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");

    const { result } = renderHook(() => useLibraryFilters());
    await act(async () => {});

    expect(result.current.filters).toEqual(DEFAULT_LIBRARY_FILTERS);
  });

  it("falls back to defaults when localStorage holds a value that fails schema validation", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ scope: "not-a-real-scope" }));

    const { result } = renderHook(() => useLibraryFilters());
    await act(async () => {});

    expect(result.current.filters).toEqual(DEFAULT_LIBRARY_FILTERS);
  });

  it("resetFilters restores defaults", async () => {
    const { result } = renderHook(() => useLibraryFilters());
    await act(async () => {});

    act(() => {
      result.current.setFilters((prev) => ({ ...prev, status: "DROPPED" }));
    });
    expect(result.current.filters.status).toBe("DROPPED");

    act(() => {
      result.current.resetFilters();
    });
    expect(result.current.filters).toEqual(DEFAULT_LIBRARY_FILTERS);
  });
});
