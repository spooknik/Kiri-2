// @vitest-environment jsdom
/**
 * The composer's pin mode and the write it performs.
 *
 * The write is checked through the real seam — `setNoteTransport` with a fake
 * — because that is exactly what the offline queue swaps in: a composer that
 * still worked while calling the API directly would be a broken offline
 * feature.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/ui";
import type { UpsertNoteInput } from "@/lib/contracts/notes";
import { setNoteTransport } from "@/lib/notes/transport";
import { NoteComposer } from "./note-composer";

vi.mock("@/lib/api-client", () => ({
  api: {
    get: vi.fn().mockResolvedValue(null),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  apiFetch: vi.fn(),
  ApiClientError: class ApiClientError extends Error {},
}));

const SERIES_ID = "11111111-1111-4111-8111-111111111111";
const CHAPTER_ID = "33333333-3333-4333-8333-333333333333";

const upsert = vi.fn<(noteId: string, input: UpsertNoteInput) => Promise<null>>();
const remove = vi.fn<(noteId: string) => Promise<void>>();

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  upsert.mockReset().mockResolvedValue(null);
  remove.mockReset().mockResolvedValue(undefined);
  setNoteTransport({ upsert, remove });
});

afterEach(() => {
  cleanup();
  setNoteTransport(null);
});

describe("NoteComposer pin mode", () => {
  it("asks the reader for a pin and reflects the mode", () => {
    const onPinModeChange = vi.fn();
    const { rerender } = render(
      <Wrapper>
        <NoteComposer
          seriesId={SERIES_ID}
          chapterId={CHAPTER_ID}
          pageIndex={4}
          onPinModeChange={onPinModeChange}
        />
      </Wrapper>,
    );

    const toggle = screen.getByTestId("pin-toggle");
    expect(toggle.textContent).toContain("Pin to page");

    fireEvent.click(toggle);
    expect(onPinModeChange).toHaveBeenCalledWith(true);

    rerender(
      <Wrapper>
        <NoteComposer
          seriesId={SERIES_ID}
          chapterId={CHAPTER_ID}
          pageIndex={4}
          pinMode
          onPinModeChange={onPinModeChange}
        />
      </Wrapper>,
    );
    expect(screen.getByTestId("pin-toggle").textContent).toContain("Tap the page");
  });

  it("offers to remove a pin once one has been placed", () => {
    const onClearPin = vi.fn();
    render(
      <Wrapper>
        <NoteComposer
          seriesId={SERIES_ID}
          chapterId={CHAPTER_ID}
          pageIndex={4}
          pin={{ x: 0.2, y: 0.8 }}
          onPinModeChange={vi.fn()}
          onClearPin={onClearPin}
        />
      </Wrapper>,
    );

    const toggle = screen.getByTestId("pin-toggle");
    expect(toggle.textContent).toContain("Remove pin");
    fireEvent.click(toggle);
    expect(onClearPin).toHaveBeenCalledTimes(1);
  });

  it("hides the pin control for a chapter-level note and for replies", () => {
    const { rerender } = render(
      <Wrapper>
        <NoteComposer
          seriesId={SERIES_ID}
          chapterId={CHAPTER_ID}
          pageIndex={null}
          onPinModeChange={vi.fn()}
        />
      </Wrapper>,
    );
    expect(screen.queryByTestId("pin-toggle")).toBeNull();

    rerender(
      <Wrapper>
        <NoteComposer
          seriesId={SERIES_ID}
          chapterId={CHAPTER_ID}
          pageIndex={4}
          parentId="44444444-4444-4444-8444-444444444444"
          onPinModeChange={vi.fn()}
        />
      </Wrapper>,
    );
    expect(screen.queryByTestId("pin-toggle")).toBeNull();
  });
});

describe("NoteComposer write", () => {
  it("posts through the note transport with the pin and the spoiler flag", async () => {
    render(
      <Wrapper>
        <NoteComposer
          seriesId={SERIES_ID}
          chapterId={CHAPTER_ID}
          pageIndex={4}
          pin={{ x: 0.25, y: 0.75 }}
          onPinModeChange={vi.fn()}
          onClearPin={vi.fn()}
        />
      </Wrapper>,
    );

    fireEvent.change(screen.getByLabelText("New note"), {
      target: { value: "  pinned thought  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /post note/i }));

    await waitFor(() => {
      expect(upsert).toHaveBeenCalledTimes(1);
    });

    const call = upsert.mock.calls[0]!;
    expect(call[0]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(call[1]).toMatchObject({
      seriesId: SERIES_ID,
      chapterId: CHAPTER_ID,
      pageIndex: 4,
      pinX: 0.25,
      pinY: 0.75,
      body: "pinned thought",
      parentId: null,
      isSpoiler: false,
    });

    // The textarea clears so the next note starts empty.
    expect((screen.getByLabelText("New note") as HTMLTextAreaElement).value).toBe("");
  });

  it("does nothing for an empty body", () => {
    render(
      <Wrapper>
        <NoteComposer seriesId={SERIES_ID} chapterId={null} pageIndex={null} />
      </Wrapper>,
    );

    const submit = screen.getByRole("button", { name: /post note/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(upsert).not.toHaveBeenCalled();
  });
});
