// The 1C:Enterprise v8 container format: read and write.
//
// Ported from v8pack.py, an earlier Python implementation,
// which is stdlib-only and needs no 1C platform binary. That is precisely why
// profile-less sessions are possible at all -- everything here is pure byte
// manipulation, so an .epf can be opened, edited and rebuilt on a machine with
// no 1C installed.
//
// Layout:
//
//   header   16 bytes: magic 0x7FFFFFFF, page size, entry count, reserved
//   block    "\r\n" + "<dataHex> <storedHex> 7fffffff " + "\r\n" + stored bytes
//   block 0  the table of contents: 12 bytes per entry
//            (attribute block offset, content block offset, 0x7FFFFFFF)
//   then     one attribute block and one content block per entry, in pairs
//
// An attribute block is two little-endian 64-bit timestamps, four zero bytes,
// the name in UTF-16LE, and four more zero bytes -- so the name begins at byte
// 20. Content blocks are usually raw-deflate compressed and padded to the page
// size; nested module containers are not compressed.
//
// Two things are worth knowing before changing anything here.
//
// The TOC order is NOT the physical order. 1C sorts the table of contents by
// name while the blocks themselves sit in whatever order they were written, so
// a rebuild that ignores the distinction produces a container 1C can still open
// but which no longer matches the original byte for byte. readContainerRaw
// therefore returns the permutation, and assembleContainerRaw replays it.
//
// Recompressing is not reversible. zlib output differs between implementations
// and versions, so re-deflating an untouched entry would change the file
// without changing its meaning. The raw path keeps each entry's original stored
// bytes and reuses them verbatim; only entries whose content actually changed
// are compressed again.

import { deflateRawSync, inflateRawSync } from "node:zlib"

export const V8_MAGIC = 0x7fffffff
export const DEFAULT_PAGE_SIZE = 512

/** The UTF-8 byte order mark, which 1C puts in front of module text. */
export const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf])

export interface ContainerEntry {
  readonly name: string
  /** Creation time, as 1C stores it. */
  readonly created: bigint
  /**
   * Modification time. Frequently equal to `created`, but NOT always -- and an
   * implementation that writes the creation stamp twice loses this one, which
   * is a silent corruption of the file's metadata. The reference Python does
   * exactly that.
   */
  readonly modified: bigint
  /**
   * The attribute block exactly as it appears in the file. A rebuild reuses it
   * verbatim, which is both simpler and stricter than reconstructing it from
   * the parsed fields.
   */
  readonly attr: Buffer
  /** Whether the stored payload is deflate-compressed. */
  readonly deflate: boolean
  /** The payload exactly as it sits in the file, before page padding. */
  readonly stored: Buffer
  /** The payload decompressed; identical to `stored` when `deflate` is false. */
  readonly content: Buffer
}

export interface RawContainer {
  readonly pageSize: number
  /** Entries in physical order. */
  readonly entries: readonly ContainerEntry[]
  /** Indices into `entries`, in the order the table of contents lists them. */
  readonly tocOrder: readonly number[]
}

/** What assembleContainerRaw needs: an attribute block and the final stored bytes. */
export interface AssembleEntry {
  /** Use an entry's own `attr` to rebuild it exactly, or attributeBlock() for a new one. */
  readonly attr: Buffer
  readonly payload: Buffer
}

export function deflate(data: Buffer): Buffer {
  return deflateRawSync(data)
}

export function inflate(data: Buffer): Buffer {
  return inflateRawSync(data)
}

/**
 * A block header. The trailing space before the CRLF is not decoration -- 1C
 * writes it, and the header is a fixed width the reader relies on.
 */
export function blockHeader(dataSize: number, storedSize: number): Buffer {
  const hex = (value: number) => value.toString(16).padStart(8, "0")
  return Buffer.from(`\r\n${hex(dataSize)} ${hex(storedSize)} 7fffffff \r\n`, "ascii")
}

export function attributeBlock(name: string, created: bigint = 0n, modified: bigint = created): Buffer {
  const stamps = Buffer.alloc(16)
  stamps.writeBigUInt64LE(created, 0)
  stamps.writeBigUInt64LE(modified, 8)
  return Buffer.concat([stamps, Buffer.alloc(4), Buffer.from(name, "utf16le"), Buffer.alloc(4)])
}

/** How much space a payload occupies once padded to the page size. */
function storedSize(length: number, pageSize: number): number {
  return length >= pageSize ? length : pageSize
}

interface Block {
  readonly headerStart: number
  /** The block's full payload, gathered across continuation chunks. */
  readonly data: Buffer
}

interface ChunkHeader {
  readonly dataSize: number
  readonly storedSize: number
  readonly next: number
  readonly dataOffset: number
}

const NO_NEXT = 0x7fffffff
const HEADER_LENGTH = 31

