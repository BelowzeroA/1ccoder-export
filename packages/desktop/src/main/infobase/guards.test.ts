import { describe, expect, test } from "bun:test"

import {
  insideDirectory,
  insideTemp,
  isAbsolutePath,
  outsideWorkingRefusal,
  shellTempRefusal,
  shellTempWrite,
  tempRefusal,
} from "./containment"
import { describeExistingDump, existingDump, type DumpProbe } from "./dumps"
import { checkPath, createdPaths } from "./operations"
import { provenanceRefusal } from "./provenance"

// failures_to_tools.md G3, G4, T6 -- the three guards that decide before a
// process starts, so each is pure and tested without disk or platform.

function fakeDump(files: Readonly<Record<string, string>>, dirs: Readonly<Record<string, readonly string[]>>): DumpProbe {
  return {
    readText: (path) => files[path] ?? null,
    isFile: (path) => path in files,
    mtimeMs: (path) => (path in files ? 1_000_000 : null),
    list: (path) => dirs[path] ?? null,
  }
}

const CONFIGURATION_XML = [
  "<MetaDataObject><Configuration><Properties>",
  "<Name>УправлениеТорговлей</Name><Version>11.5.7.390</Version>",
  "</Properties></Configuration></MetaDataObject>",
].join("")

describe("an existing configuration dump (G3)", () => {
  const complete = fakeDump(
    { "C:/w/cfg/Configuration.xml": CONFIGURATION_XML, "C:/w/cfg/ConfigDumpInfo.xml": "<x/>" },
    {
      "C:/w/cfg": ["Catalogs", "Documents", "Configuration.xml", "ConfigDumpInfo.xml"],
      "C:/w/cfg/Catalogs": ["Валюты.xml", "Валюты", "Номенклатура.xml", "Номенклатура"],
      "C:/w/cfg/Documents": ["ЗаказКлиента.xml", "ЗаказКлиента"],
    },
  )

  test("is recognised with its configuration and object counts", () => {
    const dump = existingDump("C:/w/cfg/", complete)
    expect(dump).toMatchObject({ root: "C:/w/cfg", name: "УправлениеТорговлей", version: "11.5.7.390" })
    expect(dump?.counts).toEqual({ Catalogs: 2, Documents: 1 })
  })

  test("is described as the answer, with the way to ask for a fresh one", () => {
    const text = describeExistingDump(existingDump("C:/w/cfg", complete)!, 1_000_000 + 5 * 60_000)
    expect(text).toContain("конфигуратор не запускался")
    expect(text).toContain("5 мин назад")
    expect(text).toContain("refresh: true")
  })

  test("an interrupted dump -- no ConfigDumpInfo.xml -- is not reused", () => {
    const partial = fakeDump({ "C:/w/cfg/Configuration.xml": CONFIGURATION_XML }, { "C:/w/cfg": ["Catalogs"] })
    expect(existingDump("C:/w/cfg", partial)).toBeNull()
  })

  test("an empty directory is not a dump", () => {
    expect(existingDump("C:/w/new", fakeDump({}, { "C:/w/new": [] }))).toBeNull()
  })
})

describe("the system temp directory (T6)", () => {
  const temps = [String.raw`c:\users\u\appdata\local\temp`]

  test("anything inside it is caught, whatever the slashes and case", () => {
    expect(insideTemp(String.raw`C:\Users\U\AppData\Local\Temp\opencode\cfg`, temps)).toBe(true)
    expect(insideTemp("C:/Users/U/AppData/Local/Temp/doc.txt", temps)).toBe(true)
    expect(insideTemp(String.raw`C:\Users\U\AppData\Local\Temp`, temps)).toBe(true)
  })

  test("a sibling that merely shares the prefix is not", () => {
    expect(insideTemp(String.raw`C:\Users\U\AppData\Local\Temporary\x`, temps)).toBe(false)
    expect(insideTemp(String.raw`C:\Work\Bases\tasks\cfg`, temps)).toBe(false)
  })

  test("the refusal points at the working directory", () => {
    expect(tempRefusal("C:/t/x")).toContain("рабочий каталог")
  })

  // debrief14.md §14.2/§14.4: every task5 run wrote its intermediate files into
  // temp from the shell. The commands below are shaped on the recorded ones.
  describe("from the shell", () => {
    const T = String.raw`C:\Users\u\AppData\Local\Temp`
    const writes: [string, string][] = [
      ["copy into temp", String.raw`Copy-Item "c:\w\task.docx" "${T}\opencode\sd.zip" -Force`],
      ["copy with -Destination", String.raw`Copy-Item -LiteralPath "c:\w\T.xml" -Destination "${T}\opencode\m.xml"`],
      ["unpack into temp", String.raw`Expand-Archive -LiteralPath "c:\w\t.docx" -DestinationPath "${T}\opencode\t"`],
      ["Out-File through $env:TEMP", String.raw`Get-ChildItem c:\conf -Name | Out-File -Encoding utf8 "$env:TEMP\opencode\cats.txt"`],
      ["redirect", String.raw`Get-Content c:\w\a.txt > %TEMP%\a.txt`],
      [".NET write", String.raw`[System.IO.File]::WriteAllLines("${T}\opencode\rows.txt", $out)`],
      ["zip entry extracted", String.raw`[System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, "${T}\opencode\d.xml", $true)`],
      ["through a variable", String.raw`$f = "${T}\opencode\m.xml"; $t = [IO.File]::ReadAllText($f); [IO.File]::WriteAllText($f, $t)`],
      ["a script saved there", String.raw`$p = Join-Path $env:TEMP 'x.py'; Set-Content -Path $p -Value $code`],
    ]
    for (const [name, command] of writes) {
      test(`a write is caught: ${name}`, () => {
        expect(shellTempWrite(command, temps)).not.toBeNull()
      })
    }

    const reads: [string, string][] = [
      ["reading a file there", String.raw`$xml = [IO.File]::ReadAllText("${T}\opencode\d.xml")`],
      ["read there, written in the working directory", String.raw`Get-Content "${T}\a.txt" | Out-File "c:\w\tasks\a.txt"`],
      ["copy out of temp", String.raw`Copy-Item "${T}\opencode\a.txt" "c:\w\tasks\a.txt"`],
      ["a sibling that shares the prefix", String.raw`"x" | Out-File "C:\Users\u\AppData\Local\Temporary\a.txt"`],
      ["a Template.xml in a dump", String.raw`Get-Content "c:\conf\Reports\R\Templates\T\Ext\Template.xml" | Out-File "c:\w\t.txt"`],
    ]
    for (const [name, command] of reads) {
      test(`not a write into temp: ${name}`, () => {
        expect(shellTempWrite(command, temps)).toBeNull()
      })
    }

    test("the refusal names the target and allows reading", () => {
      const text = shellTempRefusal("$env:TEMP\\a.txt")
      expect(text).toContain("$env:TEMP\\a.txt")
      expect(text).toContain("читать из временного каталога можно")
    })
  })
})

