import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  assembleContainerRaw,
  attributeBlock,
  blockHeader,
  deflate,
  extractModuleText,
  makeModuleContainer,
  NotAContainerError,
  readContainer,
  readContainerRaw,
  writeContainer,
} from "./container"

describe("block header", () => {
  // Fixed width, lower-case hex, and a trailing space before the CRLF. 1C
  // writes it this way and the reader depends on the exact shape.
  test("is the exact 31-byte shape 1C writes", () => {
    const header = blockHeader(0x180, 0x200)
    expect(header.toString("ascii")).toBe("\r\n00000180 00000200 7fffffff \r\n")
    expect(header.length).toBe(31)
  })
})

describe("attribute block", () => {
  test("puts the name at byte 20, in UTF-16LE", () => {
    const attr = attributeBlock("form", 1n)
    expect(attr.subarray(20, 20 + 8).toString("utf16le")).toBe("form")
  })

  // The bug this exists to prevent: writing the creation stamp into both slots
  // silently discards the modification time. The reference Python does that.
  test("keeps creation and modification times apart", () => {
    const attr = attributeBlock("x", 111n, 222n)
    expect(attr.readBigUInt64LE(0)).toBe(111n)
    expect(attr.readBigUInt64LE(8)).toBe(222n)
  })

  test("defaults the modification time to the creation time", () => {
    const attr = attributeBlock("x", 111n)
    expect(attr.readBigUInt64LE(8)).toBe(111n)
  })
})

describe("write then read", () => {
  const files = [
    { name: "root", content: Buffer.from("<root/>", "utf8") },
    { name: "big", content: Buffer.alloc(4096, 0x41) },
    { name: "имя-в-юникоде", content: Buffer.from("значение", "utf8") },
  ]

  test("returns every entry, by name, with its content intact", () => {
    const read = readContainer(writeContainer(files))
    expect(read.map((entry) => entry.name).sort()).toEqual(["big", "root", "имя-в-юникоде"])
    for (const original of files) {
      const found = read.find((entry) => entry.name === original.name)
      expect(found?.content.equals(original.content)).toBe(true)
    }
  })

  test("handles an entry larger than the page size", () => {
    const read = readContainer(writeContainer(files))
    expect(read.find((entry) => entry.name === "big")?.content.length).toBe(4096)
  })

  test("handles an empty container", () => {
    expect(readContainer(writeContainer([]))).toEqual([])
  })

  test("rejects something that is not a container", () => {
    expect(() => readContainer(Buffer.from("not a container at all"))).toThrow(NotAContainerError)
  })
})

describe("raw round trip", () => {
  test("rebuilding untouched entries reproduces the bytes exactly", () => {
    const built = writeContainer([
      { name: "a", content: Buffer.from("first") },
      { name: "b", content: Buffer.alloc(1024, 7) },
    ])
    const raw = readContainerRaw(built)
    const rebuilt = assembleContainerRaw(
      raw.pageSize,
      raw.entries.map((entry) => ({ attr: entry.attr, payload: entry.stored })),
      raw.tocOrder,
    )
    expect(rebuilt.equals(built)).toBe(true)
  })

  test("preserves differing creation and modification times through a rebuild", () => {
    // Assembled by hand because writeContainer has no reason to expose two
    // stamps; real .epf files in the wild do carry two different ones.
    const attr = attributeBlock("module", 111n, 222n)
    const built = assembleContainerRaw(512, [{ attr, payload: deflate(Buffer.from("x")) }], [0])
    const entry = readContainerRaw(built).entries[0]!
    expect(entry.created).toBe(111n)
    expect(entry.modified).toBe(222n)
  })

  test("replacing one payload leaves every other entry untouched", () => {
    const built = writeContainer([
      { name: "keep", content: Buffer.from("unchanged") },
      { name: "edit", content: Buffer.from("before") },
    ])
    const raw = readContainerRaw(built)
    const editIndex = raw.entries.findIndex((entry) => entry.name === "edit")

    const rebuilt = assembleContainerRaw(
      raw.pageSize,
      raw.entries.map((entry, index) => ({
        attr: entry.attr,
        payload: index === editIndex ? deflate(Buffer.from("after")) : entry.stored,
      })),
      raw.tocOrder,
    )

    const read = readContainer(rebuilt)
    expect(read.find((entry) => entry.name === "keep")?.content.toString()).toBe("unchanged")
    expect(read.find((entry) => entry.name === "edit")?.content.toString()).toBe("after")
  })
})

describe("module containers", () => {
  test("round-trips module text", () => {
    const bsl = Buffer.from("Процедура Тест()\r\nКонецПроцедуры\r\n", "utf8")
    expect(extractModuleText(makeModuleContainer(bsl))?.subarray(3).equals(bsl)).toBe(true)
  })

  test("does not add a second byte order mark to text that has one", () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Тест", "utf8")])
    const text = extractModuleText(makeModuleContainer(withBom))!
    expect(text.equals(withBom)).toBe(true)
  })

  test("returns null for content that is not a module container", () => {
    expect(extractModuleText(Buffer.from("plain bytes"))).toBeNull()
  })
})

// These need the real 1C files. They are the only place the continuation-chunk
// path is exercised, because our writer never emits one -- so when the fixtures
// are absent the format's subtlest case simply goes untested, and the tests say
// so rather than pretending to pass. Point V8PACK_FIXTURES at a directory
// holding an MCP_Toolkit.epf and the OneMCP.cfe extension to run them.
const FIXTURE_DIR = process.env.V8PACK_FIXTURES ?? ""
const FIXTURES = {
  epf: join(FIXTURE_DIR, "MCP_Toolkit.epf"),
  cfe: join(FIXTURE_DIR, "OneMCP.cfe"),
}
const haveFixtures = FIXTURE_DIR !== "" && existsSync(FIXTURES.epf) && existsSync(FIXTURES.cfe)
const withFixtures = haveFixtures ? describe : describe.skip

withFixtures("real 1C files", () => {
  test("an untouched .epf rebuilds byte for byte", () => {
    const original = readFileSync(FIXTURES.epf)
    const raw = readContainerRaw(original)
    const rebuilt = assembleContainerRaw(
      raw.pageSize,
      raw.entries.map((entry) => ({ attr: entry.attr, payload: entry.stored })),
      raw.tocOrder,
    )
    expect(rebuilt.equals(original)).toBe(true)
  })

  // OneMCP.cfe has a 516-byte table of contents in 512-byte pages: 512 bytes in
  // the first chunk and 4 in a continuation. A reader that treats the header's
  // third field as a constant truncates the TOC and loses the last entry.
  test("follows a continuation chunk instead of truncating the table of contents", () => {
    const raw = readContainerRaw(readFileSync(FIXTURES.cfe))
    expect(raw.entries.length).toBe(43)
    expect(raw.tocOrder.length).toBe(43)
  })

  test("every .cfe entry decodes", () => {
    const raw = readContainerRaw(readFileSync(FIXTURES.cfe))
    expect(raw.entries.every((entry) => entry.content.length > 0)).toBe(true)
  })
})
