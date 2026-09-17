// @vitest-environment jsdom
//
// Named `.ts` (not `.tsx`) to match this project's vitest `include` glob, so
// JSX is written via `createElement` instead of JSX syntax (see dialog.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { createElement, type ReactNode } from "react";
import { ToastProvider } from "@/components/ui";
import type { ApiClientError } from "@/lib/api-client";
import type { SourceView } from "@/lib/contracts/plugins";
import { SourceSection } from "./source-section";

// `ConfigureSourceDialog` calls `useRouter()` unconditionally (it's always
// mounted, just closed) and `Button`/`AppLink` render a `next/link` — both
// need an app-router context this bare render doesn't provide. Mock both to
// plain stand-ins, matching this file's read-only-JS-rendering conventions.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: { href: string; children?: ReactNode } & Record<string, unknown>) =>
    createElement("a", { href, ...props }, children),
}));

let sourceResult: {
  data: SourceView | undefined;
  isPending: boolean;
  isError: boolean;
  error: ApiClientError | null;
} = { data: undefined, isPending: true, isError: false, error: null };
let profileResult: { data: { role: "admin" | "member" } | undefined } = {
  data: { role: "admin" },
};

const updateSourceMutate = vi.fn();
const requestSyncMutate = vi.fn();
const unbindSourceMutate = vi.fn();
const clearCredentialMutate = vi.fn();

vi.mock("@/hooks/use-source", () => ({
  useSource: () => sourceResult,
  useUpdateSource: () => ({ mutate: updateSourceMutate, isPending: false }),
  useRequestSync: () => ({ mutate: requestSyncMutate, isPending: false, variables: undefined }),
  useUnbindSource: () => ({ mutate: unbindSourceMutate, isPending: false }),
  useClearSourceCredential: () => ({ mutate: clearCredentialMutate, isPending: false }),
  useConfigureSource: () => ({ mutate: vi.fn(), isPending: false }),
  useSetSourceCredential: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/use-plugins", () => ({
  useResolveUrl: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/use-jobs", () => ({
  useSeriesJobs: () => ({ data: { pages: [{ items: [] }] } }),
}));

vi.mock("@/hooks/use-profile", () => ({
  useProfile: () => profileResult,
}));

beforeEach(() => {
  // jsdom doesn't implement <dialog>'s modal behavior; the always-mounted
  // Configure/Credential/Disconnect dialogs need the same polyfill as
  // dialog.test.ts.
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
  updateSourceMutate.mockClear();
  requestSyncMutate.mockClear();
  unbindSourceMutate.mockClear();
  clearCredentialMutate.mockClear();
  profileResult = { data: { role: "admin" } };
});

const baseSource: SourceView = {
  seriesId: "series-1",
  plugin: { id: "mangadex", name: "MangaDex", status: "ENABLED", needsCookie: false },
  v1Site: null,
  normalizedUrl: "https://mangadex.org/title/abc",
  status: "READY",
  lastError: null,
  lastErrorCode: null,
  lastSyncedAt: "2026-01-01T00:00:00.000Z",
  hasSeriesCookie: false,
  cookieUpdatedAt: null,
  hasPluginCredential: false,
  autoSyncMode: "INHERIT",
  autoSyncIntervalMinutes: null,
  effectiveIntervalMinutes: 1440,
  activeJobId: null,
  settings: {},
};

function renderSection(props: { seriesId?: string; canEdit?: boolean } = {}) {
  const queryClient = new QueryClient();
  return render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        ToastProvider,
        null,
        createElement(SourceSection, {
          seriesId: props.seriesId ?? "series-1",
          canEdit: props.canEdit ?? true,
        }),
      ),
    ),
  );
}

describe("SourceSection", () => {
  it("UNCONFIGURED: offers to connect a source", () => {
    sourceResult = {
      data: { ...baseSource, status: "UNCONFIGURED", plugin: null, lastSyncedAt: null },
      isPending: false,
      isError: false,
      error: null,
    };
    renderSection();
    expect(screen.getByText("This series has no content source connected.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /connect a source/i })).toBeInTheDocument();
    // Nothing to disconnect yet.
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  });

  it("NEEDS_PLUGIN: explains the missing plugin and points admins at Admin → Plugins", () => {
    sourceResult = {
      data: { ...baseSource, status: "NEEDS_PLUGIN", plugin: null, v1Site: "yaoiscan" },
      isPending: false,
      isError: false,
      error: null,
    };
    renderSection();
    expect(screen.getByText(/Kiri 1\.x's "yaoiscan" site/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /admin → plugins/i })).toHaveAttribute(
      "href",
      "/admin/plugins",
    );
  });

  it("NEEDS_PLUGIN: tells a non-admin to ask an admin instead of linking", () => {
    profileResult = { data: { role: "member" } };
    sourceResult = {
      data: { ...baseSource, status: "NEEDS_PLUGIN", plugin: null },
      isPending: false,
      isError: false,
      error: null,
    };
    renderSection();
    expect(screen.getByText(/ask an admin to install it/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /admin → plugins/i })).not.toBeInTheDocument();
  });

  it("READY: shows last-synced status and sync/verify/auto-sync controls", () => {
    sourceResult = {
      data: { ...baseSource, status: "READY" },
      isPending: false,
      isError: false,
      error: null,
    };
    renderSection();
    expect(screen.getByText(/MangaDex/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sync now/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /verify/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Auto-sync")).toHaveValue("INHERIT");
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
  });

  it("FAILED + NEEDS_CREDENTIAL: shows the cookie card with paste + extension actions for an admin", () => {
    sourceResult = {
      data: {
        ...baseSource,
        status: "FAILED",
        lastError: "Cloudflare challenge detected",
        lastErrorCode: "NEEDS_CREDENTIAL",
        plugin: { id: "mangadex", name: "MangaDex", status: "ENABLED", needsCookie: true },
      },
      isPending: false,
      isError: false,
      error: null,
    };
    renderSection();
    expect(screen.getByText("Cloudflare challenge detected")).toBeInTheDocument();
    expect(screen.getByText("This site needs a browser cookie")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /paste cookie/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /use the cookie bridge extension/i })).toHaveAttribute(
      "href",
      "/admin/plugins",
    );
  });

  it("FAILED + NEEDS_CREDENTIAL: tells a member to ask an admin instead of linking to Admin → Plugins", () => {
    profileResult = { data: { role: "member" } };
    sourceResult = {
      data: {
        ...baseSource,
        status: "FAILED",
        lastError: "Cloudflare challenge detected",
        lastErrorCode: "NEEDS_CREDENTIAL",
      },
      isPending: false,
      isError: false,
      error: null,
    };
    renderSection();
    expect(
      screen.getByText(/ask an admin to set up the cookie bridge extension/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /use the cookie bridge extension/i }),
    ).not.toBeInTheDocument();
  });

  it("members (canEdit: false) see only a read-only status line, no actions", () => {
    sourceResult = {
      data: { ...baseSource, status: "READY" },
      isPending: false,
      isError: false,
      error: null,
    };
    renderSection({ canEdit: false });
    expect(screen.getByText(/synced/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sync now/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /connect a source/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  });
});
