import path from "node:path";
import { readFile, rm, stat } from "node:fs/promises";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  COVER_FILE,
  CoverError,
  coverUrlFor,
  deleteCover,
  getCoverPath,
  storeCoverFromBuffer,
  storeCoverFromUrl,
  tryStoreCoverFromUrl,
} from "./cover-storage";
import { coversDir } from "@/lib/content/store";
import { resetEnvCache } from "@/lib/env";

const DATA_ROOT = path.resolve(process.cwd(), "data", `test-covers-${process.pid}`);

/** A real 40x60 PNG, so sharp has something genuine to convert. */
async function samplePng(width = 40, height = 60): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 30, b: 90 } },
  })
    .png()
    .toBuffer();
}

beforeAll(() => {
  process.env.DATA_ROOT = DATA_ROOT;
  // These fixtures point at `example.test`, which does not resolve: the SSRF
  // guard in src/lib/net/safe-fetch would refuse them. test/setup.ts sets this
  // for the whole suite; it is repeated here so the dependency is visible.
  process.env["KIRI_ALLOW_PRIVATE_FETCH"] = "1";
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await rm(DATA_ROOT, { recursive: true, force: true });
  delete process.env.DATA_ROOT;
  resetEnvCache();
});

describe("coverUrlFor", () => {
  it("is null when the series has no stored cover", () => {
    expect(coverUrlFor({ id: "s1", coverFile: null, updatedAt: new Date() })).toBeNull();
  });

  it("cache-busts on the series updatedAt", () => {
    const updatedAt = new Date("2024-03-04T05:06:07.008Z");
    expect(coverUrlFor({ id: "s1", coverFile: COVER_FILE, updatedAt })).toBe(
      `/api/series/s1/cover?v=${updatedAt.getTime()}`,
    );
  });

  it("accepts an ISO string or epoch millis (serialised rows)", () => {
    expect(
      coverUrlFor({ id: "s1", coverFile: COVER_FILE, updatedAt: "2024-01-01T00:00:00.000Z" }),
    ).toBe("/api/series/s1/cover?v=1704067200000");
    expect(coverUrlFor({ id: "s1", coverFile: COVER_FILE, updatedAt: 42 })).toBe(
      "/api/series/s1/cover?v=42",
    );
  });
});

describe("storeCoverFromBuffer", () => {
  it("writes a WebP cover into the series directory", async () => {
    const stored = await storeCoverFromBuffer("buffer-series", await samplePng());
    expect(stored).toEqual({ file: COVER_FILE });

    const filePath = getCoverPath("buffer-series", stored.file);
    expect(filePath).toBe(path.join(coversDir("buffer-series"), COVER_FILE));
    const meta = await sharp(await readFile(filePath)).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(40);
  });

  it("clamps the width to 800 but never enlarges", async () => {
    const stored = await storeCoverFromBuffer("wide-series", await samplePng(1600, 900));
    const meta = await sharp(await readFile(getCoverPath("wide-series", stored.file))).metadata();
    expect(meta.width).toBe(800);
  });

  it("leaves no temp files behind", async () => {
    await storeCoverFromBuffer("clean-series", await samplePng());
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(coversDir("clean-series"))).toEqual([COVER_FILE]);
  });

  it("rejects an empty or undecodable buffer", async () => {
    await expect(storeCoverFromBuffer("bad-series", Buffer.alloc(0))).rejects.toBeInstanceOf(
      CoverError,
    );
    await expect(
      storeCoverFromBuffer("bad-series", Buffer.from("not an image at all")),
    ).rejects.toBeInstanceOf(CoverError);
  });
});

describe("storeCoverFromUrl", () => {
  it("downloads, converts and stores", async () => {
    const png = await samplePng();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () => new Response(new Uint8Array(png), { headers: { "content-type": "image/png" } }),
      ),
    );

    const stored = await storeCoverFromUrl("remote-series", "https://example.test/cover.png");
    expect(stored).toEqual({ file: COVER_FILE });
    await expect(stat(getCoverPath("remote-series", COVER_FILE))).resolves.toBeDefined();
  });

  it("refuses a non-http URL without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(storeCoverFromUrl("s", "file:///etc/passwd")).rejects.toBeInstanceOf(CoverError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a non-image content type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () => new Response("<html>", { headers: { "content-type": "text/html" } }),
      ),
    );
    await expect(storeCoverFromUrl("s", "https://example.test/x")).rejects.toThrow(/not an image/);
  });

  it("refuses a response larger than 10 MB", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response("x", {
            headers: { "content-type": "image/png", "content-length": String(11 * 1024 * 1024) },
          }),
      ),
    );
    await expect(storeCoverFromUrl("s", "https://example.test/x")).rejects.toThrow(/10 MB/);
  });

  it("reports a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("", { status: 404 })),
    );
    await expect(storeCoverFromUrl("s", "https://example.test/x")).rejects.toThrow(/404/);
  });

  it("refuses a cover URL that points at the host's own network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env["KIRI_ALLOW_PRIVATE_FETCH"];
    try {
      await expect(
        storeCoverFromUrl("s", "http://169.254.169.254/latest/meta-data/"),
      ).rejects.toBeInstanceOf(CoverError);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      process.env["KIRI_ALLOW_PRIVATE_FETCH"] = "1";
    }
  });
});

describe("tryStoreCoverFromUrl", () => {
  it("swallows failures so a series write never fails on a cover", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new Error("network down");
      }),
    );
    await expect(tryStoreCoverFromUrl("s", "https://example.test/x")).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe("deleteCover", () => {
  it("removes the whole series directory", async () => {
    await storeCoverFromBuffer("doomed-series", await samplePng());
    await deleteCover("doomed-series");
    await expect(stat(coversDir("doomed-series"))).rejects.toThrow();
  });

  it("is a no-op when nothing was stored", async () => {
    await expect(deleteCover("never-had-one")).resolves.toBeUndefined();
  });
});
