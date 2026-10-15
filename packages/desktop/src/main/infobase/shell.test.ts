import { describe, expect, test } from "bun:test"

import { commandFrom, ENCODING_PREAMBLE, shellRefusal, SHELL_ENV, withEncoding } from "./shell"

// 2026-09-23, debrief9.md §9.7. The failure this closes is not mojibake, it is a
// false belief: the agent inspected an intact 1.12 MB file through Write-Host,
// got "?" three different ways, and concluded the product destroys Cyrillic in
// large outputs -- then acted on it. The file had zero 0x3F bytes and 409 406
// Cyrillic UTF-8 lead bytes. A rule could not have helped; the rule was loaded
// and had already fired three times that hour.

describe("the encoding preamble", () => {
  test("is prepended to a Windows command", () => {
    expect(withEncoding("Write-Host $text", "win32")).toBe(ENCODING_PREAMBLE + "Write-Host $text")
  })

  test("is not added twice, however the setup got there", () => {
    const already = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Host $text"
    expect(withEncoding(already, "win32")).toBe(already)
    expect(withEncoding(withEncoding("Write-Host $t", "win32"), "win32")).toBe(
      ENCODING_PREAMBLE + "Write-Host $t",
    )
  })

  test("leaves other platforms alone", () => {
    expect(withEncoding("echo hi", "darwin")).toBe("echo hi")
    expect(withEncoding("echo hi", "linux")).toBe("echo hi")
  })

  test("leaves an empty command alone", () => {
    expect(withEncoding("", "win32")).toBe("")
    expect(withEncoding("   ", "win32")).toBe("   ")
  })

  // `[Text.Encoding]::UTF8` carries a BOM, and $OutputEncoding is what reaches
  // native executables -- so a BOM there lands in the first argument of every
  // curl or 1cv8 call.
  test("uses a BOM-free encoding for native process arguments", () => {
    expect(ENCODING_PREAMBLE).toContain("UTF8Encoding $false")
    expect(ENCODING_PREAMBLE).not.toContain("[Text.Encoding]::UTF8}")
  })

  // It throws when no console is attached, which is the sidecar's own case.
  test("survives a shell with no console", () => {
    expect(ENCODING_PREAMBLE).toContain("try{")
    expect(ENCODING_PREAMBLE).toContain("catch{}")
    // $OutputEncoding is assigned outside the try, so the useful half survives.
    expect(ENCODING_PREAMBLE.indexOf("$OutputEncoding=")).toBeLessThan(ENCODING_PREAMBLE.indexOf("try{"))
  })
})

describe("the shell environment", () => {
  // Python reaches the same corruption by another route: its default stdout
  // encoding on Windows is the ANSI codepage.
  test("makes Python speak UTF-8", () => {
    expect(SHELL_ENV.PYTHONIOENCODING).toBe("utf-8")
    expect(SHELL_ENV.PYTHONUTF8).toBe("1")
  })
})

// 2026-09-23, debrief9.md §9.9b. Measured: the 120 s bash timeout, and one
// garbled path for an answer.
describe("recursive content search", () => {
  test("is refused, naming grep and the path argument", () => {
    const refusal = shellRefusal(
      '$root = "C:\\dump\\cfg"; Get-ChildItem $root -Recurse -Filter *.bsl | Select-String -Pattern "Текст" -List',
    )
    expect(refusal).not.toBeNull()
    expect(refusal).toContain("grep")
    expect(refusal).toContain("path")
    expect(refusal).toContain("дольше лимита команды")
  })

  // Narrow on purpose: each half alone is ordinary work. The pipeline over a
  // 96 000-file tree is what cost the time.
  test("a recursive listing on its own is allowed", () => {
    expect(shellRefusal("Get-ChildItem C:\\dump -Recurse | Select-Object FullName")).toBeNull()
  })

  test("a Select-String on one file is allowed", () => {
    expect(shellRefusal('Select-String -Path "C:\\dump\\cfg\\Configuration.xml" -Pattern "Version"')).toBeNull()
  })

  test("ordinary commands are untouched", () => {
    expect(shellRefusal("Copy-Item a b -Force")).toBeNull()
    expect(shellRefusal("")).toBeNull()
  })
})

describe("which tool calls are inspected", () => {
  test("bash, by its command", () => {
    expect(commandFrom("bash", { command: "dir" })).toBe("dir")
  })

  test("and nothing else", () => {
    expect(commandFrom("read", { filePath: "a.txt" })).toBeUndefined()
    expect(commandFrom("1c_execute_code", { code: "Результат = 1;" })).toBeUndefined()
  })

  test("survives arguments that are not what we expect", () => {
    expect(commandFrom("bash", undefined)).toBeUndefined()
    expect(commandFrom("bash", null)).toBeUndefined()
    expect(commandFrom("bash", { command: "" })).toBeUndefined()
    expect(commandFrom("bash", { command: 42 })).toBeUndefined()
  })
})

