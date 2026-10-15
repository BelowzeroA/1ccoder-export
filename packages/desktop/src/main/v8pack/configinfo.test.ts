import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { assembleContainerRaw, attributeBlock, deflate, makeModuleContainer, readContainerRaw } from "./container"
import { packContainer, unpackContainer } from "./tree"

// debrief13.md §13.9: a module rebuilt without its `configinfo` line updated
// loaded fine and was then undone by /UpdateDBCfg -Extension on a real base;
// with the one hash recalculated it stayed and ran.

const sha1 = (data: Buffer) => createHash("sha1").update(data).digest("base64")
const dir = mkdtempSync(join(tmpdir(), "v8pack-configinfo-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function container(withInfo: boolean): Buffer {
  const module = deflate(makeModuleContainer(Buffer.from("Процедура А()\n\tСтарое = 1;\nКонецПроцедуры\n", "utf8")))
  const other = deflate(Buffer.from("{1,other}", "utf8"))
  const info = `﻿{2,{"m.0",${sha1(module)}},{"other",${sha1(other)}}}`
  const entries = [
    { attr: attributeBlock("m.0", 1n), payload: module },
    { attr: attributeBlock("other", 1n), payload: other },
    ...(withInfo ? [{ attr: attributeBlock("configinfo", 1n), payload: deflate(Buffer.from(info, "utf8")) }] : []),
  ]
  return assembleContainerRaw(512, entries, entries.map((_, at) => at))
}

async function editAndPack(name: string, withInfo: boolean, edit: boolean) {
  const source = join(dir, `${name}.cf`)
  writeFileSync(source, container(withInfo))
  const unpacked = join(dir, name)
  const manifest = await unpackContainer(source, unpacked)
  if (edit) {
    const file = join(unpacked, manifest.entries.find((entry) => entry.name === "m.0")!.file)
    writeFileSync(file, readFileSync(file, "utf8").replace("Старое", "Новое"))
  }
  const out = join(dir, `${name}.out.cf`)
  const result = await packContainer(unpacked, out)
  return { source, out, result, raw: readContainerRaw(readFileSync(out)) }
}

describe("packing a configuration container", () => {
  test("an edited record gets its configinfo hash recalculated, others keep theirs", async () => {
    const { raw, result } = await editAndPack("edited", true, true)
    const stored = (name: string) => raw.entries.find((entry) => entry.name === name)!.stored
    const info = raw.entries.find((entry) => entry.name === "configinfo")!.content.toString("utf8")
    expect(info).toContain(`"m.0",${sha1(stored("m.0"))}`)
    expect(info).toContain(`"other",${sha1(stored("other"))}`)
    expect(result.rebuilt).toEqual(["m.0", "configinfo"])
  })

  test("configinfo stays compressed, as the platform stores it", async () => {
    const { raw } = await editAndPack("compressed", true, true)
    expect(raw.entries.find((entry) => entry.name === "configinfo")!.deflate).toBe(true)
  })

  test("an untouched container still packs byte for byte", async () => {
    const { source, out, result } = await editAndPack("untouched", true, false)
    expect(result.rebuilt).toEqual([])
    expect(readFileSync(out).equals(readFileSync(source))).toBe(true)
  })

  test("a container without configinfo (a processing) is packed as before", async () => {
    const { result } = await editAndPack("processing", false, true)
    expect(result.rebuilt).toEqual(["m.0"])
  })
})