/**
 * A chunk header: `\r\n<total> <thisChunk> <nextChunkOffset> \r\n`.
 *
 * The third field is NOT the magic, despite looking like it in most files. It
 * is the offset of the next chunk, and equals 0x7fffffff only when there is no
 * next chunk -- which is the common case, and exactly why it is easy to get
 * wrong. OneMCP.cfe has a 516-byte table of contents in a 512-byte page: 512
 * bytes sit in the first chunk and the remaining 4 in a continuation whose
 * offset lives in this field. The reference Python implementation reads the
 * third field as a constant, silently truncates such blocks, and still reports
 * its output as byte-identical.
 */
function parseChunkHeader(data: Buffer, at: number): ChunkHeader | null {
  if (at + HEADER_LENGTH > data.length) return null
  if (data[at] !== 0x0d || data[at + 1] !== 0x0a) return null

  const crlf = data.indexOf("\r\n", at + 2, "ascii")
  if (crlf === -1) return null

  const parts = data.toString("ascii", at + 2, crlf).trim().split(/\s+/)
  const dataSize = Number.parseInt(parts[0] ?? "", 16)
  const storedSize = Number.parseInt(parts[1] ?? "", 16)
  const next = Number.parseInt(parts[2] ?? "", 16)
  if (!Number.isFinite(dataSize) || !Number.isFinite(storedSize) || !Number.isFinite(next)) return null

  return { dataSize, storedSize, next, dataOffset: crlf + 2 }
}

/** Reads one block, following its continuation chain until its full length is gathered. */
function readBlock(
  data: Buffer,
  at: number,
): { block: Block; nextScanPos: number; continuations: number[] } | null {
  const first = parseChunkHeader(data, at)
  if (!first) return null

  const total = first.dataSize
  const chunks: Buffer[] = []
  const continuations: number[] = []
  let gathered = 0
  let chunk: ChunkHeader | null = first
  const visited = new Set<number>()

  while (chunk && gathered < total) {
    const take = Math.min(chunk.storedSize, total - gathered)
    chunks.push(data.subarray(chunk.dataOffset, chunk.dataOffset + take))
    gathered += take

    if (gathered >= total || chunk.next === NO_NEXT) break
    // A malformed file must not spin here forever.
    if (visited.has(chunk.next)) break
    visited.add(chunk.next)
    continuations.push(chunk.next)
    chunk = parseChunkHeader(data, chunk.next)
  }

  return {
    block: { headerStart: at, data: Buffer.concat(chunks) },
    // Scanning continues after this chunk only. The chunks that carry the rest
    // of the block sit elsewhere in the file and are reported separately.
    nextScanPos: first.dataOffset + first.storedSize,
    continuations,
  }
}

function scanBlocks(data: Buffer): Block[] {
  const blocks: Block[] = []
  // Chunks already consumed as the tail of an earlier block. The sequential
  // walk will reach them, and they must not be mistaken for blocks of their
  // own. Emptiness cannot be the test: an empty container has a legitimately
  // empty table of contents, and a container may hold an empty entry.
  const continuationOffsets = new Set<number>()
  let pos = 0x10

  while (pos < data.length) {
    const read = readBlock(data, pos)
    if (!read) break
    for (const offset of read.continuations) continuationOffsets.add(offset)
    if (!continuationOffsets.has(read.block.headerStart)) blocks.push(read.block)
    if (read.nextScanPos <= pos) break
    pos = read.nextScanPos
  }

  return blocks
}

function readName(attr: Buffer): string {
  // The name starts after two timestamps and four zero bytes, and is padded
  // with NULs that must not become part of it.
  return attr.subarray(20).toString("utf16le").replace(/\0+$/, "")
}

export class NotAContainerError extends Error {
  constructor() {
    super("Not a v8 container")
    this.name = "NotAContainerError"
  }
}

function assertContainer(data: Buffer): void {
  if (data.length < 16 || data.readUInt32LE(0) !== V8_MAGIC) throw new NotAContainerError()
}

/**
 * Reads a container preserving everything a byte-exact rebuild needs.
 *
 * This is the function the editing workflow uses. The simpler readContainer
 * below throws away the timestamps, the compression flags and the TOC order,
 * which is fine for inspection and fatal for round-tripping.
 */
