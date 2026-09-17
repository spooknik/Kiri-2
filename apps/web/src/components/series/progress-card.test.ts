// @vitest-environment jsdom
//
// Named `.ts` (not `.tsx`) to match this project's vitest `include` glob
// (`src/**/*.test.ts`, see vitest.config.mts), so JSX is written via
// `createElement` instead of JSX syntax — see src/components/ui/dialog.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import type { LibraryEntryView } from "@/lib/contracts/series";
import { ProgressCard } from "./progress-card";

const updateEntryMutate = vi.fn();
const untrackMutate = vi.fn();

vi.mock("@/hooks/use-entry", () => ({
  useUpdateEntry: () => ({ mutate: updateEntryMutate, isPending: false }),
  useUntrackSeries: () => ({ mutate: untrackMutate, isPending: false }),
}));

// jsdom doesn't implement <dialog>'s modal behavior; the card always renders
// a (closed) ConfirmDialog for "Stop tracking", so polyfill as in dialog.test.ts.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  });
});

afterEach(() => {
  cleanup();
  updateEntryMutate.mockClear();
  untrackMutate.mockClear();
});

const entry: LibraryEntryView = {
  status: "READING",
  currentChapter: 12,
  rating: null,
  notes: null,
  favorite: false,
  joinedAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

describe("ProgressCard", () => {
  it("calls useUpdateEntry's mutate with the incremented chapter on '+1 chapter'", () => {
    render(createElement(ProgressCard, { seriesId: "series-1", entry, totalChapters: 100 }));

    fireEvent.click(screen.getByRole("button", { name: /\+1 chapter/i }));

    expect(updateEntryMutate).toHaveBeenCalledTimes(1);
    expect(updateEntryMutate).toHaveBeenCalledWith({ currentChapter: 13 });
  });

  it("does not call useUntrackSeries's mutate until the confirm dialog is accepted", () => {
    render(createElement(ProgressCard, { seriesId: "series-1", entry, totalChapters: null }));

    fireEvent.click(screen.getByRole("button", { name: /stop tracking/i }));
    expect(untrackMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^stop tracking$/i, hidden: true }));
    expect(untrackMutate).toHaveBeenCalledTimes(1);
  });
});
