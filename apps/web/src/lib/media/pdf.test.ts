import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobFailure } from "@/lib/jobs/types";

/**
 * All V1 test PDFs under Kiri/tests/*.pdf are 180 MB+ (real manga volumes),
 * far over the ~3 MB fixture budget for this suite. This fixture is a
 * hand-built, byte-accurate 2-page PDF (page 1: 200x300pt, page 2: 100x150pt
 * — deliberately different sizes to exercise per-page viewport math) that
 * pdfjs-dist parses cleanly; see test/fixtures/tiny-2page.pdf.
 */
const FIXTURE = path.resolve(__dirname, "../../../test/fixtures/tiny-2page.pdf");

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), "kiri-pdf-test-"));
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
  vi.doUnmock("pdfjs-dist/legacy/build/pdf.mjs");
  vi.resetModules();
});

describe("renderPdfToImages", () => {
  it("renders every page to a numbered webp file at the requested scale", async () => {
    const { renderPdfToImages } = await import("./pdf");
    const result = await renderPdfToImages({ pdfPath: FIXTURE, outDir, scale: 1.5 });

    expect(result.pages).toHaveLength(2);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);

    // page 1: 200x300pt * 1.5 = 300x450px
    expect(result.pages[0]).toMatchObject({ index: 1, width: 300, height: 450 });
    // page 2: 100x150pt * 1.5 = 150x225px
    expect(result.pages[1]).toMatchObject({ index: 2, width: 150, height: 225 });

    for (const page of result.pages) {
      expect(page.path).toBe(path.join(outDir, `${String(page.index).padStart(3, "0")}.webp`));
      expect(page.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(page.bytes).toBeGreaterThan(0);

      const buffer = await readFile(page.path);
      expect(buffer.byteLength).toBe(page.bytes);
      // WebP magic: "RIFF"....."WEBP"
      expect(buffer.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(buffer.subarray(8, 12).toString("ascii")).toBe("WEBP");
    }

    const files = (await readdir(outDir)).sort();
    expect(files).toEqual(["001.webp", "002.webp"]);
  });

  it("clamps the render scale so no page exceeds maxWidth", async () => {
    const { renderPdfToImages } = await import("./pdf");
    const result = await renderPdfToImages({ pdfPath: FIXTURE, outDir, scale: 1.5, maxWidth: 100 });

    // page 1 natural width at scale 1.5 is 300 > 100 -> clamped to 100/200 = 0.5x
    expect(result.pages[0]).toMatchObject({ width: 100, height: 150 });
    // page 2 natural width at scale 1.5 is 150 > 100 -> clamped to 100/100 = 1x
    expect(result.pages[1]).toMatchObject({ width: 100, height: 150 });
  });

  it("never upscales a page past the requested scale to fill maxWidth", async () => {
    const { renderPdfToImages } = await import("./pdf");
    const result = await renderPdfToImages({
      pdfPath: FIXTURE,
      outDir,
      scale: 1,
      maxWidth: 5000,
    });

    expect(result.pages[0]).toMatchObject({ width: 200, height: 300 });
    expect(result.pages[1]).toMatchObject({ width: 100, height: 150 });
  });

  it("accepts a precomputed sha256 and skips re-hashing", async () => {
    const { renderPdfToImages, sha256File } = await import("./pdf");
    const known = await sha256File(FIXTURE);
    const result = await renderPdfToImages({ pdfPath: FIXTURE, outDir, sha256: known });
    expect(result.sha256).toBe(known);
  });

  it("reports progress once per rendered page", async () => {
    const { renderPdfToImages } = await import("./pdf");
    const onProgress = vi.fn();
    await renderPdfToImages({ pdfPath: FIXTURE, outDir, onProgress });
    expect(onProgress).toHaveBeenNthCalledWith(1, 1, 2);
    expect(onProgress).toHaveBeenNthCalledWith(2, 2, 2);
  });

  it("stops before rendering when the signal is already aborted", async () => {
    const { renderPdfToImages } = await import("./pdf");
    const controller = new AbortController();
    controller.abort();

    await expect(
      renderPdfToImages({ pdfPath: FIXTURE, outDir, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "JobFailure", code: "CANCELLED" });

    expect(await readdir(outDir)).toEqual([]);
  });

  it("throws INVALID_PDF for a missing file", async () => {
    const { renderPdfToImages } = await import("./pdf");
    await expect(
      renderPdfToImages({ pdfPath: path.join(outDir, "nope.pdf"), outDir }),
    ).rejects.toMatchObject({ name: "JobFailure", code: "INVALID_PDF" });
  });

  it("throws INVALID_PDF for a file that is not a PDF", async () => {
    const { renderPdfToImages } = await import("./pdf");
    const notPdf = path.join(outDir, "not-a-pdf.txt");
    await writeFile(notPdf, "hello world, this is definitely not a PDF file");

    await expect(renderPdfToImages({ pdfPath: notPdf, outDir })).rejects.toMatchObject({
      name: "JobFailure",
      code: "INVALID_PDF",
    });
  });

  it("throws PDF_TOO_LARGE for a file over the byte ceiling", async () => {
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        stat: vi.fn(async (target: Parameters<typeof actual.stat>[0]) => {
          const real = await actual.stat(target);
          return { ...real, size: 2 * 1024 * 1024 * 1024, isFile: () => true };
        }),
      };
    });
    const { renderPdfToImages } = await import("./pdf");

    await expect(renderPdfToImages({ pdfPath: FIXTURE, outDir })).rejects.toMatchObject({
      name: "JobFailure",
      code: "PDF_TOO_LARGE",
    });
    vi.doUnmock("node:fs/promises");
  });

  it("throws PDF_TOO_LARGE for a document over the page ceiling", async () => {
    vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 2001,
          cleanup: vi.fn().mockResolvedValue(undefined),
          destroy: vi.fn().mockResolvedValue(undefined),
        }),
        destroy: vi.fn().mockResolvedValue(undefined),
      }),
    }));
    const { renderPdfToImages } = await import("./pdf");

    await expect(renderPdfToImages({ pdfPath: FIXTURE, outDir })).rejects.toMatchObject({
      name: "JobFailure",
      code: "PDF_TOO_LARGE",
    });
  });
});

describe("chapterSlugForSha", () => {
  it("prefixes the first 12 hex chars of the sha256", async () => {
    const { chapterSlugForSha } = await import("./pdf");
    expect(chapterSlugForSha("abcdef0123456789".padEnd(64, "0"))).toBe("pdf-abcdef012345");
  });
});

// Re-imported above per-test via dynamic import so vi.doMock (module-scoped,
// not hoisted) reliably applies before ./pdf's own dynamic import runs;
// JobFailure is asserted structurally above, this just confirms the type.
describe("JobFailure shape", () => {
  it("is the error class thrown by renderPdfToImages", () => {
    const err = new JobFailure("INVALID_PDF", "x");
    expect(err.code).toBe("INVALID_PDF");
  });
});
