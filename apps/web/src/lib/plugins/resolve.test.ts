/**
 * URL resolution without a database or a real plugin: `spawnPlugin` and the
 * registry are mocked, so what is under test is the bit that keeps a route any
 * member can POST from forking the box — the process-wide semaphore — plus the
 * cache key that stops `?i=1`, `?i=2`, … buying a process per request.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/plugins/process", () => ({ spawnPlugin: vi.fn() }));
vi.mock("@/lib/plugins/registry", () => ({ findPluginsForHost: vi.fn() }));

import { ApiError } from "@/lib/api";
import { resetEnvCache } from "@/lib/env";
import { spawnPlugin } from "@/lib/plugins/process";
import { findPluginsForHost, type LoadedPlugin } from "@/lib/plugins/registry";
import {
  clearResolveCache,
  resetResolveGate,
  resolveCacheKey,
  resolveGateState,
  resolveUrl,
  RESOLVE_QUEUE_LIMIT,
} from "./resolve";

const spawnMock = vi.mocked(spawnPlugin);
const findMock = vi.mocked(findPluginsForHost);

let dataRoot: string;

/** A plugin the registry can hand back; only these four fields are read. */
function fakePlugin(id: string): LoadedPlugin {
  return {
    row: { id, name: id },
    descriptor: { id, name: id, capabilities: ["network"] },
    dir: path.join(dataRoot, "plugins", id),
    entryPath: path.join(dataRoot, "plugins", id, "index.mjs"),
  } as unknown as LoadedPlugin;
}

/** A spawn result that declines the URL. */
function declined(): Awaited<ReturnType<typeof spawnPlugin>> {
  return { result: null, error: null } as unknown as Awaited<ReturnType<typeof spawnPlugin>>;
}

beforeAll(() => {
  dataRoot = mkdtempSync(path.join(tmpdir(), "kiri-resolve-"));
  process.env.DATA_ROOT = dataRoot;
  resetEnvCache();
});

afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true });
  delete process.env.DATA_ROOT;
  resetEnvCache();
});

beforeEach(() => {
  clearResolveCache();
  resetResolveGate();
  spawnMock.mockReset();
  findMock.mockReset();
});

afterEach(() => {
  resetResolveGate();
});

describe("resolveCacheKey", () => {
  it("drops the query string and fragment", () => {
    expect(resolveCacheKey("https://site.test/manga/x?i=1#frag")).toBe(
      "https://site.test/manga/x?i=1",
    );
    expect(resolveCacheKey("  https://site.test/manga/x?b=2&a=1  ")).toBe(
      "https://site.test/manga/x?a=1&b=2",
    );
  });

  it("leaves an unparseable string alone", () => {
    expect(resolveCacheKey("  not a url  ")).toBe("not a url");
  });
});

describe("resolveUrl caching", () => {
  it("asks a plugin once for URLs that differ only in query order or fragment", async () => {
    findMock.mockResolvedValue([fakePlugin("one")]);
    spawnMock.mockResolvedValue(declined());

    await resolveUrl("https://site.test/manga/x?a=1&b=2");
    await resolveUrl("https://site.test/manga/x?b=2&a=1");
    await resolveUrl("https://site.test/manga/x?a=1&b=2#top");

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("treats different query values as different series", async () => {
    findMock.mockResolvedValue([fakePlugin("one")]);
    spawnMock.mockResolvedValue(declined());

    await resolveUrl("https://site.test/read.php?id=1");
    await resolveUrl("https://site.test/read.php?id=2");

    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("passes the plugin the URL exactly as it was given", async () => {
    findMock.mockResolvedValue([fakePlugin("one")]);
    spawnMock.mockResolvedValue(declined());

    await resolveUrl("https://site.test/manga/x?chapter=7");

    expect(spawnMock.mock.calls[0]?.[0]).toMatchObject({
      args: ["https://site.test/manga/x?chapter=7"],
    });
  });
});

describe("resolve semaphore", () => {
  it("never runs more plugin processes than the limit, whatever is asked of it", async () => {
    const { limit } = resolveGateState();
    let inFlight = 0;
    let peak = 0;
    spawnMock.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return declined();
    });
    // Three candidates per call, four calls: twelve processes if unbounded.
    findMock.mockResolvedValue([fakePlugin("a"), fakePlugin("b"), fakePlugin("c")]);

    await Promise.all([1, 2, 3, 4].map((n) => resolveUrl(`https://site.test/${n}`)));

    expect(spawnMock).toHaveBeenCalledTimes(12);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(limit);
    expect(resolveGateState()).toMatchObject({ active: 0, waiting: 0 });
  });

  it("sheds load with a 503 once the queue is full", async () => {
    const { limit } = resolveGateState();
    let start = (): void => {};
    const held = new Promise<void>((resolve) => {
      start = resolve;
    });
    spawnMock.mockImplementation(async () => {
      await held;
      return declined();
    });
    findMock.mockResolvedValue([fakePlugin("only")]);

    // `limit` running plus RESOLVE_QUEUE_LIMIT waiting is the ceiling; one more
    // caller is refused rather than parked.
    const total = limit + RESOLVE_QUEUE_LIMIT + 1;
    const outcomes = Array.from({ length: total }, (_, index) =>
      resolveUrl(`https://site.test/q/${index}`).then(
        () => null,
        (error: unknown) => error,
      ),
    );
    // A macrotask drains the microtask queue: every caller has reached the gate.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolveGateState()).toMatchObject({ active: limit, waiting: RESOLVE_QUEUE_LIMIT });

    start();
    const errors = (await Promise.all(outcomes)).filter((entry): entry is ApiError =>
      Boolean(entry),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ApiError);
    expect(errors[0]?.status).toBe(503);
    expect(errors[0]?.message).toMatch(/try again shortly/i);
    expect(resolveGateState()).toMatchObject({ active: 0, waiting: 0 });
  });
});
