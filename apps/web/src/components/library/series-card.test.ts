// @vitest-environment jsdom
//
// Named `.ts` (not `.tsx`) to match this project's vitest `include` glob, so
// JSX is written via `createElement` instead of JSX syntax (see dialog.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import type { SeriesSummary } from "@/lib/contracts";
import { useUpdateEntry } from "@/hooks/use-entry";
import { SeriesCard } from "./series-card";

afterEach(cleanup);

vi.mock("@/hooks/use-entry", () => ({
  useUpdateEntry: vi.fn(),
}));

const mockedUseUpdateEntry = vi.mocked(useUpdateEntry);

function mockUpdateEntry(mutate = vi.fn()) {
  mockedUseUpdateEntry.mockReturnValue({
    mutate,
    isPending: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return mutate;
}

function makeSeries(overrides: Partial<SeriesSummary> = {}): SeriesSummary {
  return {
    id: "series-1",
    title: "One Piece",
    originalTitle: "ワンピース",
    mediaType: "MANGA",
    visibility: "SHARED",
    isAdult: false,
    isBookClub: false,
    coverUrl: null,
    tags: [],
    chapterCount: 1100,
    lastChapterAt: null,
    totalChapters: null,
    createdBy: { id: "user-1", displayName: "Alice" },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T00:00:00.000Z",
    entry: null,
    readerCount: 1,
    canEdit: true,
    ...overrides,
  };
}

describe("SeriesCard", () => {
  it("renders title, badges, progress, and reader count", () => {
    mockUpdateEntry();
    const series = makeSeries({
      isBookClub: true,
      isAdult: true,
      readerCount: 3,
      entry: {
        status: "READING",
        currentChapter: 42,
        rating: null,
        notes: null,
        favorite: false,
        joinedAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    });

    render(createElement(SeriesCard, { series }));

    expect(screen.getByText("One Piece")).toBeInTheDocument();
    expect(screen.getByText("ワンピース")).toBeInTheDocument();
    expect(screen.getByText("Manga")).toBeInTheDocument();
    expect(screen.getByText("Reading")).toBeInTheDocument();
    expect(screen.getByText("Book club")).toBeInTheDocument();
    expect(screen.getByText("18+")).toBeInTheDocument();
    expect(screen.getByText("Ch. 42 / 1100")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("shows a Private badge for private series", () => {
    mockUpdateEntry();
    render(createElement(SeriesCard, { series: makeSeries({ visibility: "PRIVATE" }) }));
    expect(screen.getByText("Private")).toBeInTheDocument();
  });

  it("calls the update-entry mutation with an incremented chapter when '+1 chapter' is clicked", () => {
    const mutate = mockUpdateEntry();
    const series = makeSeries({
      entry: {
        status: "READING",
        currentChapter: 5,
        rating: null,
        notes: null,
        favorite: false,
        joinedAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    });

    render(createElement(SeriesCard, { series }));
    fireEvent.click(screen.getByRole("button", { name: "+1 chapter" }));

    expect(mutate).toHaveBeenCalledWith({ currentChapter: 6 });
  });

  it("also sets status to READING when bumping a PLAN_TO_READ entry", () => {
    const mutate = mockUpdateEntry();
    const series = makeSeries({
      entry: {
        status: "PLAN_TO_READ",
        currentChapter: 0,
        rating: null,
        notes: null,
        favorite: false,
        joinedAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    });

    render(createElement(SeriesCard, { series }));
    fireEvent.click(screen.getByRole("button", { name: "+1 chapter" }));

    expect(mutate).toHaveBeenCalledWith({ currentChapter: 1, status: "READING" });
  });

  it("shows a Track button and calls the mutation with an empty patch when there is no entry", () => {
    const mutate = mockUpdateEntry();
    render(createElement(SeriesCard, { series: makeSeries({ entry: null }) }));

    fireEvent.click(screen.getByRole("button", { name: "Track" }));

    expect(mutate).toHaveBeenCalledWith({});
  });
});
