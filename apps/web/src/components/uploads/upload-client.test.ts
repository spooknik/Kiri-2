import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api-client";
import type { UploadSessionView } from "@/lib/contracts/content";
import {
  clearUploadSessionCache,
  pendingChunkIndexes,
  planChunks,
  uploadFile,
  type UploadDeps,
} from "./upload-client";

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(), post: vi.fn() },
  };
});

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);

function makeFile(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type: "image/png" });
}

function makeSession(overrides: Partial<UploadSessionView> = {}): UploadSessionView {
  return {
    id: "upload-1",
    filename: "file.png",
    size: 10,
    mime: "image/png",
    chunkSize: 4,
    chunkCount: 3,
    receivedChunks: [],
    complete: false,
    expiresAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const noWait: UploadDeps["wait"] = () => Promise.resolve();

afterEach(() => {
  clearUploadSessionCache();
  vi.clearAllMocks();
});

describe("planChunks", () => {
  it("splits evenly-divisible sizes with no remainder", () => {
    expect(planChunks(8, 4)).toEqual([
      { index: 0, start: 0, end: 4 },
      { index: 1, start: 4, end: 8 },
    ]);
  });

  it("gives the last chunk a shorter end when size doesn't divide evenly", () => {
    expect(planChunks(10, 4)).toEqual([
      { index: 0, start: 0, end: 4 },
      { index: 1, start: 4, end: 8 },
      { index: 2, start: 8, end: 10 },
    ]);
  });

  it("returns a single chunk when size is smaller than chunkSize", () => {
    expect(planChunks(3, 4)).toEqual([{ index: 0, start: 0, end: 3 }]);
  });

  it("returns no chunks for a zero-byte file", () => {
    expect(planChunks(0, 4)).toEqual([]);
  });
});

describe("pendingChunkIndexes", () => {
  it("skips indexes already in receivedChunks", () => {
    expect(pendingChunkIndexes(5, [0, 2, 4])).toEqual([1, 3]);
  });

  it("returns every index when nothing has been received", () => {
    expect(pendingChunkIndexes(3, [])).toEqual([0, 1, 2]);
  });

  it("returns nothing when everything has been received", () => {
    expect(pendingChunkIndexes(3, [0, 1, 2])).toEqual([]);
  });
});

describe("uploadFile", () => {
  it("creates a session, PUTs every chunk, then completes, reporting final progress", async () => {
    const file = makeFile("page.png", 10);
    const created = makeSession();
    const completed = makeSession({ complete: true });
    apiPost.mockImplementation((path: string) => {
      if (path === "/api/uploads") return Promise.resolve(created);
      if (path === "/api/uploads/upload-1/complete") return Promise.resolve(completed);
      throw new Error(`unexpected POST ${path}`);
    });

    const putUrls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      putUrls.push(String(input));
      return new Response(null, { status: 200 });
    };

    const progressUpdates: number[] = [];
    const result = await uploadFile(
      file,
      { onProgress: ({ sentBytes }) => progressUpdates.push(sentBytes) },
      { fetchImpl, wait: noWait },
    );

    expect(result).toBe(completed);
    expect(putUrls.sort()).toEqual([
      "/api/uploads/upload-1/chunks/0",
      "/api/uploads/upload-1/chunks/1",
      "/api/uploads/upload-1/chunks/2",
    ]);
    // Initial 0-received report, then one report per landed chunk, ending at the full size.
    expect(progressUpdates[0]).toBe(0);
    expect(progressUpdates.at(-1)).toBe(10);
  });

  it("resumes by skipping chunks already in receivedChunks", async () => {
    const file = makeFile("page.png", 10);
    const created = makeSession({ receivedChunks: [0, 2] });
    const completed = makeSession({ complete: true });
    apiPost.mockImplementation((path: string) => {
      if (path === "/api/uploads") return Promise.resolve(created);
      if (path === "/api/uploads/upload-1/complete") return Promise.resolve(completed);
      throw new Error(`unexpected POST ${path}`);
    });

    const putUrls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      putUrls.push(String(input));
      return new Response(null, { status: 200 });
    };

    await uploadFile(file, {}, { fetchImpl, wait: noWait });

    expect(putUrls).toEqual(["/api/uploads/upload-1/chunks/1"]);
  });

  it("reuses a cached session (via GET) instead of re-uploading when called again for the same file", async () => {
    const file = makeFile("page.png", 10);
    const created = makeSession();
    apiPost.mockImplementation((path: string) => {
      if (path === "/api/uploads") return Promise.resolve(created);
      throw new Error(`unexpected POST ${path}`);
    });

    // First attempt: chunk 1 fails permanently (every attempt), leaving the
    // session cached with whichever of chunk 0/2 landed first.
    const failingFetch: typeof fetch = async (input) => {
      if (String(input).endsWith("/chunks/1")) {
        return new Response(null, { status: 500 });
      }
      return new Response(null, { status: 200 });
    };

    await expect(
      uploadFile(file, {}, { fetchImpl: failingFetch, wait: noWait }),
    ).rejects.toBeTruthy();
    expect(apiPost).toHaveBeenCalledTimes(1); // only the initial create — no complete call on failure

    // Second attempt: GET refreshes the session (server says chunk 1 landed anyway), only chunk 2 is sent.
    apiGet.mockResolvedValueOnce(makeSession({ receivedChunks: [0, 1] }));
    const completed = makeSession({ complete: true });
    apiPost.mockImplementation((path: string) => {
      if (path === "/api/uploads/upload-1/complete") return Promise.resolve(completed);
      throw new Error(`unexpected POST ${path}`);
    });

    const putUrls: string[] = [];
    const secondFetch: typeof fetch = async (input) => {
      putUrls.push(String(input));
      return new Response(null, { status: 200 });
    };
    const result = await uploadFile(file, {}, { fetchImpl: secondFetch, wait: noWait });

    expect(apiGet).toHaveBeenCalledWith("/api/uploads/upload-1", expect.anything());
    expect(putUrls).toEqual(["/api/uploads/upload-1/chunks/2"]);
    expect(result).toBe(completed);
  });

  it("retries a failing chunk up to UPLOAD_MAX_RETRIES times before succeeding", async () => {
    const file = makeFile("page.png", 10);
    const created = makeSession();
    const completed = makeSession({ complete: true });
    apiPost.mockImplementation((path: string) => {
      if (path === "/api/uploads") return Promise.resolve(created);
      if (path === "/api/uploads/upload-1/complete") return Promise.resolve(completed);
      throw new Error(`unexpected POST ${path}`);
    });

    let attemptsForChunk1 = 0;
    const flakyFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/chunks/1")) {
        attemptsForChunk1 += 1;
        if (attemptsForChunk1 < 3) {
          return new Response(null, { status: 503 });
        }
      }
      return new Response(null, { status: 200 });
    };

    const result = await uploadFile(file, {}, { fetchImpl: flakyFetch, wait: noWait });

    expect(attemptsForChunk1).toBe(3);
    expect(result).toBe(completed);
  });

  it("fails after exhausting retries on a permanently-failing chunk", async () => {
    const file = makeFile("page.png", 10);
    const created = makeSession();
    apiPost.mockImplementation((path: string) => {
      if (path === "/api/uploads") return Promise.resolve(created);
      throw new Error(`unexpected POST ${path}`);
    });

    const alwaysFails: typeof fetch = async () => new Response(null, { status: 500 });

    await expect(
      uploadFile(file, {}, { fetchImpl: alwaysFails, wait: noWait }),
    ).rejects.toBeTruthy();
    // No completion call — the upload never finished.
    expect(apiPost).toHaveBeenCalledTimes(1);
  });
});
