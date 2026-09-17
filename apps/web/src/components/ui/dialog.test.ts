// @vitest-environment jsdom
//
// Named `.ts` (not `.tsx`) to match this project's vitest `include` glob
// (`src/**/*.test.ts`, see vitest.config.mts), so JSX is written via
// `createElement` instead of JSX syntax.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { createElement, useState } from "react";
import { Dialog } from "./dialog";

// vitest.config.mts doesn't set `test.globals: true`, so @testing-library/react
// can't auto-detect `afterEach` to register its automatic cleanup — do it explicitly.
afterEach(cleanup);

// jsdom doesn't implement the <dialog> element's modal behavior; polyfill
// just enough of showModal/close for the open/close lifecycle this
// component relies on.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  });
});

function ControlledDialog() {
  const [open, setOpen] = useState(true);
  return createElement(
    Dialog,
    { open, onClose: () => setOpen(false), title: "Example dialog" },
    createElement("button", { type: "button" }, "Inside"),
  );
}

describe("Dialog", () => {
  it("opens via showModal and renders its title and content", () => {
    render(createElement(ControlledDialog));
    const dialog = screen.getByRole("dialog", { hidden: true });
    expect(dialog).toHaveAttribute("open");
    expect(screen.getByText("Example dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inside" })).toBeInTheDocument();
  });

  it("closes when the close button is clicked", () => {
    render(createElement(ControlledDialog));
    fireEvent.click(screen.getByRole("button", { name: /close dialog/i }));
    expect(screen.getByRole("dialog", { hidden: true })).not.toHaveAttribute("open");
  });

  it("closes on backdrop click", () => {
    render(createElement(ControlledDialog));
    const dialog = screen.getByRole("dialog", { hidden: true });
    fireEvent.click(dialog);
    expect(dialog).not.toHaveAttribute("open");
  });
});
