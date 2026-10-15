// Unpacking a 1C container into an editable directory, and packing it back.
//
// The shape on disk is chosen so that a rebuild can tell what actually changed:
//
//   .v8pack.json      the manifest -- entry order, names, timestamps, hashes
//   raw/NNN.bin       each entry's stored bytes, exactly as they were
//   files/<name>      each entry's decoded content, for reading
//   modules/<name>.bsl       object module text, from a nested container
//   modules/<name>.form.bsl  form module text, from inside the form description
//
// The two kinds of module are extracted differently and written back
// differently -- see form-module.ts -- but both are edited the same way, which
// is the point: for most processings the form module is the whole program.
//
// Packing reuses `raw/NNN.bin` verbatim for every entry whose editable file
// still hashes to what the manifest recorded, and rebuilds only the rest. That
// is what makes an untouched round trip byte-identical: nothing is recompressed
// unless it changed, and zlib output is not reproducible across versions.
//
// The manifest holds hashes rather than timestamps because an editor that
// rewrites a file without changing its bytes must not force a recompression.

import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import {
  assembleContainerRaw,
  deflate,
  extractModuleText,
  makeModuleContainer,
  readContainerRaw,
  type AssembleEntry,
} from "./container"
import { findFormModule, replaceFormModule, unboundEventHandlers } from "./form-module"

export const MANIFEST_NAME = ".v8pack.json"
export const MANIFEST_VERSION = 2

/**
 * How an entry's editable file becomes entry content again.
 *
 * `raw`    the file is the content
 * `module` the file is module text, wrapped in a nested container
 * `form`   the file is module text, spliced into the form description in
 *          `substrate`, which is itself editable
 */
export type EntryKind = "raw" | "module" | "form"

export interface ManifestEntry {
  readonly index: number
  readonly name: string
  /** Where the editable copy lives, relative to the unpack directory. */
  readonly file: string
  readonly kind: EntryKind
  /** For `form`: the form description the module is spliced back into. */
  readonly substrate?: string
  /** For `form`: SHA-256 of that description, so edits to it are honoured too. */
  readonly substrateHash?: string
  readonly deflate: boolean
  /** SHA-256 of the editable file as written. A change here means a rebuild. */
  readonly hash: string
}

export interface Manifest {
  readonly version: number
  readonly pageSize: number
  readonly tocOrder: readonly number[]
  readonly entries: readonly ManifestEntry[]
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex")
}

/**
 * Makes an entry name safe to use as a file name.
 *
 * Container entry names are GUIDs and dotted suffixes in practice, but nothing
 * in the format guarantees it, and a name containing a slash would otherwise
 * write outside the unpack directory.
 */
export function safeFileName(name: string, index: number): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "")
  return cleaned.length > 0 ? `${String(index).padStart(3, "0")}_${cleaned}` : `${String(index).padStart(3, "0")}`
}

export async function unpackContainer(containerPath: string, outDir: string): Promise<Manifest> {
  const raw = readContainerRaw(await readFile(containerPath))

  await mkdir(join(outDir, "raw"), { recursive: true })
  await mkdir(join(outDir, "files"), { recursive: true })
  await mkdir(join(outDir, "modules"), { recursive: true })

  const entries: ManifestEntry[] = []

  for (const [index, entry] of raw.entries.entries()) {
    const base = safeFileName(entry.name, index)
    await writeFile(join(outDir, "raw", `${String(index).padStart(3, "0")}.bin`), entry.stored)
    // The attribute block is kept verbatim; it carries two timestamps, and
    // reconstructing it from parsed fields loses the modification time.
    await writeFile(join(outDir, "raw", `${String(index).padStart(3, "0")}.attr`), entry.attr)

    const moduleText = extractModuleText(entry.content)
    if (moduleText) {
      const file = join("modules", `${base}.bsl`)
      await mkdir(dirname(join(outDir, file)), { recursive: true })
      await writeFile(join(outDir, file), moduleText)
      entries.push({
        index,
        name: entry.name,
        file: file.replace(/\\/g, "/"),
        kind: "module",
        deflate: entry.deflate,
        hash: sha256(moduleText),
      })
      continue
    }

    // Whatever this is, it is written out whole and readable. A form gets its
    // module lifted out beside it as well; the description stays editable
    // because the module is not the only thing in it worth changing.
    const substrate = join("files", base)
    await mkdir(dirname(join(outDir, substrate)), { recursive: true })
    await writeFile(join(outDir, substrate), entry.content)

    const form = findFormModule(entry.content)
    if (!form) {
      entries.push({
        index,
        name: entry.name,
        file: substrate.replace(/\\/g, "/"),
        kind: "raw",
        deflate: entry.deflate,
        hash: sha256(entry.content),
      })
      continue
    }

    const file = join("modules", `${base}.form.bsl`)
    const bsl = Buffer.from(form.text, "utf8")
    await mkdir(dirname(join(outDir, file)), { recursive: true })
    await writeFile(join(outDir, file), bsl)

    entries.push({
      index,
      name: entry.name,
      file: file.replace(/\\/g, "/"),
      kind: "form",
      substrate: substrate.replace(/\\/g, "/"),
      substrateHash: sha256(entry.content),
      deflate: entry.deflate,
      hash: sha256(bsl),
    })
  }

  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    pageSize: raw.pageSize,
    tocOrder: [...raw.tocOrder],
    entries,
  }
  await writeFile(join(outDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  return manifest
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ManifestError"
  }
}

