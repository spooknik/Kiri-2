// @vitest-environment jsdom
//
// Named `.ts` (not `.tsx`) to match this project's vitest `include` glob
// (`src/**/*.test.ts`, see vitest.config.mts), so JSX is written via
// `createElement` instead of JSX syntax.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import { ToastProvider, useToast } from "./toast";

// vitest.config.mts doesn't set `test.globals: true`, so @testing-library/react
// can't auto-detect `afterEach` to register its automatic cleanup — do it explicitly.
afterEach(cleanup);

function Trigger() {
  const { toast } = useToast();
  return createElement(
    "button",
    {
      type: "button",
      onClick: () => toast({ title: "Saved", description: "Your changes were saved." }),
    },
    "Show toast",
  );
}

describe("Toast", () => {
  it("throws when useToast is used outside a ToastProvider", () => {
    function Bare() {
      useToast();
      return null;
    }
    expect(() => render(createElement(Bare))).toThrow(/ToastProvider/);
  });

  it("shows a toast and auto-dismisses after its duration", () => {
    vi.useFakeTimers();
    render(createElement(ToastProvider, null, createElement(Trigger)));

    act(() => {
      screen.getByRole("button", { name: /show toast/i }).click();
    });
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.getByText("Your changes were saved.")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("dismisses when the dismiss button is clicked", () => {
    render(createElement(ToastProvider, null, createElement(Trigger)));

    act(() => {
      screen.getByRole("button", { name: /show toast/i }).click();
    });
    expect(screen.getByText("Saved")).toBeInTheDocument();

    act(() => {
      screen.getByRole("button", { name: /dismiss notification/i }).click();
    });
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });
});
