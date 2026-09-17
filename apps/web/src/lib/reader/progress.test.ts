import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProgressSaver,
  httpProgressTransport,
  markChapterRead,
  PROGRESS_DEBOUNCE_MS,
  resetProgressTransport,
  setProgressTransport,
  subscribeProgressErrors,
  type ProgressTransport,
} from "./progress";

function mockTransport() {
  const savePosition = vi.fn<ProgressTransport["savePosition"]>().mockResolvedValue(undefined);
  const setChapterRead = vi.fn<ProgressTransport["setChapterRead"]>().mockResolvedValue(undefined);
  return { savePosition, setChapterRead } satisfies ProgressTransport;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetProgressTransport();
});

describe("createProgressSaver", () => {
  it("waits out the debounce window before writing", async () => {
    const transport = mockTransport();
    const saver = createProgressSaver({ transport });

    saver.save({ seriesId: "s1", chapterId: "c1", pageIndex: 3 });
    await vi.advanceTimersByTimeAsync(PROGRESS_DEBOUNCE_MS - 1);
    expect(transport.savePosition).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(transport.savePosition).toHaveBeenCalledTimes(1);
    expect(transport.savePosition).toHaveBeenCalledWith(
      { seriesId: "s1", chapterId: "c1", pageIndex: 3 },
      {},
    );
  });

  it("coalesces a burst of page turns into the last position", async () => {
    const transport = mockTransport();
    const saver = createProgressSaver({ transport });

    for (const pageIndex of [1, 2, 3, 4]) {
      saver.save({ seriesId: "s1", chapterId: "c1", pageIndex });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(transport.savePosition).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(PROGRESS_DEBOUNCE_MS);
    expect(transport.savePosition).toHaveBeenCalledTimes(1);
    expect(transport.savePosition.mock.calls[0]?.[0]).toMatchObject({ pageIndex: 4 });
  });

  it("debounces each series separately", async () => {
    const transport = mockTransport();
    const saver = createProgressSaver({ transport });

    saver.save({ seriesId: "s1", chapterId: "c1", pageIndex: 1 });
    saver.save({ seriesId: "s2", chapterId: "c9", pageIndex: 7 });
    expect(saver.pendingCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(PROGRESS_DEBOUNCE_MS);
    expect(transport.savePosition).toHaveBeenCalledTimes(2);
    expect(saver.pendingCount()).toBe(0);
  });

  it("flushes pending writes immediately, with keepalive for unloads", async () => {
    const transport = mockTransport();
    const saver = createProgressSaver({ transport });

    saver.save({ seriesId: "s1", chapterId: "c1", pageIndex: 5 });
    saver.flush({ keepalive: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(transport.savePosition).toHaveBeenCalledTimes(1);
    expect(transport.savePosition).toHaveBeenCalledWith(expect.anything(), { keepalive: true });

    // The debounce timer must not fire a second write afterwards.
    await vi.advanceTimersByTimeAsync(PROGRESS_DEBOUNCE_MS * 2);
    expect(transport.savePosition).toHaveBeenCalledTimes(1);
  });

  it("does nothing on a flush with nothing pending", async () => {
    const transport = mockTransport();
    const saver = createProgressSaver({ transport });
    saver.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.savePosition).not.toHaveBeenCalled();
  });

  it("drops pending writes on cancel", async () => {
    const transport = mockTransport();
    const saver = createProgressSaver({ transport });
    saver.save({ seriesId: "s1", chapterId: "c1", pageIndex: 2 });
    saver.cancel();
    await vi.advanceTimersByTimeAsync(PROGRESS_DEBOUNCE_MS * 2);
    expect(transport.savePosition).not.toHaveBeenCalled();
  });

  it("swallows a failed write and reports it instead of throwing", async () => {
    const onError = vi.fn();
    const transport = mockTransport();
    transport.savePosition.mockRejectedValue(new Error("offline"));
    const saver = createProgressSaver({ transport, onError });

    saver.save({ seriesId: "s1", chapterId: "c1", pageIndex: 1 });
    await vi.advanceTimersByTimeAsync(PROGRESS_DEBOUNCE_MS);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toMatchObject({ seriesId: "s1" });
  });

  it("notifies module subscribers when no local handler is given", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeProgressErrors(listener);
    const transport = mockTransport();
    transport.savePosition.mockRejectedValue(new Error("offline"));
    const saver = createProgressSaver({ transport });

    saver.save({ seriesId: "s1", chapterId: null, pageIndex: 0 });
    await vi.advanceTimersByTimeAsync(PROGRESS_DEBOUNCE_MS);

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("uses the swapped-in transport (the Phase 5 hand-off)", async () => {
    const transport = mockTransport();
    setProgressTransport(transport);
    const saver = createProgressSaver();

    saver.save({ seriesId: "s1", chapterId: "c1", pageIndex: 1 });
    await vi.advanceTimersByTimeAsync(PROGRESS_DEBOUNCE_MS);
    expect(transport.savePosition).toHaveBeenCalledTimes(1);
  });
});

describe("httpProgressTransport", () => {
  it("PUTs the position to the series endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await httpProgressTransport.savePosition(
      { seriesId: "s1", chapterId: "c1", pageIndex: 4 },
      { keepalive: true },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/series/s1/position");
    expect(init.method).toBe("PUT");
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(String(init.body))).toEqual({ chapterId: "c1", pageIndex: 4 });
  });

  it("rejects on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    await expect(
      httpProgressTransport.savePosition({ seriesId: "s1", chapterId: null, pageIndex: 0 }, {}),
    ).rejects.toThrow(/500/);
  });

  it("PUTs the read flag to the chapter endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await httpProgressTransport.setChapterRead("c1", true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/chapters/c1/read");
    expect(JSON.parse(String(init.body))).toEqual({ read: true });
  });
});

describe("markChapterRead", () => {
  it("resolves false instead of throwing when the write fails", async () => {
    setProgressTransport({
      savePosition: vi.fn().mockResolvedValue(undefined),
      setChapterRead: vi.fn().mockRejectedValue(new Error("offline")),
    });
    await expect(markChapterRead("c1")).resolves.toBe(false);
  });

  it("resolves true on success", async () => {
    setProgressTransport(mockTransport());
    await expect(markChapterRead("c1")).resolves.toBe(true);
  });
});