describe("results stay in the working directory", () => {
  const work = String.raw`C:\Work\Bases\x\tasks\stage4`

  test("a dump beside the base or beside an existing dump is outside", () => {
    expect(insideDirectory(String.raw`C:\Work\Bases\x\conf_ext\EXT`, work)).toBe(false)
    expect(insideDirectory(String.raw`C:\Work\Bases\x\ext.cf`, work)).toBe(false)
    expect(insideDirectory(String.raw`C:\Work\Bases\x\tasks\stage40\a`, work)).toBe(false)
  })

  test("the directory itself and anything below it is inside, whatever the slashes and case", () => {
    expect(insideDirectory("c:/work/bases/x/tasks/stage4/ext/", work)).toBe(true)
    expect(insideDirectory(work, work)).toBe(true)
  })

  test("only what an operation creates is checked, not what it reads", () => {
    expect(createdPaths("dump_config_to_files", { path: " C:/a/dir " })).toEqual(["C:/a/dir"])
    expect(createdPaths("dump_config", { path: "C:/a/x.cf" })).toEqual(["C:/a/x.cf"])
    expect(createdPaths("load_config", { path: "C:/a/x.cfe" })).toEqual([])
    expect(createdPaths("execute", { path: "C:/a/x.epf" })).toEqual([])
    expect(createdPaths("dump_epf_to_files", { path: "C:/w/src", epfPath: "C:/user/in.epf" })).toEqual(["C:/w/src"])
    expect(createdPaths("load_epf_from_files", { path: "C:/w/src.xml", epfPath: "C:/w/out.epf" })).toEqual([
      "C:/w/out.epf",
    ])
  })

  test("an extension may be dumped to a .cfe, as it may be loaded from one", () => {
    const probe = { isFile: () => false, isDirectory: (path: string) => path === "C:/w" }
    expect(checkPath("dump_config", "C:/w/ext.cfe", probe)).toBeNull()
    expect(checkPath("dump_config", "C:/w/ext.txt", probe)).toContain(".cfe")
  })

  test("a relative path is left to resolution, not refused", () => {
    expect(isAbsolutePath(String.raw`ext\dump`)).toBe(false)
    expect(isAbsolutePath("C:/x")).toBe(true)
  })

  test("the refusal says nothing ran and offers the path inside", () => {
    const text = outsideWorkingRefusal(String.raw`C:\Work\Bases\x\conf_ext\EXT`, work)
    expect(text).toContain("Операция не выполнялась")
    expect(text).toContain(String.raw`C:\Work\Bases\x\tasks\stage4\EXT`)
  })
})

describe("which processing the launcher starts without question (G4)", () => {
  const started = 10_000_000

  test("a file written during the session goes to the permission prompt", () => {
    expect(provenanceRefusal("x.epf", { modifiedMs: started + 60_000, sessionStartedMs: started, userSupplied: false })).toBeNull()
  })

  test("a file untouched since long before is refused, and the refusal names both real causes", () => {
    const refusal = provenanceRefusal("x.epf", { modifiedMs: started - 3_600_000, sessionStartedMs: started, userSupplied: false })
    expect(refusal).toContain("1c_execute_query")
    expect(refusal).toContain("user_supplied")
  })

  test("the user's own file passes once declared", () => {
    expect(provenanceRefusal("x.epf", { modifiedMs: started - 3_600_000, sessionStartedMs: started, userSupplied: true })).toBeNull()
  })

  test("an unreadable timestamp is not taken as recent", () => {
    expect(provenanceRefusal("x.epf", { modifiedMs: null, sessionStartedMs: started, userSupplied: false })).not.toBeNull()
  })
})
