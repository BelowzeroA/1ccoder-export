import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { insideDump, profileDumpDirectories } from "./dump-dirs"
import type { DumpProbe } from "./dumps"

// debrief15.md §15.4: the profile's dump sat beside the base, and every new
// folder read there asked for permission.

/** A fake disk: files by path, directories derived from them. */
function disk(files: Record<string, string>): DumpProbe {
  const norm = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "")
  const all = Object.fromEntries(Object.entries(files).map(([path, text]) => [norm(path), text]))
  return {
    readText: (path) => all[norm(path)] ?? null,
    isFile: (path) => norm(path) in all,
    mtimeMs: (path) => (norm(path) in all ? 1 : null),
    list: (path) => {
      const prefix = `${norm(path)}/`
      const names = Object.keys(all)
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length).split("/")[0]!)
      return names.length ? [...new Set(names)] : null
    },
  }
}

const MAIN = "<MetaDataObject><Configuration><Properties><Name>ЗарплатаИУправлениеПерсоналом</Name></Properties></Configuration></MetaDataObject>"

describe("the profiles' configuration dumps", () => {
  const probe = disk({
    "C:/Bases/zup/1Cv8.1CD": "",
    "C:/Bases/zup_conf/Configuration.xml": MAIN,
    "C:/Bases/zup_conf/ConfigDumpInfo.xml": "<x/>",
    "C:/Bases/zup_conf/CommonModules/Модуль/Ext/Module.bsl": "",
  })

  test("the dump beside a file base is found, in the form a permission pattern takes", () => {
    const profiles = [
      { workingDirectory: "C:/tasks/stage8", kind: "file" as const, filePath: "C:\\Bases\\zup", configuration: { name: "ЗарплатаИУправлениеПерсоналом" } },
    ]
    expect(profileDumpDirectories(profiles, probe)).toEqual(["C:/Bases/zup_conf"])
  })

  test("a dump of another configuration is not this profile's", () => {
    const profiles = [{ workingDirectory: "C:/tasks/x", kind: "file" as const, filePath: "C:/Bases/zup", configuration: { name: "Другая" } }]
    expect(profileDumpDirectories(profiles, probe)).toEqual([])
  })

  test("a path inside a dump names the dump's root; outside, nothing", () => {
    expect(insideDump(join("C:/Bases/zup_conf", "CommonModules", "Модуль", "Ext", "Module.bsl"), probe)?.replace(/\\/g, "/")).toBe(
      "C:/Bases/zup_conf",
    )
    expect(insideDump("C:/tasks/stage8/notes.txt", probe)).toBeNull()
  })
})
