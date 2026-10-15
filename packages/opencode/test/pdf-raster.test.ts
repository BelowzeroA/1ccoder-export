import { describe, expect, test } from "bun:test"
import { describeRaster, PdfRasterError, rasterizePdf } from "../src/util/pdf-raster"

/**
 * Builds a valid multi-page PDF by hand so the test carries no binary fixture
 * and the page count is a parameter rather than a property of a checked-in file.
 */
function makePdf(pages: number) {
  const objects: Buffer[] = []
  const pageIds = Array.from({ length: pages }, (_, i) => 3 + i * 2)
  objects.push(Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"))
  objects.push(
    Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`),
  )
  const fontId = 3 + pages * 2
  for (let i = 0; i < pages; i++) {
    const contentId = pageIds[i]! + 1
    objects.push(
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] ` +
          `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    )
    const stream = Buffer.from(`BT /F1 24 Tf 20 60 Td (PAGE ${i + 1}) Tj ET`)
    objects.push(
      Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from("\nendstream")]),
    )
  }
  objects.push(Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"))

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n")]
  let length = chunks[0]!.length
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(length)
    const piece = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")])
    chunks.push(piece)
    length += piece.length
  })
  const xref = length
  const trailer = Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
      offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("") +
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  )
  chunks.push(trailer)
  return Buffer.concat(chunks)
}

describe("rasterizePdf", () => {
  test("renders every page to a JPEG when the document is small", async () => {
    const result = await rasterizePdf(makePdf(3))
    expect(result.total).toBe(3)
    expect(result.pages.map((p) => p.page)).toEqual([1, 2, 3])
    expect(result.truncated).toBeUndefined()
    for (const page of result.pages) {
      expect(page.mime).toBe("image/jpeg")
      // JPEG SOI marker, so this is a real image and not an empty buffer.
      expect(Buffer.from(page.base64, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    }
  })

  test("stops at the page limit and says so", async () => {
    const result = await rasterizePdf(makePdf(5), { maxPages: 2 })
    expect(result.pages).toHaveLength(2)
    expect(result.total).toBe(5)
    expect(result.truncated).toBe("page-limit")
    expect(describeRaster(result)).toContain("pages 1, 2 of 5")
  })

  test("stops at the size budget but never returns zero pages", async () => {
    // A budget far below one page's cost: page 1 is kept regardless, because a
    // caller cannot distinguish an empty result from a failure.
    const result = await rasterizePdf(makePdf(4), { maxTotalBase64Bytes: 1 })
    expect(result.pages).toHaveLength(1)
    expect(result.truncated).toBe("size-limit")
  })

  test("honours the dpi setting", async () => {
    const low = await rasterizePdf(makePdf(1), { dpi: 72 })
    const high = await rasterizePdf(makePdf(1), { dpi: 300 })
    expect(low.dpi).toBe(72)
    expect(high.pages[0]!.base64.length).toBeGreaterThan(low.pages[0]!.base64.length)
  })

  test("fails loudly on something that is not a PDF", async () => {
    await expect(rasterizePdf(Buffer.from("this is not a pdf"))).rejects.toBeInstanceOf(PdfRasterError)
  })

  test("describeRaster names the file and the page count", async () => {
    const result = await rasterizePdf(makePdf(2))
    expect(describeRaster(result, "scan.pdf")).toBe("scan.pdf: rendered all 2 pages to images at 150 DPI.")
  })

  // The sidecar ships as a Bun single-file executable, where mupdf's own runtime lookup for its
  // WASM resolves to a path that does not exist. We embed a vendored copy instead. If someone bumps
  // `mupdf` without refreshing that copy, every other test here still passes and the packaged app
  // breaks on the first scan -- so compare the bytes.
  test("the vendored WASM matches the installed mupdf package", async () => {
    const vendored = Bun.file(new URL("../src/util/vendor/mupdf-wasm.wasm", import.meta.url))
    const installed = Bun.file(new URL("./mupdf-wasm.wasm", import.meta.resolve("mupdf")))
    expect(await vendored.exists()).toBe(true)
    expect(await installed.exists()).toBe(true)
    expect(vendored.size).toBe(installed.size)
    expect(Bun.SHA256.hash(await vendored.arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(await installed.arrayBuffer(), "hex"),
    )
  })
})
