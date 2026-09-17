import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  downloadAll,
  downloadImage,
  imageDimensions,
  imageTypeFromContentType,
  sniffImageType,
  toManifestImage,
} from "../src/download.js";
import { PluginError } from "../src/errors.js";
import { HttpClient } from "../src/http.js";
import { makeTmpDir } from "../src/testing.js";
import {
  makeGif,
  makeJpeg,
  makePng,
  makeWebpExtended,
  makeWebpLossless,
} from "./helpers/images.js";

type Handler = (request: IncomingMessage, response: ServerResponse, hit: number) => void;

let server: Server;
let baseUrl: string;
let handler: Handler;
let hits: number;
let lastHeaders: IncomingMessage["headers"];
let dir: string;

const PNG = makePng(12, 7);

beforeAll(async () => {
  server = createServer((request, response) => {
    hits += 1;
    lastHeaders = request.headers;
    handler(request, response, hits);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  hits = 0;
  handler = (_request, response) => {
    response.writeHead(200, { "content-type": "image/png" });
    response.end(PNG);
  };
  dir = await makeTmpDir("kiri-download-");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const http = (): HttpClient =>
  new HttpClient({ jitterMs: 0, requestsPerSecond: 0, backoffMs: 10, retries: 1, timeoutMs: 2000 });

describe("sniffImageType", () => {
  it("identifies every format the SDK stores", () => {
    expect(sniffImageType(makePng(1, 1))).toEqual({ ext: ".png", mime: "image/png" });
    expect(sniffImageType(makeJpeg(1, 1))).toEqual({ ext: ".jpg", mime: "image/jpeg" });
    expect(sniffImageType(makeGif(1, 1))).toEqual({ ext: ".gif", mime: "image/gif" });
    expect(sniffImageType(makeWebpExtended(2, 2))).toEqual({ ext: ".webp", mime: "image/webp" });
    const avif = Buffer.alloc(16);
    avif.write("ftypavif", 4, "latin1");
    expect(sniffImageType(avif)).toEqual({ ext: ".avif", mime: "image/avif" });
  });

  it("returns null for HTML and other non-images", () => {
    expect(sniffImageType(Buffer.from("<html><body>404</body></html>"))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });

  it("maps content types as a fallback", () => {
    expect(imageTypeFromContentType("image/jpeg; charset=binary")).toEqual({
      ext: ".jpg",
      mime: "image/jpeg",
    });
    expect(imageTypeFromContentType("text/html")).toBeNull();
    expect(imageTypeFromContentType(undefined)).toBeNull();
  });
});

describe("imageDimensions", () => {
  it("parses PNG, JPEG, GIF and both WebP flavours", () => {
    expect(imageDimensions(makePng(120, 45))).toEqual({ width: 120, height: 45 });
    expect(imageDimensions(makeJpeg(800, 1200))).toEqual({ width: 800, height: 1200 });
    expect(imageDimensions(makeGif(64, 32))).toEqual({ width: 64, height: 32 });
    expect(imageDimensions(makeWebpExtended(1024, 1536))).toEqual({ width: 1024, height: 1536 });
    expect(imageDimensions(makeWebpLossless(300, 400))).toEqual({ width: 300, height: 400 });
  });

  it("returns null when it cannot tell", () => {
    expect(imageDimensions(Buffer.from("not an image"))).toBeNull();
    const truncated = makePng(10, 10).subarray(0, 12);
    expect(imageDimensions(truncated)).toBeNull();
  });
});

describe("downloadImage", () => {
  it("stores the bytes, the hash and the dimensions", async () => {
    const image = await downloadImage({
      http: http(),
      url: `${baseUrl}/page-1`,
      dir,
      index: 1,
      total: 3,
      referer: `${baseUrl}/chapter/1`,
    });

    expect(image).toMatchObject({
      index: 1,
      file: "001.png",
      bytes: PNG.length,
      sha256: createHash("sha256").update(PNG).digest("hex"),
      width: 12,
      height: 7,
      mime: "image/png",
      skipped: false,
    });
    expect(await readFile(path.join(dir, "001.png"))).toEqual(PNG);
    expect(lastHeaders["referer"]).toBe(`${baseUrl}/chapter/1`);
    // No temp files left behind.
    expect(await readdir(dir)).toEqual(["001.png"]);
  });

  it("trusts the magic bytes over the URL and the content type", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(makeJpeg(40, 60));
    };
    const image = await downloadImage({
      http: http(),
      url: `${baseUrl}/mislabelled.png?token=abc`,
      dir,
      index: 2,
      total: 10,
    });
    expect(image.file).toBe("002.jpg");
    expect(image.mime).toBe("image/jpeg");
    expect(image).toMatchObject({ width: 40, height: 60 });
  });

  it("pads the index to the chapter's page count", async () => {
    const image = await downloadImage({
      http: http(),
      url: `${baseUrl}/p`,
      dir,
      index: 7,
      total: 1200,
    });
    expect(image.file).toBe("0007.png");
  });

  it("refuses a non-image response", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>sorry</html>");
    };
    await expect(
      downloadImage({ http: http(), url: `${baseUrl}/page`, dir, index: 1, total: 1 }),
    ).rejects.toMatchObject({ code: "PARSE" });
    expect(await readdir(dir)).toEqual([]);
  });

  it("skips a page that is already on disk", async () => {
    const first = await downloadImage({
      http: http(),
      url: `${baseUrl}/p`,
      dir,
      index: 1,
      total: 3,
    });
    hits = 0;
    const second = await downloadImage({
      http: http(),
      url: `${baseUrl}/p`,
      dir,
      index: 1,
      total: 3,
      existing: toManifestImage(first),
    });
    expect(second.skipped).toBe(true);
    expect(second.sha256).toBe(first.sha256);
    expect(second.width).toBe(12);
    expect(hits).toBe(0);
  });

  it("fills in metadata a previous manifest was missing", async () => {
    await downloadImage({ http: http(), url: `${baseUrl}/p`, dir, index: 1, total: 3 });
    hits = 0;
    const image = await downloadImage({
      http: http(),
      url: `${baseUrl}/p`,
      dir,
      index: 1,
      total: 3,
      existing: { index: 1, file: "001.png" },
    });
    expect(hits).toBe(0);
    expect(image.sha256).toHaveLength(64);
    expect(image).toMatchObject({ width: 12, height: 7, mime: "image/png", skipped: true });
  });

  it("re-downloads an empty file and honours force", async () => {
    await writeFile(path.join(dir, "001.png"), "");
    const image = await downloadImage({
      http: http(),
      url: `${baseUrl}/p`,
      dir,
      index: 1,
      total: 3,
      existing: { index: 1, file: "001.png" },
    });
    expect(image.skipped).toBe(false);
    expect(hits).toBe(1);

    hits = 0;
    const forced = await downloadImage({
      http: http(),
      url: `${baseUrl}/p`,
      dir,
      index: 1,
      total: 3,
      existing: toManifestImage(image),
      force: true,
    });
    expect(forced.skipped).toBe(false);
    expect(hits).toBe(1);
  });

  it("removes a stale file when the format changes", async () => {
    await downloadImage({ http: http(), url: `${baseUrl}/p`, dir, index: 1, total: 3 });
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "image/jpeg" });
      response.end(makeJpeg(10, 10));
    };
    const image = await downloadImage({
      http: http(),
      url: `${baseUrl}/p`,
      dir,
      index: 1,
      total: 3,
      existing: { index: 1, file: "001.png" },
      force: true,
    });
    expect(image.file).toBe("001.jpg");
    expect(await readdir(dir)).toEqual(["001.jpg"]);
  });

  it("writes pre-fetched bytes without touching the network", async () => {
    const body = makeGif(20, 10);
    const image = await downloadImage({
      http: http(),
      url: "https://example.invalid/page.gif",
      dir,
      index: 3,
      total: 3,
      body,
    });
    expect(hits).toBe(0);
    expect(image).toMatchObject({ file: "003.gif", width: 20, height: 10, bytes: body.length });
  });
});

