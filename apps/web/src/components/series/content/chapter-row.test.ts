// @vitest-environment jsdom
//
// Named `.ts` (not `.tsx`) to match this project's vitest `include` glob
// (`src/**/*.test.ts`, see vitest.config.mts), so JSX is written via
// `createElement` instead of JSX syntax — see src/components/ui/dialog.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import { ToastProvider } from "@/components/ui";
import type { ChapterListItem } from "@/lib/contracts/content";
import { ChapterRow } from "./chapter-row";

const setChapterReadMutate = vi.fn();
const deleteChapterMutate = vi.fn();
const updateChapterMutate = vi.fn();

vi.mock("@/hooks/use-chapters", () => ({
  useSetChapterRead: () => ({ mutate: setChapterReadMutate, isPending: false }),
  useDeleteChapter: () => ({ mutate: deleteChapterMutate, isPending: false }),
  useUpdateChapter: () => ({ mutate: updateChapterMutate, isPending: false }),
}));

// jsdom doesn't implement <dialog>'s modal behavior; EditChapterDialog and
// the delete ConfirmDialog always mount (closed) when canEdit, so polyfill
// as in dialog.test.ts.
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
  setChapterReadMutate.mockClear();
  deleteChapterMutate.mockClear();
  updateChapterMutate.mockClear();
});

const chapter: ChapterListItem = {
  id: "chapter-1",
  slug: "chapter-1",
  title: "Chapter 1",
  number: 1,
  pageCount: 10,
  volume: null,
  status: "COMPLETED",
  origin: "MANUAL",
  bytes: 1_000,
  sourceUrl: null,
  releaseDate: null,
  downloadedAt: null,
  sortIndex: 0,
  read: false,
  readAt: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

function renderRow(overrides: Partial<Parameters<typeof ChapterRow>[0]> = {}) {
  return render(
    createElement(
      ToastProvider,
      null,
      createElement(ChapterRow, {
        seriesId: "series-1",
        chapter,
        canEdit: false,
        onMarkAllReadUpTo: vi.fn(),
        markingAllRead: false,
        ...overrides,
      }),
    ),
  );
}

describe("ChapterRow", () => {
  it("calls useSetChapterRead's mutate with the toggled read state when the read toggle is clicked", () => {
    renderRow();

    fireEvent.click(screen.getByRole("button", { name: /^mark as read$/i }));

    expect(setChapterReadMutate).toHaveBeenCalledTimes(1);
    expect(setChapterReadMutate).toHaveBeenCalledWith({ chapterId: "chapter-1", read: true });
  });

  it("toggles the other way when the chapter is already read", () => {
    renderRow({ chapter: { ...chapter, read: true } });

    fireEvent.click(screen.getByRole("button", { name: /^mark as unread$/i }));

    expect(setChapterReadMutate).toHaveBeenCalledWith({ chapterId: "chapter-1", read: false });
  });

  it("hides the overflow menu (and Edit/Delete) when canEdit is false", () => {
    renderRow({ canEdit: false });

    expect(screen.queryByRole("button", { name: /chapter actions/i })).not.toBeInTheDocument();
  });

  it("shows the overflow menu when canEdit is true", () => {
    renderRow({ canEdit: true });

    expect(screen.getByRole("button", { name: /chapter actions/i })).toBeInTheDocument();
  });
});
