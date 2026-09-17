/**
 * Render a PDF's pages to WebP images. Ported from V1
 * (`src/lib/pdf-import.ts`, `executePdfImport` + the render loop): pdfjs-dist
 * parses the document, `@napi-rs/canvas` rasterises each page (pdfjs has no
 * native Node canvas), and sharp re-encodes the raster to WebP.
 *
 * Kept dependency-free of the job runner and content store — callers own
 * duplicate checks, directory placement and DB writes.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import sharp from "sharp";
import { JobFailure } from "@/lib/jobs/types";
import { pageFileName } from "@/lib/media/naming";

/** Same ceiling V1 enforced via `getPdfMaxBytes()`'s hardcoded fallback. */
export const PDF_MAX_BYTES = 1024 * 1024 * 1024;
/** Same ceiling V1 enforced via `getPdfMaxPages()`'s `DEFAULT_MAX_PAGES`. */
export const PDF_MAX_PAGES = 2000;
/** V1 defaulted to 82; the V2 contract (`importChapterSchema`) calls for 85. */
export const PDF_WEBP_QUALITY = 85;

const DEFAULT_SCALE = 1.5;
const DEFAULT_MAX_WIDTH = 1600;

export interface RenderedPdfPage {
  /** 1-based page number. */
  index: number;
  /** Absolute path of the written `.webp` file inside `outDir`. */
  path: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

export interface RenderPdfToImagesInput {
  /** Absolute path to the source PDF. */
  pdfPath: string;
  /** Directory the rendered pages are written into (created if missing). */
  outDir: string;
  /** Render scale relative to 72 dpi; 1.5 ≈ 108 dpi. Matches `importChapterSchema.pdf.scale`. */
  scale?: number;
  /** Clamp the rendered width; scale is reduced (never increased) to fit. */
  maxWidth?: number;
  signal?: AbortSignal;
  onProgress?: (current: number, total: number) => void | Promise<void>;
  /**
   * Skip the internal hashing pass when the caller already hashed the file
   * (e.g. to check for a duplicate chapter before paying for the render).
   */
  sha256?: string;
}

export interface RenderPdfToImagesResult {
  pages: RenderedPdfPage[];
  /** sha256 of the source PDF file (not the rendered pages). */
  sha256: string;
}

/** Streaming sha256 of a file — cheap enough to run before deciding whether to render at all. */
export async function sha256File(filePath: string): Promise<string> {
  const stream = createReadStream(filePath);
  const hash = createHash("sha256");
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/** `pdf-<first 12 hex chars of the file's sha256>` — the slug convention ported from V1. */
export function chapterSlugForSha(sha256: string): string {
  return `pdf-${sha256.slice(0, 12)}`;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new JobFailure("CANCELLED", "PDF render was cancelled", { retryable: false });
  }
}

/**
 * Render every page of `pdfPath` to a `NNN.webp` file in `outDir` and return
 * per-page metadata plus the source file's sha256.
 *
 * Throws `JobFailure("PDF_TOO_LARGE", …)` for a file over 1 GB or a document
 * with more than 2000 pages, and `JobFailure("INVALID_PDF", …)` when the file
 * is missing, unreadable, or fails to parse.
 */
export async function renderPdfToImages(
  input: RenderPdfToImagesInput,
): Promise<RenderPdfToImagesResult> {
  const {
    pdfPath,
    outDir,
    scale = DEFAULT_SCALE,
    maxWidth = DEFAULT_MAX_WIDTH,
    signal,
    onProgress,
  } = input;

  const stats = await stat(pdfPath).catch(() => null);
  if (!stats || !stats.isFile()) {
    throw new JobFailure("INVALID_PDF", `PDF not found: ${pdfPath}`);
  }
  if (stats.size > PDF_MAX_BYTES) {
    throw new JobFailure(
      "PDF_TOO_LARGE",
      `PDF is ${stats.size} bytes; the maximum is ${PDF_MAX_BYTES} bytes`,
    );
  }

  const sha256 = input.sha256 ?? (await sha256File(pdfPath));

  await mkdir(outDir, { recursive: true });

  // pdfjs-dist@4 is ESM-only; dynamic import keeps this file loadable from
  // both CJS and ESM contexts. The legacy build works without a DOM/worker.
  const pdfjs =
    (await import("pdfjs-dist/legacy/build/pdf.mjs")) as typeof import("pdfjs-dist/legacy/build/pdf.mjs");

  const loadingTask = pdfjs.getDocument({
    url: pdfPath,
    verbosity: 0,
    disableStream: true,
    disableRange: true,
    // Avoids evaluating untrusted strings from the PDF for glyph-mapping
    // shortcuts; safe default for server-side rendering of arbitrary uploads.
    isEvalSupported: false,
    // Node has no system font directory pdfjs can enumerate reliably; forcing
    // this off avoids passing undefined paths to Skia (see V1 comment this
    // was ported from).
    useSystemFonts: false,
  });

  let pdf: Awaited<typeof loadingTask.promise>;
  try {
    pdf = await loadingTask.promise;
  } catch (error) {
    await loadingTask.destroy().catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    throw new JobFailure("INVALID_PDF", `Failed to parse PDF: ${message}`);
  }

  const pages: RenderedPdfPage[] = [];

  try {
    if (pdf.numPages < 1) {
      throw new JobFailure("INVALID_PDF", "PDF contains no pages");
    }
    if (pdf.numPages > PDF_MAX_PAGES) {
      throw new JobFailure(
        "PDF_TOO_LARGE",
        `PDF has ${pdf.numPages} pages; the maximum is ${PDF_MAX_PAGES}`,
      );
    }

    const totalPages = pdf.numPages;

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      assertNotAborted(signal);

      const page = await pdf.getPage(pageNum);
      try {
        const baseViewport = page.getViewport({ scale: 1 });
        if (baseViewport.width <= 0 || baseViewport.height <= 0) {
          throw new JobFailure("INVALID_PDF", `Page ${pageNum} has invalid dimensions`);
        }

        // maxWidth only ever clamps down; a small page at the requested
        // scale is rendered at that scale, never upscaled to fill maxWidth.
        const naturalWidth = baseViewport.width * scale;
        const effectiveScale =
          maxWidth > 0 && naturalWidth > maxWidth ? maxWidth / baseViewport.width : scale;

        const viewport = page.getViewport({ scale: effectiveScale });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext("2d");

        // Fill white so transparent PDF pages don't render as black/transparent WebP.
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);

        await page.render({
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport,
        }).promise;

        const pngBuffer = canvas.toBuffer("image/png");
        const webpBuffer = await sharp(pngBuffer)
          .webp({ quality: PDF_WEBP_QUALITY, effort: 4 })
          .toBuffer();

        const fileName = pageFileName(pageNum, totalPages, "webp");
        const filePath = path.join(outDir, fileName);
        await writeFile(filePath, webpBuffer);

        pages.push({
          index: pageNum,
          path: filePath,
          width: canvas.width,
          height: canvas.height,
          bytes: webpBuffer.length,
          sha256: createHash("sha256").update(webpBuffer).digest("hex"),
        });

        await onProgress?.(pageNum, totalPages);
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await pdf.cleanup().catch(() => {});
    await pdf.destroy().catch(() => {});
  }

  return { pages, sha256 };
}