export function readContainerRaw(data: Buffer): RawContainer {
  assertContainer(data)
  const pageSize = data.readUInt32LE(4)
  const blocks = scanBlocks(data)
  if (blocks.length === 0) throw new NotAContainerError()

  const entries: ContainerEntry[] = []
  const attrStartToIndex = new Map<number, number>()

  for (let i = 1; i + 1 < blocks.length; i += 2) {
    const attrBlock = blocks[i]!
    const stored = blocks[i + 1]!.data

    let content: Buffer
    let isDeflated: boolean
    try {
      content = inflate(stored)
      isDeflated = true
    } catch {
      // Not an error: nested module containers are stored uncompressed, and
      // failing to inflate is how they are recognised.
      content = stored
      isDeflated = false
    }

    attrStartToIndex.set(attrBlock.headerStart, entries.length)
    entries.push({
      name: readName(attrBlock.data),
      created: attrBlock.data.length >= 8 ? attrBlock.data.readBigUInt64LE(0) : 0n,
      modified: attrBlock.data.length >= 16 ? attrBlock.data.readBigUInt64LE(8) : 0n,
      attr: attrBlock.data,
      deflate: isDeflated,
      stored,
      content,
    })
  }

  const toc = blocks[0]!.data
  const tocOrder: number[] = []
  for (let i = 0; i + 12 <= toc.length; i += 12) {
    const index = attrStartToIndex.get(toc.readUInt32LE(i))
    // A TOC slot pointing at no block we found is padding, not an entry.
    if (index !== undefined) tocOrder.push(index)
  }

  return { pageSize, entries, tocOrder }
}

/**
 * Rebuilds a container from raw entries. With unmodified input this reproduces
 * the source byte for byte.
 */
export function assembleContainerRaw(
  pageSize: number,
  entries: readonly AssembleEntry[],
  tocOrder: readonly number[],
): Buffer {
  const count = entries.length
  const attrs = entries.map((entry) => entry.attr)

  const tocDataSize = count * 12
  const tocStoredSize = Math.max(tocDataSize, pageSize)
  const tocHeader = blockHeader(tocDataSize, tocStoredSize)

  // Where each entry's attribute and content blocks will land, computed before
  // anything is written because the TOC has to name those offsets.
  const spans: Array<[number, number]> = []
  let pos = 16 + tocHeader.length + tocStoredSize
  for (let i = 0; i < count; i++) {
    const attrLength = attrs[i]!.length
    const attrHeader = blockHeader(attrLength, attrLength)
    const payloadLength = entries[i]!.payload.length
    const contentHeader = blockHeader(payloadLength, storedSize(payloadLength, pageSize))
    spans.push([pos, pos + attrHeader.length + attrLength])
    pos += attrHeader.length + attrLength + contentHeader.length + storedSize(payloadLength, pageSize)
  }

  const parts: Buffer[] = []
  const header = Buffer.alloc(16)
  header.writeUInt32LE(V8_MAGIC, 0)
  header.writeUInt32LE(pageSize, 4)
  header.writeUInt32LE(count, 8)
  header.writeUInt32LE(0, 12)
  parts.push(header, tocHeader)

  const toc = Buffer.alloc(tocStoredSize)
  let offset = 0
  for (const index of tocOrder) {
    const span = spans[index]
    if (!span) continue
    toc.writeUInt32LE(span[0], offset)
    toc.writeUInt32LE(span[1], offset + 4)
    toc.writeUInt32LE(V8_MAGIC, offset + 8)
    offset += 12
  }
  parts.push(toc)

  for (let i = 0; i < count; i++) {
    const attr = attrs[i]!
    parts.push(blockHeader(attr.length, attr.length), attr)

    const payload = entries[i]!.payload
    const padded = storedSize(payload.length, pageSize)
    parts.push(blockHeader(payload.length, padded), payload)
    if (padded > payload.length) parts.push(Buffer.alloc(padded - payload.length))
  }

  return Buffer.concat(parts)
}

/** Name/content pairs, decompressed. For inspection; loses everything a rebuild needs. */
export function readContainer(data: Buffer): Array<{ name: string; content: Buffer }> {
  return readContainerRaw(data).entries.map((entry) => ({ name: entry.name, content: entry.content }))
}

/** Builds a container from scratch. Used for nested module containers. */
export function writeContainer(
  files: ReadonlyArray<{ name: string; content: Buffer }>,
  options: { pageSize?: number; compress?: boolean; timestamp?: bigint } = {},
): Buffer {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
  const compress = options.compress ?? true
  const timestamp = options.timestamp ?? 0n

  const entries: AssembleEntry[] = files.map((file) => ({
    attr: attributeBlock(file.name, timestamp),
    payload: compress ? deflate(file.content) : file.content,
  }))

  // Written from scratch, so physical and TOC order coincide.
  return assembleContainerRaw(
    pageSize,
    entries,
    entries.map((_, index) => index),
  )
}

/** Wraps module text in the nested container 1C expects. Never compressed. */
export function makeModuleContainer(bsl: Buffer): Buffer {
  const info = Buffer.concat([BOM_UTF8, Buffer.from('{3,1,0,"",0}', "ascii")])
  const text = bsl.subarray(0, 3).equals(BOM_UTF8) ? bsl : Buffer.concat([BOM_UTF8, bsl])
  return writeContainer(
    [
      { name: "info", content: info },
      { name: "text", content: text },
    ],
    { compress: false },
  )
}

/** The module text inside a nested container, or null when this is not one. */
export function extractModuleText(data: Buffer): Buffer | null {
  try {
    const text = readContainer(data).find((entry) => entry.name === "text")
    return text ? text.content : null
  } catch {
    return null
  }
}
