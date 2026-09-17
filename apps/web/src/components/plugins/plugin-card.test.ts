// @vitest-environment jsdom
//
// Named `.ts` (not `.tsx`) to match this project's vitest `include` glob, so
// JSX is written via `createElement` instead of JSX syntax (see dialog.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import { ToastProvider } from "@/components/ui";
import type { PluginView } from "@/lib/contracts/plugins";
import { PluginCard } from "./plugin-card";

const updatePluginMutate = vi.fn();
const uninstallPluginMutate = vi.fn();

let updatePluginState: { isPending: boolean; variables?: { id: string } } = { isPending: false };
let uninstallPluginState: { isPending: boolean; variables?: string } = { isPending: false };

vi.mock("@/hooks/use-plugins", () => ({
  useUpdatePlugin: () => ({ mutate: updatePluginMutate, ...updatePluginState }),
  useUninstallPlugin: () => ({ mutate: uninstallPluginMutate, ...uninstallPluginState }),
}));

// jsdom doesn't implement <dialog>'s modal behavior; the uninstall
// ConfirmDialog always mounts (closed) — polyfill as in dialog.test.ts.
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
  updatePluginMutate.mockClear();
  uninstallPluginMutate.mockClear();
  updatePluginState = { isPending: false };
  uninstallPluginState = { isPending: false };
});

const basePlugin: PluginView = {
  id: "mangadex",
  name: "MangaDex",
  version: "1.2.0",
  sdkRange: "^2.0.0",
  hosts: ["mangadex.org", "*.mangadex.org"],
  capabilities: ["network"],
  mediaTypes: ["MANGA"],
  adult: false,
  homepage: null,
  license: null,
  status: "ENABLED",
  lastError: null,
  installSource: null,
  installedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  sourceCount: 3,
  hasCredential: false,
};

function renderCard(plugin: Partial<PluginView> = {}) {
  return render(
    createElement(
      ToastProvider,
      null,
      createElement(PluginCard, { plugin: { ...basePlugin, ...plugin } }),
    ),
  );
}

describe("PluginCard", () => {
  it("shows the status badge and plain (non-warning) capability badges", () => {
    renderCard();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
    expect(screen.getByText("Network")).toBeInTheDocument();
    expect(screen.queryByText("18+")).not.toBeInTheDocument();
  });

  it("shows the adult badge when the plugin is marked adult", () => {
    renderCard({ adult: true });
    expect(screen.getByText("18+")).toBeInTheDocument();
  });

  it("flags browser/subprocess capabilities with a warning tooltip", () => {
    renderCard({ capabilities: ["network", "browser", "subprocess"] });
    const browserBadge = screen.getByText("Browser");
    const subprocessBadge = screen.getByText("Subprocess");
    expect(browserBadge.closest("span")).toHaveAttribute(
      "title",
      "Runs a browser / child processes on the server",
    );
    expect(subprocessBadge.closest("span")).toHaveAttribute(
      "title",
      "Runs a browser / child processes on the server",
    );
  });

  it("shows lastError when set", () => {
    renderCard({ status: "BROKEN", lastError: "Descriptor validation failed" });
    expect(screen.getByText("Broken")).toBeInTheDocument();
    expect(screen.getByText("Descriptor validation failed")).toBeInTheDocument();
  });

  it("toggles Enable/Disable and calls the update mutation", () => {
    renderCard({ status: "ENABLED" });
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(updatePluginMutate).toHaveBeenCalledWith(
      { id: "mangadex", input: { status: "DISABLED" } },
      expect.anything(),
    );
  });

  it("shows Enable when the plugin is disabled", () => {
    renderCard({ status: "DISABLED" });
    expect(screen.getByRole("button", { name: "Enable" })).toBeInTheDocument();
  });

  it("disables the toggle button (loading) only while this plugin's mutation is pending", () => {
    updatePluginState = { isPending: true, variables: { id: "mangadex" } };
    renderCard();
    expect(screen.getByRole("button", { name: /disable/i })).toBeDisabled();
  });

  it("does not show the toggle button as loading for a different plugin's pending mutation", () => {
    updatePluginState = { isPending: true, variables: { id: "some-other-plugin" } };
    renderCard();
    expect(screen.getByRole("button", { name: "Disable" })).not.toBeDisabled();
  });

  it("opens a confirm dialog mentioning affected series before uninstalling", () => {
    renderCard({ sourceCount: 5 });
    fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
    expect(
      screen.getByText("5 series will need this plugin installed again to sync."),
    ).toBeInTheDocument();
  });
});
