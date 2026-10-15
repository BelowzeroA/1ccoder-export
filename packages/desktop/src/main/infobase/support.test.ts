import { describe, expect, test } from "bun:test"

import { writeTarget } from "./bulk"
import { decideSupport, supportRefusal, type SupportProbe } from "./support"

// 2026-09-21, debrief6.md §9 C5. Rung 5 of the mechanism ladder -- editing the
// configuration -- takes the base off support. Three sessions were told that in
// prose and the prose held only while editing the configuration was awkward;
// `dump_config_to_files` (C2) makes it one call away, so the rule needs teeth.
//
// The tests build a dump in memory rather than on disk: a real
// ParentConfigurations.bin comes with a 1.8 GB configuration attached.

const CONFIG = "C:\\dump"
const BIN = `${CONFIG}\\Ext\\ParentConfigurations.bin`

const VENDOR_UUID = "aaaaaaaa-1111-2222-3333-444444444444"
const OWN_UUID = "bbbbbbbb-1111-2222-3333-444444444444"

/**
 * A dump whose .bin says what `records` says.
 *
 * `capability` 1 means the vendor switched modification off for the whole
 * configuration; per-object state 0 means that object is on the vendor's lock.
 */
function dump(options: {
  readonly files: Record<string, string>
  readonly capability?: number
  readonly records?: readonly string[]
  readonly noBin?: boolean
}): SupportProbe {
  const records = options.records ?? []
  const bin = `{6,${options.capability ?? 0},${records.length},${records.join(",")}}`
  const files: Record<string, string> = {
    [`${CONFIG}\\Configuration.xml`]: `<MetaDataObject><Configuration uuid="${OWN_UUID}">`,
    ...options.files,
  }
  const directories = new Set<string>([CONFIG, `${CONFIG}\\Ext`, `${CONFIG}\\CommonTemplates`])
  for (const path of Object.keys(files)) {
    let at = path.lastIndexOf("\\")
    while (at > 2) {
      directories.add(path.slice(0, at))
      at = path.lastIndexOf("\\", at - 1)
    }
  }
  return {
    isFile: (path) => path in files || (!options.noBin && path === BIN),
    isDirectory: (path) => directories.has(path) && !(path in files),
    readText: (path) => files[path] ?? null,
    readBytes: (path) => (path === BIN && !options.noBin ? new TextEncoder().encode(bin) : null),
  }
}

/** The uuid record shape inside the .bin: `<state>,0,<uuid>`. */
function record(uuid: string, state: number): string {
  return `${state},0,${uuid.toLowerCase()}`
}

describe("a vendor object on the lock", () => {
  const probe = dump({
    files: {
      [`${CONFIG}\\CommonTemplates\\ПФ_MXL_СчетЗаказ.xml`]: `<MetaDataObject><CommonTemplate uuid="${VENDOR_UUID}">`,
    },
    records: [record(VENDOR_UUID, 0)],
  })

  test("is refused", () => {
    const verdict = decideSupport(`${CONFIG}\\CommonTemplates\\ПФ_MXL_СчетЗаказ.xml`, probe)
    expect(verdict.blocked).toBe(true)
    expect(verdict.code).toBe("locked")
    expect(verdict.configDir).toBe(CONFIG)
  })

  // The actual failure mode: nobody edits the object's own .xml, they edit the
  // Template.xml two directories down. That file carries no uuid, so the
  // support state has to be inherited from the object above it.
  test("is refused through a sub-element that carries no uuid of its own", () => {
    const withTemplate = dump({
      files: {
        [`${CONFIG}\\CommonTemplates\\ПФ_MXL_СчетЗаказ.xml`]: `<MetaDataObject><CommonTemplate uuid="${VENDOR_UUID}">`,
        [`${CONFIG}\\CommonTemplates\\ПФ_MXL_СчетЗаказ\\Ext\\Template.xml`]: "<document><rowsItem/></document>",
      },
      records: [record(VENDOR_UUID, 0)],
    })
    const verdict = decideSupport(
      `${CONFIG}\\CommonTemplates\\ПФ_MXL_СчетЗаказ\\Ext\\Template.xml`,
      withTemplate,
    )
    expect(verdict.blocked).toBe(true)
  })

  // Being told "no" without being told what instead is what produced three
  // identical retries in debrief4 §2.2.
  test("names the lighter mechanisms rather than only refusing", () => {
    const message = supportRefusal({ blocked: true, code: "locked", configDir: CONFIG }, "C:\\x.xml")
    expect(message).toContain("снять базу с поддержки")
    expect(message).toContain("ПользовательскиеМакетыПечати")
    expect(message).toContain("1ccoder-ib-print-forms")
  })
})

