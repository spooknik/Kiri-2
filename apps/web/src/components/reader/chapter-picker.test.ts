// @vitest-environment jsdom
//
// Named `.ts` (not `.tsx`) to match this project's vitest `include` glob
// (`src/**/*.test.ts`, see vitest.config.mts), so JSX is written via
// `createElement` instead of JSX syntax.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import type { ChapterListItem } from "@/lib/contracts/content";
import { ChapterPicker } from "./chapter-picker";

afterEach(cleanup);

// jsdom implements neither <dialog>'s modal behaviour nor scrollIntoView.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  });
  Element.prototype.scrollIntoView = vi.fn();
});

function chapter(overrides: Partial<ChapterListItem> & { id: string }): ChapterListItem {
  return {
    slug: overrides.id,
    title: "Untitled",
    number: null,
    pageCount: 12,
    volume: null,
    status: "COMPLETED",
    origin: "PLUGIN",
    bytes: 1000,
    sourceUrl: null,
    releaseDate: null,
    downloadedAt: null,
    sortIndex: 0,
    read: false,
    readAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const chapters: ChapterListItem[] = [
  chapter({ id: "c1", title: "Prologue", number: 0, read: true, sortIndex: 0 }),
  chapter({ id: "c2", title: "The Hollow Gate", number: 1, sortIndex: 1 }),
  chapter({ id: "c3", title: "Ashes", number: 2, volume: "2", sortIndex: 2 }),
  chapter({ id: "c4", title: "Still downloading", number: 3, status: "PENDING", sortIndex: 3 }),
];

function renderPicker(onSelect = vi.fn(), onClose = vi.fn()) {
  render(
    createElement(ChapterPicker, {
      open: true,
      onClose,
      chapters,
      currentChapterId: "c2",
      onSelect,
    }),
  );
  return { onSelect, onClose };
}

function chapterButtons(): HTMLElement[] {
  return screen
    .getAllByRole("button", { hidden: true })
    .filter((button) => button.closest("[data-testid='chapter-picker-list']") !== null);
}

describe("ChapterPicker", () => {
  it("lists every chapter with its number and title", () => {
    renderPicker();
    const labels = chapterButtons().map((button) => button.textContent ?? "");
    expect(labels).toHaveLength(4);
    expect(labels[0]).toContain("Ch. 0 - Prologue");
    expect(labels[1]).toContain("Ch. 1 - The Hollow Gate");
  });

  it("filters by title as you type", () => {
    renderPicker();
    fireEvent.change(screen.getByLabelText("Filter chapters"), { target: { value: "hollow" } });

    const labels = chapterButtons().map((button) => button.textContent ?? "");
    expect(labels).toHaveLength(1);
    expect(labels[0]).toContain("The Hollow Gate");
  });

  it("filters by chapter number and by volume", () => {
    renderPicker();
    const input = screen.getByLabelText("Filter chapters");

    fireEvent.change(input, { target: { value: "2" } });
    expect(
      chapterButtons()
        .map((b) => b.textContent ?? "")
        .join("|"),
    ).toContain("Ashes");

    fireEvent.change(input, { target: { value: "PROLO" } });
    expect(chapterButtons()).toHaveLength(1);
  });

  it("says so when nothing matches", () => {
    renderPicker();
    fireEvent.change(screen.getByLabelText("Filter chapters"), { target: { value: "zzzz" } });
    expect(chapterButtons()).toHaveLength(0);
    expect(screen.getByText(/no chapters match/i)).toBeInTheDocument();
  });

  it("marks the current chapter and ticks the ones already read", () => {
    renderPicker();
    const buttons = chapterButtons();
    expect(buttons[1]).toHaveAttribute("aria-current", "true");
    expect(buttons[0]).not.toHaveAttribute("aria-current");
    expect(screen.getAllByLabelText("Read")).toHaveLength(1);
  });

  it("disables chapters that can't be opened yet", () => {
    renderPicker();
    expect(chapterButtons()[3]).toBeDisabled();
  });

  it("selects a chapter and closes", () => {
    const { onSelect, onClose } = renderPicker();
    const target = chapterButtons()[2];
    expect(target).toBeDefined();
    fireEvent.click(target as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith("c3");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