// failures_to_tools.md G1. Every configurator operation the agent has run by
// hand now has a guarded tool; the shell route skips the toolkit handover.
describe("launching the platform from the shell", () => {
  const exe = String.raw`& "C:\Program Files\1cv8\8.5.1.1529\bin\1cv8.exe"`

  test("a configurator dump is refused and pointed at its tool", () => {
    const refusal = shellRefusal(String.raw`${exe} DESIGNER /F"C:\base" /DumpConfigToFiles "C:\work\cfg"`)
    expect(refusal).toContain("DESIGNER")
    expect(refusal).toContain("1c_dump_config_to_files")
  })

  test("each guarded switch names its own tool", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["/DumpCfg x.cf", "1c_dump_config"],
      ["/LoadCfg x.cf", "1c_load_config"],
      ["/UpdateDBCfg", "1c_update_db"],
      ["/CheckConfig", "1c_check_config"],
      ["/DumpExternalDataProcessorOrReportToFiles d x.epf", "1c_dump_epf_to_files"],
      ["/LoadExternalDataProcessorOrReportFromFiles d.xml x.epf", "1c_load_epf_from_files"],
    ]
    for (const [tail, tool] of cases) expect(shellRefusal(`1cv8 DESIGNER /F"b" ${tail}`)).toContain(tool)
  })

  test("an ENTERPRISE launch is refused too, toolkit first", () => {
    expect(shellRefusal(String.raw`1cv8c.exe ENTERPRISE /F"b" /Execute "C:\t\MCP_Toolkit.epf"`)).toContain("1c_toolkit_start")
    expect(shellRefusal(String.raw`1cv8.exe ENTERPRISE /F"b" /Execute "C:\t\x.epf"`)).toContain("1c_run_epf")
  })

  test("Start-Process with an argument list is the same launch", () => {
    expect(
      shellRefusal(`Start-Process -FilePath "1cv8.exe" -ArgumentList "DESIGNER","/F""b""","/DumpCfg","x.cf"`),
    ).toContain("1c_dump_config")
  })

  test("a switch with no guarded tool says to hand it to the user", () => {
    expect(shellRefusal(String.raw`1cv8.exe DESIGNER /F"b" /DumpIB "C:\x.dt"`)).toContain("пользователю")
  })

  test("mentioning the platform without launching it is fine", () => {
    expect(shellRefusal(String.raw`Get-ChildItem "C:\Program Files\1cv8"`)).toBeNull()
    expect(shellRefusal(`Get-Process 1cv8* | Select-Object Id, StartTime`)).toBeNull()
    expect(shellRefusal(String.raw`Select-String -Path C:\logs\1cv8.log -Pattern DESIGNERS`)).toBeNull()
  })
})

// 2026-09-25, both observed live in one session.
describe("what the refusal says about itself", () => {
  const dump = String.raw`& "C:\Program Files\1cv8\8.5.1.1529\bin\1cv8.exe" DESIGNER /F "C:\b" /DumpConfigToFiles "C:\out" -Extension EF_00_00927613_4`

  // The old first line was «Отклонено: запуск платформы 1С (DESIGNER) из
  // оболочки» -- passive, with "из оболочки" next to "Отклонено". The session
  // read it as a property of the environment and told the user «Оболочка
  // блокирует прямой запуск конфигуратора», which is false: the command never
  // ran, this hook refused the tool call.
  test("it names who refused, and that nothing ran", () => {
    const refusal = shellRefusal(dump)!
    expect(refusal).toContain("1CCoder")
    expect(refusal).toContain("команда не выполнялась")
  })

  // The redirect used to be wrong for an extension-scoped command: the agent had
  // `-Extension` in its own command, was pointed at a tool it believed could only
  // touch the main configuration, and dumped 97 000 files of that instead.
  test("an extension-scoped command is told how to keep the scope", () => {
    const refusal = shellRefusal(dump)!
    expect(refusal).toContain("1c_dump_config_to_files")
    expect(refusal).toContain("extension")
    expect(refusal).toContain("-Extension")
  })

  test("a command without extension scope says nothing about it", () => {
    const refusal = shellRefusal(String.raw`1cv8.exe DESIGNER /F"b" /DumpConfigToFiles "C:\out"`)!
    expect(refusal).toContain("1c_dump_config_to_files")
    expect(refusal).not.toContain("-Extension")
  })
})

// debrief15.md §15.5: `rg` in the shell on a machine without it.
describe("rg in a shell command", () => {
  const missing = () => false
  const present = () => true

  test("is refused, pointing at the grep tool, when rg isn't installed", () => {
    for (const command of [
      'rg -n "<TabularSection" "C:/dump/Documents/Док.xml"',
      '$x = 1; rg "Процедура" C:/dump',
      'Get-Content a.txt | rg "x"',
      '& rg.exe -l "x" .',
    ]) {
      expect(shellRefusal(command, missing)).toContain("инструмент `grep`")
    }
  })

  test("runs when rg is installed, and words that merely contain rg are not it", () => {
    expect(shellRefusal('rg -n "x" .', present)).toBeNull()
    expect(shellRefusal("Get-ChildItem -Filter *.org; echo cargo", missing)).toBeNull()
    expect(shellRefusal('Write-Host "rg is a search tool"', missing)).toBeNull()
  })
})