describe("downloadAll", () => {
  const pages = (count: number) =>
    Array.from({ length: count }, (_value, index) => ({
      index: index + 1,
      url: `${baseUrl}/page-${index + 1}.png`,
    }));

  it("downloads every page and reports progress", async () => {
    const progress: number[] = [];
    const result = await downloadAll(pages(5), {
      http: http(),
      dir: path.join(dir, "chapter-1"),
      concurrency: 2,
      onProgress: ({ completed }) => progress.push(completed),
    });

    expect(result.images.map((image) => image.file)).toEqual([
      "001.png",
      "002.png",
      "003.png",
      "004.png",
      "005.png",
    ]);
    expect(result.downloaded).toBe(5);
    expect(result.skipped).toBe(0);
    expect(result.bytes).toBe(PNG.length * 5);
    expect(progress).toHaveLength(5);
    expect(progress.at(-1)).toBe(5);
  });

  it("re-uses existing files on a second run", async () => {
    const chapterDir = path.join(dir, "chapter-2");
    const first = await downloadAll(pages(3), { http: http(), dir: chapterDir });
    hits = 0;
    const second = await downloadAll(pages(3), {
      http: http(),
      dir: chapterDir,
      existing: first.images.map(toManifestImage),
    });
    expect(second.skipped).toBe(3);
    expect(second.downloaded).toBe(0);
    expect(hits).toBe(0);
  });

  it("fails the whole chapter when one page fails", async () => {
    handler = (request, response) => {
      if (request.url?.includes("page-2")) {
        response.writeHead(500);
        response.end("nope");
        return;
      }
      response.writeHead(200, { "content-type": "image/png" });
      response.end(PNG);
    };
    const error = await downloadAll(pages(4), {
      http: http(),
      dir: path.join(dir, "chapter-3"),
      concurrency: 1,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PluginError);
    expect((error as PluginError).code).toBe("NETWORK");
    // Fail-fast: page 3 and 4 were never requested.
    const requested = await readdir(path.join(dir, "chapter-3"));
    expect(requested).toEqual(["001.png"]);
  });

  it("stops promptly when the caller aborts", async () => {
    const controller = new AbortController();
    handler = (_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "image/png" });
        response.end(PNG);
      }, 200);
    };
    const pending = downloadAll(pages(4), {
      http: http(),
      dir: path.join(dir, "chapter-4"),
      concurrency: 1,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("uses a plugin-supplied downloader when given one", async () => {
    const result = await downloadAll(pages(2), {
      http: http(),
      dir: path.join(dir, "chapter-5"),
      download: (page) => makePng(page.index + 1, page.index + 2),
    });
    expect(hits).toBe(0);
    expect(result.images[0]).toMatchObject({ width: 2, height: 3 });
    expect(result.images[1]).toMatchObject({ width: 3, height: 4 });
  });

  it("creates the chapter directory", async () => {
    const nested = path.join(dir, "deep", "chapter-6");
    await mkdir(dir, { recursive: true });
    const result = await downloadAll(pages(1), { http: http(), dir: nested });
    expect(result.images).toHaveLength(1);
  });
});

describe("toManifestImage", () => {
  it("drops SDK-only fields", () => {
    expect(
      toManifestImage({
        index: 1,
        url: "u",
        file: "001.png",
        bytes: 10,
        sha256: "abc",
        width: 2,
        height: 3,
        mime: "image/png",
        skipped: true,
      }),
    ).toEqual({
      index: 1,
      url: "u",
      file: "001.png",
      bytes: 10,
      sha256: "abc",
      width: 2,
      height: 3,
      mime: "image/png",
    });
  });
});
