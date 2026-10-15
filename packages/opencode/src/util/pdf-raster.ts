// PDFs reach the model as page images, not as a PDF.
//
// Two reasons, and the second is the one that decides the defaults below:
//
//  1. The wire shape. Our live provider is @ai-sdk/openai-compatible, i.e. Chat
//     Completions, whose only media part is `image_url` -- there is no document
//     part to put a PDF in. Rasterising here means no protocol change at all,
//     and it keeps working if the provider is ever swapped.
//  2. The transport. The loopback relay chunks request bodies at 12 KB because
//     Russian ISP DPI resets larger uploads, and the body is the *entire*
//     conversation, re-sent on every step. So a page image is not paid for once
//     -- it is paid for on every subsequent turn of that conversation. That is
//     why the budget below is deliberately mean, and why JPEG rather than PNG.
//
// Rendering is mupdf's WASM build: no native module, so no per-Electron-ABI
// rebuild and no prebuild matrix across the platforms we ship to.

import type * as MuPDF from "mupdf"
import { readFile } from "node:fs/promises"
import wasmPath from "./vendor/mupdf-wasm.wasm" with { type: "file" }

// mupdf resolves its WASM at runtime with `new URL("mupdf-wasm.wasm", import.meta.url)` and reads
// it off disk. Inside the Bun single-file executable the sidecar ships as, that resolves to
// `B:/~BUN/root/mupdf-wasm.wasm`, which does not exist -- so the packaged app fails at the first
// PDF with ENOENT while dev, tests and typecheck all pass. Handing the bytes over up front avoids
// the lookup entirely; the wrapper reads this global before instantiating (see vendor/README.md).
// `fs.readFile` rather than `Bun.file`: this module runs in two different runtimes. The CLI is a
// Bun single-file executable, but the desktop app bundles the sidecar into the Electron main
// process (electron.vite.config.ts aliases ../opencode/dist/node), where `Bun` is undefined. Node's
// fs reads both a real path and a path inside the compiled binary's virtual root.
// The two runtimes also disagree on what `wasmPath` means. In the Bun single-file executable it is
// an absolute path inside the virtual root; in the Node bundle it is relative, and Node resolves a
// relative path against the process CWD -- which is wherever the user launched the app, not where
// the asset sits. Resolving against `import.meta.url` fixes the Node case; the raw value is kept as
// a fallback because a bunfs path is not a valid relative URL. Order matters: module-relative first.
async function wasmBinary() {
  const attempts: Array<URL | string> = [new URL(wasmPath, import.meta.url), wasmPath]
  const failures: string[] = []
  for (const attempt of attempts) {
    try {
      return await readFile(attempt as Parameters<typeof readFile>[0])
    } catch (cause) {
      failures.push(`${String(attempt)}: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  throw new PdfRasterError(`Could not load the PDF renderer's WASM. Tried ${failures.join(" | ")}`)
}

let mupdf: typeof MuPDF | undefined
async function load() {
  if (!mupdf) {
    const g = globalThis as Record<string, unknown>
    g["$libmupdf_wasm_Module"] ??= { wasmBinary: await wasmBinary() }
    mupdf = await import("mupdf")
  }
  return mupdf
}

/** 150 DPI keeps 8-10pt scanned Cyrillic legible; 100 starts to smear it. */
export const DEFAULT_DPI = 150
/** JPEG, because these are photographs of paper. PNG of a scan is ~4x larger for no gain. */
export const DEFAULT_QUALITY = 80
export const DEFAULT_MAX_PAGES = 20
/**
 * Total encoded budget for one document. The server caps a request at 8 MB
 * (LLM_MAX_REQUEST_BYTES) and that ceiling covers the whole conversation, not
 * one attachment, so a single document may not eat most of it.
 */
export const DEFAULT_MAX_TOTAL_BASE64_BYTES = 4 * 1024 * 1024

export interface RasterPage {
  readonly mime: string
  readonly base64: string
  /** 1-indexed, and the page's real number in the source document. */
  readonly page: number
}

export interface RasterResult {
  readonly pages: RasterPage[]
  /** Pages in the source document, whether or not we rendered them. */
  readonly total: number
  /** Set when we rendered fewer than `total`, saying why. Surface this to the model. */
  readonly truncated?: "page-limit" | "size-limit"
  readonly dpi: number
}

export interface RasterOptions {
  dpi?: number
  quality?: number
  maxPages?: number
  maxTotalBase64Bytes?: number
}

export class PdfRasterError extends Error {
  readonly _tag = "PdfRasterError"
}

/**
 * Renders a PDF's pages to JPEG. Never returns zero pages without throwing --
 * a caller that silently attaches nothing would leave the model answering about
 * a document it cannot see.
 */
export async function rasterizePdf(bytes: Uint8Array, options: RasterOptions = {}): Promise<RasterResult> {
  const dpi = options.dpi ?? DEFAULT_DPI
  const quality = options.quality ?? DEFAULT_QUALITY
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
  const maxTotal = options.maxTotalBase64Bytes ?? DEFAULT_MAX_TOTAL_BASE64_BYTES

  const mupdf = await load()

  let doc: MuPDF.Document
  try {
    doc = mupdf.Document.openDocument(bytes, "application/pdf")
  } catch (cause) {
    throw new PdfRasterError(`Could not open PDF: ${cause instanceof Error ? cause.message : String(cause)}`)
  }

  try {
    const total = doc.countPages()
    if (total === 0) throw new PdfRasterError("PDF contains no pages")

    const scale = mupdf.Matrix.scale(dpi / 72, dpi / 72)
    const pages: RasterPage[] = []
    let budget = maxTotal
    let truncated: RasterResult["truncated"]

    for (let index = 0; index < total; index++) {
      if (pages.length >= maxPages) {
        truncated = "page-limit"
        break
      }

      const page = doc.loadPage(index)
      let pixmap: MuPDF.Pixmap | undefined
      try {
        // alpha=false: a JPEG has no alpha channel, and asking for one costs a
        // composite pass and yields a black background on pages that use one.
        pixmap = page.toPixmap(scale, mupdf.ColorSpace.DeviceRGB, false, true)
        const base64 = Buffer.from(pixmap.asJPEG(quality, false)).toString("base64")

        // Always keep page 1, whatever it costs: a caller that gets an empty
        // result cannot tell "too big" from "failed", and one page is enough
        // for the model to say what the document is.
        if (base64.length > budget && pages.length > 0) {
          truncated = "size-limit"
          break
        }
        budget -= base64.length
        pages.push({ mime: "image/jpeg", base64, page: index + 1 })
      } finally {
        pixmap?.destroy()
        page.destroy()
      }
    }

    if (pages.length === 0) throw new PdfRasterError("PDF produced no renderable pages")
    return { pages, total, truncated, dpi }
  } finally {
    doc.destroy()
  }
}

/** One line for the model saying what it is looking at, and what it is not. */
export function describeRaster(result: RasterResult, filename?: string): string {
  const what = filename ? `${filename}: ` : ""
  const shown =
    result.pages.length === result.total
      ? `all ${result.total} page${result.total === 1 ? "" : "s"}`
      : `pages ${result.pages.map((p) => p.page).join(", ")} of ${result.total}`
  const why =
    result.truncated === "page-limit"
      ? ` The remaining pages were not rendered (page limit ${DEFAULT_MAX_PAGES}); read them by asking for a specific page range.`
      : result.truncated === "size-limit"
        ? " The remaining pages were not rendered because the document exceeded the attachment size budget."
        : ""
  return `${what}rendered ${shown} to images at ${result.dpi} DPI.${why}`
}
