// @vitest-environment jsdom
/**
 * The spoiler shield and the reveal it triggers, through the card that owns
 * it: clicking must fetch the same note again with `reveal=1` and swap the
 * placeholder for the body the server hands back.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui";
import type { NoteThread, NoteView } from "@/lib/contracts/notes";
import { NoteCard } from "./note-card";
import { SpoilerShield } from "./spoiler-shield";

// Hoisted with the mock factory: `vi.mock` runs before module-level consts.
const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock("@/lib/api-client", () => ({
  api: { get: apiGet, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  apiFetch: vi.fn(),
  ApiClientError: class ApiClientError extends Error {},
}));

const SERIES_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "22222222-2222-4222-8222-222222222222";

function hiddenNote(overrides: Partial<NoteView> = {}): NoteView {
  return {
    id: NOTE_ID,
    seriesId: SERIES_ID,
    chapterId: null,
    chapter: null,
    pageIndex: null,
    pinX: null,
    pinY: null,
    body: "",
    author: { id: "author", displayName: "Author" },
    parentId: null,
    isSpoiler: false,
    hidden: true,
    replyCount: 0,
    canEdit: false,
    editedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  apiGet.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("SpoilerShield", () => {
  it("names the reason and calls back on click", () => {
    const onReveal = vi.fn();
    render(<SpoilerShield reason="spoiler" onReveal={onReveal} />);

    const shield = screen.getByTestId("spoiler-shield");
    expect(shield.textContent).toContain("marked spoiler");
    expect(shield.textContent).toContain("Reveal");

    fireEvent.click(shield);
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("says so when the note is beyond your progress", () => {
    render(<SpoilerShield reason="progress" onReveal={vi.fn()} />);
    expect(screen.getByTestId("spoiler-shield").textContent).toContain("beyond your progress");
  });
});

describe("NoteCard reveal", () => {
  it("fetches the note with reveal=1 and shows the body", async () => {
    const revealed: NoteThread = {
      note: hiddenNote({ body: "the twist is real" }),
      replies: [],
    };
    apiGet.mockResolvedValue(revealed);

    render(
      <Wrapper>
        <NoteCard seriesId={SERIES_ID} note={hiddenNote()} />
      </Wrapper>,
    );

    expect(screen.getByTestId("spoiler-shield")).toBeTruthy();
    expect(apiGet).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("spoiler-shield"));

    await waitFor(() => {
      expect(screen.queryByText("the twist is real")).not.toBeNull();
    });

    expect(apiGet).toHaveBeenCalledWith(`/api/notes/${NOTE_ID}`, { query: { reveal: 1 } });
    expect(screen.queryByTestId("spoiler-shield")).toBeNull();
  });

  it("renders a deleted note as a placeholder rather than a shield", () => {
    render(
      <Wrapper>
        <NoteCard seriesId={SERIES_ID} note={hiddenNote({ hidden: false, body: "" })} />
      </Wrapper>,
    );

    expect(screen.queryByTestId("spoiler-shield")).toBeNull();
    expect(screen.queryByText("This note was deleted.")).not.toBeNull();
  });
});