/** Turns an entry's editable file (or files) back into stored bytes. */
function rebuild(entry: ManifestEntry, editable: Buffer, substrate: Buffer | null): Buffer {
  let content: Buffer
  if (entry.kind === "module") {
    content = makeModuleContainer(editable)
  } else if (entry.kind === "form") {
    if (!substrate) throw new ManifestError(`Entry ${entry.name} is a form module with no ${entry.substrate}`)
    const spliced = replaceFormModule(substrate, editable)
    // The description was edited into something with no module in it. Writing
    // the module in anyway would put it somewhere arbitrary, so refuse and say
    // which file to look at -- a corrupted .epf is found much later and costs
    // much more.
    if (!spliced) {
      throw new ManifestError(
        `Cannot put the module back into ${entry.name}: no module found in ${entry.substrate}. ` +
          `Undo the edits to that file, or unpack the container again.`,
      )
    }
    content = spliced
  } else {
    content = editable
  }
  return entry.deflate ? deflate(content) : content
}

export interface PackResult {
  readonly bytes: number
  /** Names of the entries that had to be rebuilt. Empty means a byte-identical repack. */
  readonly rebuilt: readonly string[]
  /** Rebuilt form modules with event handlers their form does not bind -- dead code until bound. */
  readonly unbound: readonly { readonly entry: string; readonly handlers: readonly string[] }[]
}

export async function packContainer(sourceDir: string, outPath: string): Promise<PackResult> {
  let manifest: Manifest
  try {
    manifest = JSON.parse(await readFile(join(sourceDir, MANIFEST_NAME), "utf8")) as Manifest
  } catch {
    throw new ManifestError(`No ${MANIFEST_NAME} in ${sourceDir}. Unpack the container first.`)
  }
  if (manifest.version !== MANIFEST_VERSION) {
    throw new ManifestError(`Unsupported manifest version ${manifest.version}`)
  }

  const assembled: AssembleEntry[] = []
  const rebuilt: string[] = []
  const unbound: { entry: string; handlers: string[] }[] = []

  for (const entry of manifest.entries) {
    const stem = String(entry.index).padStart(3, "0")
    const attr = await readFile(join(sourceDir, "raw", `${stem}.attr`))
    const editable = await readFile(join(sourceDir, entry.file))
    // A form has two editable files and either may have moved.
    const substrate = entry.substrate ? await readFile(join(sourceDir, entry.substrate)) : null
    const untouched =
      sha256(editable) === entry.hash && (!substrate || sha256(substrate) === entry.substrateHash)

    if (untouched) {
      // Unchanged: reuse the original stored bytes rather than recompressing,
      // which would produce a different file with identical meaning.
      assembled.push({ attr, payload: await readFile(join(sourceDir, "raw", `${stem}.bin`)) })
      continue
    }

    rebuilt.push(entry.name)
    assembled.push({ attr, payload: rebuild(entry, editable, substrate) })
    if (entry.kind === "form" && substrate) {
      const handlers = unboundEventHandlers(substrate, editable)
      if (handlers.length > 0) unbound.push({ entry: entry.name, handlers })
    }
  }

  // A configuration or extension container lists every record's hash in
  // `configinfo`. Rebuilding a record without updating its line there leaves a
  // container the configurator loads, and /UpdateDBCfg then treats as
  // unchanged, restoring the previous version in its place -- verified on a
  // real extension, 2026-09-25, debrief13.md §13.9.
  const infoAt = manifest.entries.findIndex((entry) => entry.name === "configinfo")
  const info = infoAt >= 0 ? manifest.entries[infoAt] : undefined
  if (info && rebuilt.length > 0 && info.kind === "raw") {
    const text = (await readFile(join(sourceDir, info.file))).toString("utf8")
    const stored = new Map(
      manifest.entries.map((entry, at) => [entry.name, assembled[at]!.payload] as const).filter(([name]) => rebuilt.includes(name)),
    )
    const refreshed = refreshConfigInfo(text, stored)
    if (refreshed !== text) {
      assembled[infoAt] = { attr: assembled[infoAt]!.attr, payload: rebuild(info, Buffer.from(refreshed, "utf8"), null) }
      if (!rebuilt.includes(info.name)) rebuilt.push(info.name)
    }
  }

  const bytes = assembleContainerRaw(manifest.pageSize, assembled, manifest.tocOrder)
  const parent = dirname(outPath)
  // "." for a bare filename, and creating it can fail with EEXIST even with
  // recursive:true depending on the runtime -- a missing parent is the only
  // case worth handling here.
  if (parent && parent !== "." && parent !== outPath) await mkdir(parent, { recursive: true }).catch(() => undefined)
  await writeFile(outPath, bytes)
  return { bytes: bytes.length, rebuilt, unbound }
}

/**
 * `configinfo` with the hash of each given record replaced by
 * base64(SHA-1(stored bytes)) -- the record as it sits in the container,
 * compressed. Records it does not list are left alone.
 */
export function refreshConfigInfo(text: string, stored: ReadonlyMap<string, Buffer>): string {
  return [...stored].reduce((current, [name, payload]) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const hash = createHash("sha1").update(payload).digest("base64")
    return current.replace(new RegExp(`("${escaped}",)[A-Za-z0-9+/]{27}=`), `$1${hash}`)
  }, text)
}

/** Removes an unpack directory. Used by tests and by the CLI's --clean. */
export async function removeTree(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/** Lists the editable files in an unpack directory, for a quick overview. */
export async function listEditable(sourceDir: string): Promise<string[]> {
  const out: string[] = []
  for (const sub of ["modules", "files"]) {
    try {
      for (const name of await readdir(join(sourceDir, sub))) out.push(`${sub}/${name}`)
    } catch {
      // Directory absent: nothing of that kind in this container.
    }
  }
  return out.sort()
}