describe("what stays editable", () => {
  test("an object the vendor left open", () => {
    const probe = dump({
      files: {
        [`${CONFIG}\\CommonTemplates\\Наш.xml`]: `<MetaDataObject><CommonTemplate uuid="${VENDOR_UUID}">`,
      },
      records: [record(VENDOR_UUID, 1)],
    })
    expect(decideSupport(`${CONFIG}\\CommonTemplates\\Наш.xml`, probe).blocked).toBe(false)
  })

  test("a configuration that carries no support records at all", () => {
    const probe = dump({
      files: {
        [`${CONFIG}\\CommonTemplates\\Наш.xml`]: `<MetaDataObject><CommonTemplate uuid="${VENDOR_UUID}">`,
      },
      records: [],
    })
    expect(decideSupport(`${CONFIG}\\CommonTemplates\\Наш.xml`, probe).blocked).toBe(false)
  })

  // The dump of an .epf sitting inside the config tree is not part of the
  // configuration, however the paths look. Building external processing is the
  // normal workflow and must not be caught by this.
  test("an autonomous .epf dump, even inside the config tree", () => {
    const probe = dump({
      files: {
        [`${CONFIG}\\Моя.xml`]: '<MetaDataObject xmlns="x"><ExternalDataProcessor uuid="z">',
        [`${CONFIG}\\Моя\\Ext\\ObjectModule.bsl`]: "Процедура П() КонецПроцедуры",
      },
      capability: 1,
    })
    expect(decideSupport(`${CONFIG}\\Моя.xml`, probe).blocked).toBe(false)
    expect(decideSupport(`${CONFIG}\\Моя\\Ext\\ObjectModule.bsl`, probe).blocked).toBe(false)
  })

  test("a file that belongs to no configuration", () => {
    const probe = dump({ files: {} })
    expect(decideSupport("C:\\elsewhere\\notes.md", probe).blocked).toBe(false)
  })
})

// A guard that blocks on its own bugs is worse than no guard, because the way
// round it is to stop using the dump -- which is the artefact we just spent C2
// making available.
describe("it fails open, never closed", () => {
  test("when the .bin is missing", () => {
    const probe = dump({
      files: { [`${CONFIG}\\CommonTemplates\\Наш.xml`]: `<CommonTemplate uuid="${VENDOR_UUID}">` },
      records: [record(VENDOR_UUID, 0)],
      noBin: true,
    })
    expect(decideSupport(`${CONFIG}\\CommonTemplates\\Наш.xml`, probe).blocked).toBe(false)
  })

  test("when every read throws", () => {
    const hostile: SupportProbe = {
      isFile: () => {
        throw new Error("nope")
      },
      isDirectory: () => {
        throw new Error("nope")
      },
      readText: () => {
        throw new Error("nope")
      },
      readBytes: () => {
        throw new Error("nope")
      },
    }
    expect(decideSupport(`${CONFIG}\\anything.xml`, hostile).blocked).toBe(false)
  })

  test("when the .bin header is not what we expect", () => {
    const probe: SupportProbe = {
      isFile: () => true,
      isDirectory: () => false,
      readText: () => `<CommonTemplate uuid="${VENDOR_UUID}">`,
      readBytes: () => new TextEncoder().encode("this is not a support header, but it is long enough"),
    }
    expect(decideSupport(`${CONFIG}\\CommonTemplates\\Наш.xml`, probe).blocked).toBe(false)
  })
})

describe("whole-configuration lock", () => {
  test("blocks regardless of the object", () => {
    const probe = dump({
      files: { [`${CONFIG}\\CommonTemplates\\Наш.xml`]: `<CommonTemplate uuid="${OWN_UUID}">` },
      capability: 1,
      records: [record(VENDOR_UUID, 2)],
    })
    const verdict = decideSupport(`${CONFIG}\\CommonTemplates\\Наш.xml`, probe)
    expect(verdict.blocked).toBe(true)
    expect(verdict.code).toBe("capability-off")
  })
})

// Which tool calls get inspected at all. Reads are deliberately absent: reading
// the dump is what C2 exists for.
describe("write targets", () => {
  test("are taken from the write tools", () => {
    expect(writeTarget("edit", { filePath: "C:\\a.xml" })).toBe("C:\\a.xml")
    expect(writeTarget("Write", { file_path: "C:\\b.xml" })).toBe("C:\\b.xml")
    expect(writeTarget("patch", { filePath: "  C:\\c.xml  " })).toBe("C:\\c.xml")
  })

  test("are not taken from anything else", () => {
    expect(writeTarget("read", { filePath: "C:\\a.xml" })).toBeUndefined()
    expect(writeTarget("grep", { filePath: "C:\\a.xml" })).toBeUndefined()
    expect(writeTarget("bash", { command: "del C:\\a.xml" })).toBeUndefined()
  })

  test("survive arguments that are not what we expect", () => {
    expect(writeTarget("edit", undefined)).toBeUndefined()
    expect(writeTarget("edit", null)).toBeUndefined()
    expect(writeTarget("edit", { filePath: "" })).toBeUndefined()
    expect(writeTarget("edit", { filePath: 42 })).toBeUndefined()
  })
})
