import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { tool } from "@opencode-ai/plugin"

import { journalPath } from "./journal"
import { InfobasePlugin } from "./plugin"

// debrief13.md: helper tests can pass while the tool call never reaches the
// check (debrief12.md §12.3). These go through the real plugin and a fake
// relay, and assert on what the relay was asked to run.

// Not under the system temp: the temp guard (T6) would refuse every dump there.
const CACHE = join(import.meta.dir, "..", "..", "..", "node_modules", ".cache")
mkdirSync(CACHE, { recursive: true })
// ROOT holds the infobase, a user's dump beside it, and the working directory.
const ROOT = mkdtempSync(join(CACHE, "1ccoder-wd-"))
const WORK = join(ROOT, "tasks")
const INFOBASE = join(ROOT, "base")
mkdirSync(WORK, { recursive: true })
mkdirSync(INFOBASE, { recursive: true })
const execs: Record<string, unknown>[] = []
// What the relay's toolkit gate reports; tests switch it to "free" for a toolkit that is not running.
let toolkitPort: "up" | "free" = "up"
// The configuration the profile records; a dump of another one is not this base's.
let profileConfiguration = "Конфигурация"
// The profile's standing permission to write without an ask.
let allowWrite = false
// Every permission the plugin asked for.
const asks: unknown[] = []
// Plays the configurator for a listed dump (`objects`): writes what it would.
let listedDump: ((body: Record<string, unknown>) => void) | undefined
const relay = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/1c/profile") {
      return Response.json({
        ok: true,
        name: "X",
        workingDirectory: WORK,
        infobase: INFOBASE,
        configuration: { name: profileConfiguration, version: "1.0", source: "dump" },
        ...(allowWrite ? { allowWriteWithoutConfirmation: true } : {}),
      })
    }
    if (path === "/1c/toolkit/start") return Response.json({ ok: true, state: "running", port: 6003 })
    if (path === "/1c/toolkit/gate") return Response.json({ designerBusy: false, port: toolkitPort, state: "running" })
    if (path === "/1c/close-dialog") {
      const body = (await request.json()) as Record<string, unknown>
      execs.push({ operation: "close-dialog", ...body })
      return body.button === "Закрыть"
        ? Response.json({ ok: true, text: "Нажата кнопка «Закрыть»… сеанс свободен." })
        : Response.json({ ok: false, reason: "no-button", detail: "Кнопки: Закрыть, Подключить" })
    }
    if (path === "/1c/check-dcs") {
      const body = (await request.json()) as Record<string, unknown>
      execs.push({ operation: "check-dcs", ...body })
      return Response.json({ ok: true, passed: true, text: "Схема прошла проверку в базе" })
    }
    if (path === "/1c/run-report") {
      const body = (await request.json()) as Record<string, unknown>
      execs.push({ operation: "run-report", ...body })
      return Response.json({ ok: true, passed: true, text: `Отчёт сформирован: ${String(body.outBase)}.pdf` })
    }
    if (path === "/1c/exec") {
      const body = (await request.json()) as Record<string, unknown>
      execs.push(body)
      if (Array.isArray(body.objects)) listedDump?.(body)
      // An extension named FAIL stands for a load the platform rejected. The
      // real relay answers that `ok: true` with the configurator's exit code 1
      // (debrief14.md §14.5) -- `ok` only says the configurator ran.
      if (body.extension === "FAIL") {
        return Response.json({ ok: true, exitCode: 1, output: "Неверное значение перечисления - AutoDeleteOn" })
      }
      // XDTO: the platform's read failure, naming only the file (as observed).
      if (body.extension === "XDTO") {
        return Response.json({
          ok: true,
          exitCode: 1,
          // Not String.raw: Bun turns non-ASCII inside it into \u escapes.
          output: "Исключение XDTO произошло при чтении файла- C:\\w\\Reports\\Отчет\\Templates\\Схема\\Ext\\Template.xml.",
        })
      }
      // PARTIAL: the configurator skipped parts and still exited 0, printing
      // each message three times (debrief14.md §14.5, the lines as observed).
      if (body.extension === "PARTIAL") {
        const skipped = [
          "Файл - Подсистема.xml: ошибка формата документа - объект метаданных Command не был загружен поскольку не является подчиненным для объекта Subsystem.",
          "Неверное свойство объекта метаданных. Свойство Placement не входит в состав объекта метаданных CommonCommand. - Placement",
        ]
        return Response.json({ ok: true, exitCode: 0, output: [...skipped, ...skipped, ...skipped].join("\n") })
      }
      return Response.json({ ok: true, exitCode: 0, output: "ok" })
    }
    return new Response("", { status: 404 })
  },
})
afterAll(() => {
  relay.stop(true)
  rmSync(ROOT, { recursive: true, force: true })
})

/** One plugin instance, so what it remembers within a session carries across calls. */
async function session() {
  execs.length = 0
  // oxlint-disable-next-line typescript/no-explicit-any -- the plugin input is unused by these code paths
  const hooks = await InfobasePlugin({} as any, { baseUrl: `http://localhost:${relay.port}` })
  // oxlint-disable-next-line typescript/no-explicit-any -- only sessionID and ask are read on these paths
  const ctx = { sessionID: "ses_test", ask: async (request: unknown) => void asks.push(request) } as any
  return async (name: string, args: Record<string, unknown>) => {
    const tool = hooks.tool?.[name]
    // A tool the plugin does not define (the toolkit's) only passes the before hook.
    if (!tool) {
      await hooks["tool.execute.before"]?.({ tool: name, sessionID: "ses_test", callID: "c" }, { args })
      return ""
    }
    const result = await tool.execute(args, ctx)
    return typeof result === "string" ? result : result.output
  }
}

// debrief13.md §13.11: update_db takes no path, and `extension` was declared
// only inside the path branch -- so the schema the model sees had no properties
// and every `extension` was stripped before execute(). Calling execute()
// directly, as the tests above do, cannot see that; parsing the declared
// schema the way the SDK does can.
describe("the schema the model sees", () => {
  for (const name of [
    "1c_update_db",
    "1c_load_config",
    "1c_load_config_from_files",
    "1c_delete_extension",
    "1c_dump_config",
    "1c_dump_config_to_files",
  ]) {
    test(`${name} keeps extension and extension_name through validation`, async () => {
      // oxlint-disable-next-line typescript/no-explicit-any -- the plugin input is unused here
      const hooks = await InfobasePlugin({} as any, { baseUrl: `http://localhost:${relay.port}` })
      const schema = tool.schema.object(hooks.tool![name]!.args)
      expect(schema.parse({ path: "C:/x", extension: "EXT" }).extension).toBe("EXT")
      expect(schema.parse({ path: "C:/x", extension_name: "EXT" }).extension_name).toBe("EXT")
    })
  }
})

// debrief15.md §15.24 item 31: run 4 registered a print it had called matching
// while three fields were wrong. Registration now waits for a comparison.
describe("registering a print form waits for a comparison with the sample", () => {
  const REGISTER = "Э = Справочники.ДополнительныеОтчетыИОбработки.СоздатьЭлемент();\nЭ.Записать();"
  const files = () => {
    const sample = join(WORK, "sample.jpg")
    const epf = join(WORK, "form.epf")
    const pdf = join(WORK, "print.pdf")
    writeFileSync(sample, "img")
    writeFileSync(epf, "epf")
    writeFileSync(pdf, "pdf")
    // The print is of this build: not older than it.
    utimesSync(epf, new Date(1_000_000), new Date(1_000_000))
    utimesSync(pdf, new Date(2_000_000), new Date(2_000_000))
    return { sample, epf, pdf }
  }
  const row = (field: string) => ({ field, sample: field, print: field, match: true })
  const fields = [row("шапка"), row("номер"), row("дата"), row("ФИО"), { field: "дата ознакомления", sample: "от руки", print: "пусто", match: true }]

  test("refused with the profile's permission and in 1c_write_code; accepted after the comparison; a rebuild resets it", async () => {
    allowWrite = true
    try {
      const call = await session()
      const { sample, epf, pdf } = files()
      await expect(call("1c_execute_code", { code: REGISTER })).rejects.toThrow("после сверки печати с образцом")
      expect(await call("1c_write_code", { code: REGISTER, summary: "р", objects: "Справочник.ДОО", count: 1, organisations: "все" })).toContain(
        "1c_compare_with_sample",
      )

      const args = { sample, print: pdf, epf, fields }
      // oxlint-disable-next-line typescript/no-explicit-any -- the plugin input is unused here
      const hooks = await InfobasePlugin({} as any, { baseUrl: `http://localhost:${relay.port}` })
      expect(tool.schema.object(hooks.tool!["1c_compare_with_sample"]!.args).parse(args)).toEqual(args)
      expect(await call("1c_compare_with_sample", args)).toContain("| дата ознакомления | от руки | пусто | да |")
      expect(await call("1c_execute_code", { code: REGISTER })).toBe("")

      utimesSync(epf, new Date(3_000_000), new Date(3_000_000))
      await expect(call("1c_execute_code", { code: REGISTER })).rejects.toThrow("пересобрали после сверки")
    } finally {
      allowWrite = false
    }
  })

  test("a comparison that calls a printed pen-written date a match is refused, and registration stays held", async () => {
    allowWrite = true
    try {
      const call = await session()
      const { sample, epf, pdf } = files()
      const wrong = fields.map((item) => (item.field === "дата ознакомления" ? { ...item, print: "03 февраля 2025 г." } : item))
      expect(await call("1c_compare_with_sample", { sample, print: pdf, epf, fields: wrong })).toContain("в образце вписано от руки")
      await expect(call("1c_execute_code", { code: REGISTER })).rejects.toThrow("после сверки печати с образцом")
    } finally {
      allowWrite = false
    }
  })
})

// debrief15.md §15.24 item 34: a document's attributes, read from the dump without the toolkit.
test("1c_dump_object reads an object from the given dump, through the declared schema", async () => {
  const call = await session()
  const dump = join(WORK, "conf")
  mkdirSync(join(dump, "Documents"), { recursive: true })
  writeFileSync(
    join(dump, "Documents", "Прием.xml"),
    [
      "<MetaDataObject>",
      '\t<Document uuid="d">',
      "\t\t<Properties>",
      "\t\t\t<Name>Прием</Name>",
      "\t\t</Properties>",
      "\t\t<ChildObjects>",
      '\t\t\t<Attribute uuid="a">',
      "\t\t\t\t<Properties>",
      "\t\t\t\t\t<Name>Сотрудник</Name>",
      "\t\t\t\t\t<Type>",
      "\t\t\t\t\t\t<v8:Type>cfg:CatalogRef.Сотрудники</v8:Type>",
      "\t\t\t\t\t</Type>",
      "\t\t\t\t</Properties>",
      "\t\t\t</Attribute>",
      "\t\t</ChildObjects>",
      "\t</Document>",
      "</MetaDataObject>",
    ].join("\r\n"),
  )
  const args = { object: "Документ.Прием", dump }
  // oxlint-disable-next-line typescript/no-explicit-any -- the plugin input is unused here
  const hooks = await InfobasePlugin({} as any, { baseUrl: `http://localhost:${relay.port}` })
  expect(tool.schema.object(hooks.tool!["1c_dump_object"]!.args).parse(args)).toEqual(args)
  expect(await call("1c_dump_object", args)).toContain("Реквизиты (1):\n- Сотрудник: CatalogRef.Сотрудники")
})

// debrief15.md §15.20: the toolkit's session may end after a few minutes; the call it was started for goes first.
test("1c_toolkit_start says the window may be short and the needed call goes first", async () => {
  const call = await session()
  const text = await call("1c_toolkit_start", {})
  expect(text).toContain("Окно работы тулкита может оказаться коротким")
  expect(text).toContain("первым вызовом сделай то, ради чего тулкит поднят")
})

describe("a configurator operation right after the toolkit was started", () => {
  test("is refused, and no process is started", async () => {
    const call = await session()
    await call("1c_toolkit_start", {})
    const text = await call("1c_check_config", {})
    expect(text).toContain("ещё не использован")
    // debrief14.md §14.5: while the tools reconnect, waiting is the move, not another configurator call.
    expect(text).toContain("Start-Sleep -Seconds 15")
    expect(execs).toHaveLength(0)
  })

  // debrief14.md §14.5: a repeat was a reflex, and fed a half-hour loop.
  test("a repeat is refused too while the toolkit is up and unused", async () => {
    const call = await session()
    await call("1c_toolkit_start", {})
    await call("1c_check_config", {})
    expect(await call("1c_check_config", {})).toContain("Повтор не поможет")
    expect(execs).toHaveLength(0)
  })

  // debrief15.md §15.18: the refusal only bought a throwaway call before each build.
  test("an external processing's build or dump is not held back", async () => {
    const call = await session()
    await call("1c_toolkit_start", {})
    const source = join(WORK, "epf_src")
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, "Обработка.xml"), "<MetaDataObject/>")
    // The loader updates an existing container, so one has to be there.
    writeFileSync(join(WORK, "Обработка.epf"), Buffer.alloc(4096, 1))
    const built = await call("1c_load_epf_from_files", { path: join(source, "Обработка.xml"), epfPath: join(WORK, "Обработка.epf") })
    expect(built).not.toContain("ещё не использован")
    expect(execs.at(-1)).toMatchObject({ operation: "load_epf_from_files" })
    // A configuration operation still is.
    await call("1c_toolkit_start", {})
    expect(await call("1c_check_config", {})).toContain("ещё не использован")
  })

  test("a toolkit that is not listening holds nothing back -- no dead end", async () => {
    const call = await session()
    await call("1c_toolkit_start", {})
    toolkitPort = "free"
    try {
      await call("1c_check_config", {})
    } finally {
      toolkitPort = "up"
    }
    expect(execs).toHaveLength(1)
  })

  test("once a toolkit tool was used, it runs at once", async () => {
    const call = await session()
    await call("1c_toolkit_start", {})
    await call("1c_execute_code", { code: "Результат = 1;" })
    await call("1c_check_config", {})
    expect(execs).toHaveLength(1)
  })

  test("without a toolkit start in the session, nothing changes", async () => {
    const call = await session()
    await call("1c_check_config", {})
    expect(execs).toHaveLength(1)
  })
})

describe("a dump outside the working directory, through the tool call", () => {
  test("is refused and no process is started", async () => {
    const call = await session()
    const text = await call("1c_dump_config_to_files", { path: String.raw`C:\Work\Bases\x\conf_ext\EXT`, extension: "EXT" })
    expect(text).toContain("вне рабочего каталога")
    expect(execs).toHaveLength(0)
  })

  test("inside it, the operation runs", async () => {
    const call = await session()
    await call("1c_dump_config_to_files", { path: join(WORK, "ext"), extension: "EXT" })
    expect(execs).toHaveLength(1)
  })
})

describe("an extension load and its update, through the tool calls", () => {
  // load_config reads its file, so it has to exist; it is never parsed here.
  const cfe = join(WORK, "ext.cfe")
  writeFileSync(cfe, "x")

  test("the load names the update that applies it, with the same extension", async () => {
    const call = await session()
    const text = await call("1c_load_config", { path: cfe, extension: "EXT" })
    expect(text).toContain('1c_update_db с extension: "EXT"')
  })

  test("an update without the extension says the loaded one is still not applied", async () => {
    const call = await session()
    await call("1c_load_config", { path: cfe, extension: "EXT" })
    const text = await call("1c_update_db", {})
    expect(text).toContain("не применены: EXT")
  })

  test("the toolkit's spelling, extension_name, is honoured the same way", async () => {
    const call = await session()
    await call("1c_load_config", { path: cfe, extension: "EXT" })
    const text = await call("1c_update_db", { extension_name: "EXT" })
    expect(execs.at(-1)?.extension).toBe("EXT")
    expect(text).not.toContain("не применены")
  })

  test("a repeated update without the extension does not start the configurator", async () => {
    const call = await session()
    await call("1c_load_config", { path: cfe, extension: "EXT" })
    await call("1c_update_db", {})
    const repeat = await call("1c_update_db", {})
    expect(execs).toHaveLength(2)
    expect(repeat).toContain("конфигуратор не запускался")
    expect(repeat).toContain('1c_update_db({"extension": "EXT"})')
    await call("1c_update_db", { extension: "EXT" })
    expect(execs).toHaveLength(3)
  })

  test("once the extension is updated, a later main update says nothing about it", async () => {
    const call = await session()
    await call("1c_load_config", { path: cfe, extension: "EXT" })
    await call("1c_update_db", { extension: "EXT" })
    expect(execs.at(-1)?.extension).toBe("EXT")
    expect(await call("1c_update_db", {})).not.toContain("не применены")
  })
})

describe("a v8pack command in the shell, through the before hook", () => {
  async function before(command: string) {
    // oxlint-disable-next-line typescript/no-explicit-any -- the plugin input is unused by this code path
    const hooks = await InfobasePlugin({} as any, { baseUrl: `http://localhost:${relay.port}` })
    const hook = hooks["tool.execute.before"]
    if (!hook) throw new Error("tool.execute.before is not registered")
    const output = { args: { command } }
    // oxlint-disable-next-line typescript/no-explicit-any -- only tool and sessionID are read
    await hook({ tool: "bash", sessionID: "ses_test", callID: "c1" } as any, output)
    return output.args.command
  }
  const v8pack = String.raw`& "C:\Users\u\.config\opencode\1ccoder-skills\v8pack.cmd"`

  test("packing beside the infobase is refused", async () => {
    const command = String.raw`${v8pack} pack "C:\Work\Bases\x\tasks\stage4\ext_cf" "C:\Work\Bases\x\ext_fixed.cf"`
    await expect(before(command)).rejects.toThrow("вне рабочего каталога")
  })

  test("unpacking a user's file into the working directory is allowed", async () => {
    const command = `${v8pack} unpack "C:\\Work\\Bases\\x\\ext.cf" "${join(WORK, "ext_cf")}"`
    expect(await before(command)).toContain("unpack")
  })
})

describe("refreshing an existing extension dump", () => {
  test("dumps it whole: -update would miss a module edited byte-wise", async () => {
    const dump = join(WORK, "ext_dump")
    mkdirSync(dump, { recursive: true })
    writeFileSync(
      join(dump, "Configuration.xml"),
      "<MetaDataObject><Configuration><Properties><Name>EXT</Name></Properties></Configuration></MetaDataObject>",
    )
    writeFileSync(join(dump, "ConfigDumpInfo.xml"), "<x/>")
    const call = await session()
    await call("1c_dump_config_to_files", { path: dump, extension: "EXT", refresh: true })
    expect(execs).toHaveLength(1)
    expect(execs[0]?.update).toBeUndefined()
  })
})

describe("a full dump when the same configuration is already dumped beside the base", () => {
  function dumpAt(dir: string, xml: string) {
    mkdirSync(join(dir, "CommonModules"), { recursive: true })
    writeFileSync(join(dir, "CommonModules", "Модуль.xml"), "<x/>")
    writeFileSync(join(dir, "Configuration.xml"), xml)
    writeFileSync(join(dir, "ConfigDumpInfo.xml"), "<x/>")
  }
  const main = "<MetaDataObject><Configuration><Properties><Name>Конфигурация</Name><Version>1.0</Version></Properties></Configuration></MetaDataObject>"
  const extension =
    "<MetaDataObject><Configuration><Properties><ConfigurationExtensionPurpose>Patch</ConfigurationExtensionPurpose>" +
    "<Name>Конфигурация</Name></Properties></Configuration></MetaDataObject>"
  dumpAt(join(ROOT, "base_conf"), main)
  dumpAt(join(ROOT, "base_ext"), extension)

  test("returns that dump instead, even with a reflexive refresh", async () => {
    const call = await session()
    const text = await call("1c_dump_config_to_files", { path: join(WORK, "conf_src"), refresh: true })
    expect(execs).toHaveLength(0)
    expect(text).toContain("конфигуратор не запускался")
    expect(text).toContain("base_conf")
    expect(text).not.toContain("base_ext")
  })

  test("once shown, refresh is taken as meant and the dump runs", async () => {
    const call = await session()
    await call("1c_dump_config_to_files", { path: join(WORK, "conf_src"), refresh: true })
    await call("1c_dump_config_to_files", { path: join(WORK, "conf_src"), refresh: true })
    expect(execs).toHaveLength(1)
  })
})

// debrief14.md §14.3: building an extension from XML.
describe("an extension from XML files, through the tool calls", () => {
  const MAIN = [
    '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" version="2.21"><Configuration><Properties>',
    "<Name>Конфигурация</Name><ScriptVariant>Russian</ScriptVariant><DefaultLanguage>Language.Русский</DefaultLanguage>",
    "<InterfaceCompatibilityMode>TaxiEnableVersion8_2</InterfaceCompatibilityMode><CompatibilityMode>Version8_3_27</CompatibilityMode>",
    "</Properties></Configuration></MetaDataObject>",
  ].join("")
  const baseDump = join(ROOT, "base_dump")
  mkdirSync(join(baseDump, "Languages"), { recursive: true })
  writeFileSync(join(baseDump, "Configuration.xml"), MAIN)
  writeFileSync(
    join(baseDump, "Languages", "Русский.xml"),
    '<MetaDataObject><Language uuid="0663bf5b-bcba-4a40-a862-a0b3baa2d884"><Properties><Name>Русский</Name><LanguageCode>ru</LanguageCode></Properties></Language></MetaDataObject>',
  )

  test("1c_new_extension writes the skeleton into the working directory, agreed with the base", async () => {
    const call = await session()
    const text = await call("1c_new_extension", { path: "ext_src", name: "ПланыПродаж", prefix: "пп_", base_dump: baseDump })
    expect(text).toContain("Заготовка создана")
    const configuration = readFileSync(join(WORK, "ext_src", "Configuration.xml"), "utf8")
    expect(configuration).toContain("<NamePrefix>пп_</NamePrefix>")
    expect(readFileSync(join(WORK, "ext_src", "Languages", "Русский.xml"), "utf8")).toContain("0663bf5b")
    expect(execs).toHaveLength(0)
  })

  // debrief14.md §14.7: with no dump anywhere, the tool used to stop and ask for
  // a full one -- many minutes of configurator for three facts.
  test("with no dump, it dumps the root and the default language selectively, and reuses them", async () => {
    const call = await session()
    listedDump = (body) => {
      const dir = String(body.path)
      const objects = body.objects as string[]
      if (objects.includes("Configuration")) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "Configuration.xml"), MAIN)
      }
      if (objects.includes("Language.Русский")) {
        mkdirSync(join(dir, "Languages"), { recursive: true })
        writeFileSync(join(dir, "Languages", "Русский.xml"), readFileSync(join(baseDump, "Languages", "Русский.xml"), "utf8"))
      }
    }
    // No dump of this configuration anywhere near.
    profileConfiguration = "ДругаяКонфигурация"
    try {
      const text = await call("1c_new_extension", { path: "sel_src", name: "Выборочное", prefix: "в_" })
      expect(execs.map((exec) => exec.objects)).toEqual([["Configuration"], ["Language.Русский"]])
      expect(execs.every((exec) => exec.operation === "dump_config_to_files" && exec.path === join(WORK, "base_facts"))).toBe(true)
      expect(text).toContain("выгружены выборочно")
      expect(readFileSync(join(WORK, "sel_src", "Languages", "Русский.xml"), "utf8")).toContain("0663bf5b")

      execs.length = 0
      await call("1c_new_extension", { path: "sel_src2", name: "Второе", prefix: "вт_" })
      expect(execs).toHaveLength(0)
    } finally {
      listedDump = undefined
      profileConfiguration = "Конфигурация"
    }
  })

  test("it neither writes outside the working directory nor over existing work", async () => {
    const call = await session()
    expect(await call("1c_new_extension", { path: join(ROOT, "elsewhere"), name: "А", prefix: "а_", base_dump: baseDump })).toContain(
      "вне рабочего каталога",
    )
    expect(await call("1c_new_extension", { path: "ext_src", name: "А", prefix: "а_", base_dump: baseDump })).toContain("уже есть Configuration.xml")
  })

  test("loading needs the extension's name, and starts nothing without it", async () => {
    const call = await session()
    const text = await call("1c_load_config_from_files", { path: join(WORK, "ext_src") })
    expect(text).toContain("только для расширения")
    expect(execs).toHaveLength(0)
  })

  test("a folder without Configuration.xml is refused before any launch", async () => {
    const call = await session()
    mkdirSync(join(WORK, "empty_src"), { recursive: true })
    expect(await call("1c_load_config_from_files", { path: join(WORK, "empty_src"), extension: "Х" })).toContain("нет Configuration.xml")
    expect(execs).toHaveLength(0)
  })

  test("a successful load runs /LoadConfigFromFiles and names the update that applies it", async () => {
    const call = await session()
    const text = await call("1c_load_config_from_files", { path: join(WORK, "ext_src"), extension: "ПланыПродаж" })
    expect(execs.at(-1)).toMatchObject({ operation: "load_config_from_files", extension: "ПланыПродаж" })
    expect(text).toContain('1c_update_db с extension: "ПланыПродаж"')
  })

  test("a failed load says an empty extension may now exist, and how to remove it", async () => {
    const call = await session()
    const text = await call("1c_load_config_from_files", { path: join(WORK, "ext_src"), extension: "FAIL" })
    expect(text).toContain("могло уже появиться в базе — пустым")
    expect(text).not.toContain("загружено, но база")
    expect(text).toContain('1c_delete_extension с extension: "FAIL"')
  })

  // debrief14.md §14.5: «успешно» three times while parts were skipped.
  test("a load that skipped parts says so first, and lists each skipped part once", async () => {
    const call = await session()
    const text = await call("1c_load_config_from_files", { path: join(WORK, "ext_src"), extension: "PARTIAL" })
    expect(text.startsWith("Загрузка прошла ЧАСТИЧНО")).toBe(true)
    // The note lists each once; the configurator's own output follows it as is.
    const note = text.slice(0, text.indexOf("Исправь файлы и загрузи снова."))
    expect(note.split("не был загружен")).toHaveLength(2)
    expect(note.split("Свойство Placement")).toHaveLength(2)
  })

  test("a clean load says nothing about skipped parts", async () => {
    const call = await session()
    expect(await call("1c_load_config_from_files", { path: join(WORK, "ext_src"), extension: "ПланыПродаж" })).not.toContain(
      "ЧАСТИЧНО",
    )
  })

  // debrief14.md §14.5: a result field with a misspelt tag vanished without a message.
  function formSource(dir: string, tag: string) {
    const ext = join(WORK, dir, "Reports", "Отчет", "Forms", "ФормаОтчета", "Ext")
    mkdirSync(ext, { recursive: true })
    writeFileSync(join(WORK, dir, "Configuration.xml"), "<MetaDataObject/>")
    writeFileSync(
      join(ext, "Form.xml"),
      `<Form xmlns="http://v8.1c.ru/8.3/xcf/logform"><ChildItems><InputField name="Период" id="1"/>` +
        `<${tag} name="Результат" id="2"><ContextMenu name="РезультатКонтекстноеМеню" id="3"/></${tag}>` +
        `</ChildItems></Form>`,
    )
  }

  test("a misspelt form element tag refuses the load before anything runs, naming the right tag", async () => {
    const call = await session()
    formSource("typo_src", "SpreadsheetDocumentField")
    const text = await call("1c_load_config_from_files", { path: join(WORK, "typo_src"), extension: "Х" })
    expect(text).toContain("Загрузка не запущена")
    expect(text).toContain(
      'Reports/Отчет/Forms/ФормаОтчета/Ext/Form.xml: <SpreadsheetDocumentField name="Результат"> — правильно SpreadSheetDocumentField',
    )
    expect(execs).toHaveLength(0)
  })

  test("an unknown tag that is no near miss loads, with a warning", async () => {
    const call = await session()
    formSource("odd_src", "HologramField")
    const text = await call("1c_load_config_from_files", { path: join(WORK, "odd_src"), extension: "Х" })
    expect(execs).toHaveLength(1)
    expect(text).toContain('<HologramField name="Результат">')
  })

  test("the correct tag passes without a word", async () => {
    const call = await session()
    formSource("good_src", "SpreadSheetDocumentField")
    const text = await call("1c_load_config_from_files", { path: join(WORK, "good_src"), extension: "Х" })
    expect(execs).toHaveLength(1)
    expect(text).not.toContain("SpreadSheetDocumentField")
  })

  // debrief14.md §14.5: three commands showed in their section and did nothing.
  function commandSource(dir: string, module: string) {
    const ext = join(WORK, dir, "CommonCommands", "ОткрытьПланы", "Ext")
    mkdirSync(ext, { recursive: true })
    writeFileSync(join(WORK, dir, "Configuration.xml"), "<MetaDataObject/>")
    writeFileSync(join(ext, "CommandModule.bsl"), module)
  }
  const handler = (name: string) => `&НаКлиенте\nПроцедура ${name}(ПараметрКоманды, ПараметрыВыполненияКоманды)\nКонецПроцедуры`

  test("a command module without the handler refuses the load before anything runs", async () => {
    const call = await session()
    commandSource("cmd_wrong_src", handler("ОбработчикКоманды"))
    const text = await call("1c_load_config_from_files", { path: join(WORK, "cmd_wrong_src"), extension: "Х" })
    expect(text).toContain("CommonCommands/ОткрытьПланы/Ext/CommandModule.bsl")
    expect(text).toContain("Процедура ОбработкаКоманды(ПараметрКоманды, ПараметрыВыполненияКоманды)")
    expect(execs).toHaveLength(0)
  })

  test("the standard handler loads without a word; an unusual one loads with a warning", async () => {
    const call = await session()
    commandSource("cmd_good_src", handler("ОбработкаКоманды"))
    expect(await call("1c_load_config_from_files", { path: join(WORK, "cmd_good_src"), extension: "Х" })).not.toContain("CommandModule")
    commandSource("cmd_odd_src", handler("ОбработкаКоманды").replace("&НаКлиенте\n", ""))
    const text = await call("1c_load_config_from_files", { path: join(WORK, "cmd_odd_src"), extension: "Х" })
    expect(execs).toHaveLength(2)
    expect(text).toContain("CommonCommands/ОткрытьПланы/Ext/CommandModule.bsl: без директивы")
  })

  // debrief14.md §14.5: the XDTO error named the file only, and bisecting it cost several loads.
  test("an undeclared namespace prefix refuses the load before anything runs, naming file and prefix", async () => {
    const call = await session()
    const ext = join(WORK, "prefix_src", "Reports", "Отчет", "Templates", "Схема", "Ext")
    mkdirSync(ext, { recursive: true })
    writeFileSync(join(WORK, "prefix_src", "Configuration.xml"), "<MetaDataObject/>")
    writeFileSync(
      join(ext, "Template.xml"),
      '<DataCompositionSchema xmlns="s" xmlns:v8="c"><parameter><valueType><v8:Type>cfg:EnumRef.Виды</v8:Type></valueType></parameter></DataCompositionSchema>',
    )
    const text = await call("1c_load_config_from_files", { path: join(WORK, "prefix_src"), extension: "Х" })
    expect(text).toContain("Reports/Отчет/Templates/Схема/Ext/Template.xml: `cfg:`")
    expect(execs).toHaveLength(0)
  })

  test("an XDTO failure on a schema points to 1c_check_dcs", async () => {
    const call = await session()
    mkdirSync(join(WORK, "xdto_src"), { recursive: true })
    writeFileSync(join(WORK, "xdto_src", "Configuration.xml"), "<MetaDataObject/>")
    const text = await call("1c_load_config_from_files", { path: join(WORK, "xdto_src"), extension: "XDTO" })
    expect(text).toContain('1c_check_dcs с path: "C:\\w\\Reports\\Отчет\\Templates\\Схема\\Ext\\Template.xml"')
  })

  test("deleting clears it from the extensions still waiting for an update", async () => {
    const call = await session()
    await call("1c_load_config_from_files", { path: join(WORK, "ext_src"), extension: "ПланыПродаж" })
    await call("1c_delete_extension", { extension: "ПланыПродаж" })
    expect(execs.at(-1)).toMatchObject({ operation: "delete_extension", extension: "ПланыПродаж" })
    expect(await call("1c_update_db", {})).not.toContain("не применены")
  })
})

// debrief14.md §14.5: schema errors found one load at a time.
describe("1c_check_dcs", () => {
  test("a schema file goes to the base; the answer comes back as is", async () => {
    const call = await session()
    const schema = join(WORK, "Template.xml")
    writeFileSync(schema, '<?xml version="1.0"?><DataCompositionSchema xmlns="http://v8.1c.ru/8.1/data-composition-system/schema"/>')
    expect(await call("1c_check_dcs", { path: schema })).toContain("прошла проверку")
    expect(execs.at(-1)).toMatchObject({ operation: "check-dcs", path: schema, conversationId: "session:ses_test" })
  })

  test("a missing file, or one that isn't a schema, never reaches the base", async () => {
    const call = await session()
    expect(await call("1c_check_dcs", { path: join(WORK, "нет.xml") })).toContain("Файла нет")
    const form = join(WORK, "Form.xml")
    writeFileSync(form, "<Form/>")
    expect(await call("1c_check_dcs", { path: form })).toContain("не схема компоновки данных")
    expect(execs).toHaveLength(0)
  })
})

// debrief14.md §14.2/§14.4: the shell wrote into temp while the write tool's guard held.
describe("a shell write into temp, through the plugin", () => {
  test("is refused before it runs; a read from temp is not", async () => {
    const call = await session()
    await expect(
      call("bash", { command: String.raw`Get-ChildItem c:\conf -Name | Out-File "$env:TEMP\opencode\cats.txt"` }),
    ).rejects.toThrow("временный каталог")
    expect(await call("bash", { command: String.raw`Get-Content "$env:TEMP\opencode\cats.txt"` })).toBe("")
  })
})

// debrief14.md §14.7: the binding pass walked `<Kind>/<Object>/Forms/` only, and
// a common form is `CommonForms/<Форма>/Ext` -- its handlers were never bound.
describe("a common form in a configuration tree", () => {
  test("its unbound handler is bound before the load", async () => {
    const call = await session()
    const ext = join(WORK, "common_src", "CommonForms", "ОбщаяФорма", "Ext")
    mkdirSync(join(ext, "Form"), { recursive: true })
    writeFileSync(join(WORK, "common_src", "Configuration.xml"), "<MetaDataObject/>")
    writeFileSync(
      join(ext, "Form.xml"),
      '<?xml version="1.0" encoding="UTF-8"?>\n<Form xmlns="http://v8.1c.ru/8.3/xcf/logform" version="2.21">\n\t<Attributes/>\n</Form>\n',
    )
    writeFileSync(
      join(ext, "Form", "Module.bsl"),
      "&НаСервере\nПроцедура ПриСозданииНаСервере(Отказ, СтандартнаяОбработка)\nКонецПроцедуры\n",
    )
    await call("1c_load_config_from_files", { path: join(WORK, "common_src"), extension: "Х" })
    expect(readFileSync(join(ext, "Form.xml"), "utf8")).toContain('<Event name="OnCreateAtServer">ПриСозданииНаСервере</Event>')
  })
})

// debrief15.md: the user's standing permission (profile.allowWriteWithoutConfirmation).
describe("writing without confirmation, allowed in the profile", () => {
  const WRITE = "Ссылка.ПолучитьОбъект().Записать();"

  test("off (the default): a write in 1c_execute_code is refused, and configurator writes ask", async () => {
    const call = await session()
    asks.length = 0
    await expect(call("1c_execute_code", { code: WRITE })).rejects.toThrow("1c_write_code")
    await call("1c_update_db", {})
    expect(asks).toHaveLength(1)
  })

  test("on: the write runs and is journalled, configurator writes don't ask, 1c_write_code says so", async () => {
    allowWrite = true
    try {
      const call = await session()
      asks.length = 0
      expect(await call("1c_execute_code", { code: WRITE })).toBe("")
      expect(readFileSync(journalPath(WORK), "utf8")).toContain("разрешено в профиле")
      await call("1c_update_db", {})
      expect(asks).toHaveLength(0)
      const text = await call("1c_write_code", { code: WRITE, summary: "с", objects: "Справочник.Х", count: 1, organisations: "все" })
      expect(text).toContain("Подтверждение не нужно")
      expect(asks).toHaveLength(0)
      expect(await call("1c_profile_info", {})).toContain("Запись в базу: без подтверждения")
    } finally {
      allowWrite = false
    }
  })

  // debrief15.md §15.18: every journal entry of a run said «Объекты: не указано».
  test("on: the journal names what the code writes to", async () => {
    allowWrite = true
    try {
      const call = await session()
      // Not a registration: that waits for a comparison with the sample (below).
      await call("1c_execute_code", { code: "Э = Справочники.Контрагенты.СоздатьЭлемент();\nЭ.Записать();" })
      expect(readFileSync(journalPath(WORK), "utf8")).toContain("по коду: Справочник.Контрагенты")
    } finally {
      allowWrite = false
    }
  })

  // debrief15.md §15.18: with the toolkit down, «выполняй через 1c_execute_code»
  // named a tool the agent did not have, and it called 1c_write_code over and over.
  test("on, with the toolkit down: 1c_write_code says to start the toolkit first", async () => {
    allowWrite = true
    toolkitPort = "free"
    try {
      const call = await session()
      const text = await call("1c_write_code", { code: WRITE, summary: "с", objects: "Справочник.Х", count: 1, organisations: "все" })
      expect(text).toContain("Подтверждение не нужно")
      expect(text).toContain("нет в твоём списке")
      expect(text).toContain("1c_toolkit_start")
    } finally {
      allowWrite = false
      toolkitPort = "up"
    }
  })
})

// debrief15.md §15.2: the agent closes a blocking window itself.
describe("1c_close_dialog, through the plugin", () => {
  test("passes PID and button to the app and returns its answer; a missing button lists what is there", async () => {
    const call = await session()
    expect(await call("1c_close_dialog", { pid: 2240, button: "Закрыть" })).toContain("сеанс свободен")
    expect(execs.at(-1)).toMatchObject({ operation: "close-dialog", pid: 2240, button: "Закрыть", conversationId: "session:ses_test" })
    const missing = await call("1c_close_dialog", { pid: 2240, button: "ОК" })
    expect(missing).toContain("Такой кнопки")
    expect(missing).toContain("Подключить")
  })
})

// debrief15.md §15.3: four approvals were spent on calls that never reached the base.
describe("an approval spent on a call that never reached the base", () => {
  const WRITE = "Ссылка.ПолучитьОбъект().Записать();"
  const facts = { code: WRITE, summary: "с", objects: "Справочник.Х", count: 1, organisations: "все" }

  async function plugin() {
    // oxlint-disable-next-line typescript/no-explicit-any -- the plugin input is unused on these paths
    const hooks = await InfobasePlugin({} as any, { baseUrl: `http://localhost:${relay.port}` })
    // oxlint-disable-next-line typescript/no-explicit-any -- only sessionID and ask are read
    const ctx = { sessionID: "ses_spent", ask: async (request: unknown) => void asks.push(request) } as any
    const before = (callID: string) =>
      hooks["tool.execute.before"]!({ tool: "1c_execute_code", sessionID: "ses_spent", callID }, { args: { code: WRITE } })
    const failed = (callID: string, error: string) =>
      hooks.event!({
        // oxlint-disable-next-line typescript/no-explicit-any -- the part update opencode publishes, trimmed
        event: { type: "message.part.updated", properties: { part: { type: "tool", callID, state: { status: "error", error } } } } as any,
      })
    const writeCode = async () => {
      const result = await hooks.tool!["1c_write_code"]!.execute(facts, ctx)
      return typeof result === "string" ? result : result.output
    }
    return { before, failed, writeCode }
  }

  test("«Not connected» gives it back: the retry runs, and 1c_write_code doesn't ask again", async () => {
    const { before, failed, writeCode } = await plugin()
    asks.length = 0
    await writeCode()
    expect(asks).toHaveLength(1)
    await before("c1")
    await failed("c1", "Not connected")
    expect(await writeCode()).toContain("Разрешение на этот код уже есть")
    expect(asks).toHaveLength(1)
    await before("c2")
    // Spent again by the retry that ran.
    await expect(before("c3")).rejects.toThrow("1c_write_code")
  })

  test("an error that may have come after the write keeps it spent", async () => {
    const { before, failed, writeCode } = await plugin()
    await writeCode()
    await before("t1")
    await failed("t1", "Request timed out")
    await expect(before("t2")).rejects.toThrow("1c_write_code")
  })
})

// debrief15.md §15.4: the profile's dump is readable without an ask, so writes into it are refused here.
describe("a write into a configuration dump", () => {
  function dump(root: string) {
    mkdirSync(join(root, "CommonModules", "Модуль", "Ext"), { recursive: true })
    writeFileSync(join(root, "Configuration.xml"), "<MetaDataObject/>")
    writeFileSync(join(root, "ConfigDumpInfo.xml"), "<ConfigDumpInfo/>")
  }

  test("outside the working directory is refused; inside it (an extension being edited) is work", async () => {
    const call = await session()
    const outside = join(ROOT, "base_conf")
    dump(outside)
    await expect(call("write", { filePath: join(outside, "CommonModules", "Модуль", "Ext", "Module.bsl"), content: "x" })).rejects.toThrow(
      "внутри выгрузки конфигурации",
    )
    const inside = join(WORK, "ext_dump")
    dump(inside)
    expect(await call("write", { filePath: join(inside, "CommonModules", "Модуль", "Ext", "Module.bsl"), content: "x" })).toBe("")
  })
})

// debrief15.md §15.5: the root descriptor was looked for beside `path` (as `xml.xml`); it is inside.
describe("dumping a processing to XML", () => {
  test("the result names the root file the platform wrote inside `path`", async () => {
    const call = await session()
    const out = join(WORK, "epf_xml")
    mkdirSync(join(out, "ПечатнаяФорма", "Ext"), { recursive: true })
    writeFileSync(join(out, "ПечатнаяФорма.xml"), "<MetaDataObject/>")
    writeFileSync(join(WORK, "form.epf"), "epf")
    const text = await call("1c_dump_epf_to_files", { path: out, epfPath: join(WORK, "form.epf") })
    expect(text).toContain(`Корневой файл выгрузки: ${join(out, "ПечатнаяФорма.xml")}`)
  })
})

// debrief15.md §15.12: changing a few cells of a copied standard template.
describe("1c_mxl_edit, through the plugin", () => {
  const TEMPLATE = [
    "<document>",
    "\t<rowsItem>",
    "\t\t<index>0</index>",
    "\t\t<row>",
    "\t\t\t<c>",
    "\t\t\t\t<c>",
    "\t\t\t\t\t<f>1</f>",
    "\t\t\t\t\t<parameter>Дата</parameter>",
    "\t\t\t\t</c>",
    "\t\t\t</c>",
    "\t\t</row>",
    "\t</rowsItem>",
    "\t<format>",
    "\t\t<fillType>Parameter</fillType>",
    "\t</format>",
    "</document>",
    "",
  ].join("\n")

  test("edits a template in the working directory, and its arguments survive the declared schema", async () => {
    const call = await session()
    const path = join(WORK, "Template.xml")
    writeFileSync(path, TEMPLATE)
    const args = { path, edits: [{ row: 1, column: 1, parameter: "ДатаНачала" }] }
    // oxlint-disable-next-line typescript/no-explicit-any -- the plugin input is unused here
    const hooks = await InfobasePlugin({} as any, { baseUrl: `http://localhost:${relay.port}` })
    expect(tool.schema.object(hooks.tool!["1c_mxl_edit"]!.args).parse(args)).toEqual(args)
    expect(await call("1c_mxl_edit", args)).toContain("параметр <ДатаНачала>")
    expect(readFileSync(path, "utf8")).toContain("<parameter>ДатаНачала</parameter>")
  })

  // debrief15.md §15.18: merges, new cells and a cell's look, through the schema.
  test("merge, a created cell and a style survive the declared schema and reach the file", async () => {
    const call = await session()
    const path = join(WORK, "Template.xml")
    writeFileSync(path, TEMPLATE.replace("</document>", "\t<vgRows>1</vgRows>\n</document>"))
    const args = {
      path,
      edits: [
        { row: 1, column: 3, create: true, like: { row: 1, column: 1 }, parameter: "Номер" },
        { merge: { row: 1, column: 1, rows: 1, columns: 2 } },
        { row: 1, column: 1, style: { align: "Center" as const, wrap: true } },
      ],
    }
    // oxlint-disable-next-line typescript/no-explicit-any -- the plugin input is unused here
    const hooks = await InfobasePlugin({} as any, { baseUrl: `http://localhost:${relay.port}` })
    expect(tool.schema.object(hooks.tool!["1c_mxl_edit"]!.args).parse(args)).toEqual(args)
    const text = await call("1c_mxl_edit", args)
    expect(text).toContain("объединение: строка 1, колонка 1: 1 стр. × 2 кол.")
    const xml = readFileSync(path, "utf8")
    expect(xml).toContain("<parameter>Номер</parameter>")
    expect(xml).toContain("\t<merge>\n\t\t<r>0</r>\n\t\t<c>0</c>\n\t\t<w>1</w>\n\t</merge>")
    expect(xml).toContain("<horizontalAlignment>Center</horizontalAlignment>\n\t\t<textPlacement>Wrap</textPlacement>")
  })

  test("an edit that is neither a cell, a merge nor an unmerge is refused before the file is read", async () => {
    const call = await session()
    const path = join(WORK, "Template.xml")
    writeFileSync(path, TEMPLATE)
    const text = await call("1c_mxl_edit", { path, edits: [{ row: 1, column: 1, merge: { row: 1, column: 1, rows: 1, columns: 2 } }] })
    expect(text).toContain("нужна ровно одна")
    expect(readFileSync(path, "utf8")).toBe(TEMPLATE)
  })

  // debrief15.md §15.21: a column merge hid a title; unmerge_columns cancels it.
  test("unmerge_columns survives the declared schema and reaches the file", async () => {
    const call = await session()
    const path = join(WORK, "Template.xml")
    writeFileSync(
      path,
      TEMPLATE.replace("</document>", "\t<vgRows>1</vgRows>\n\t<merge>\n\t\t<r>-1</r>\n\t\t<c>1</c>\n\t\t<w>2</w>\n\t</merge>\n</document>"),
    )
    const args = { path, edits: [{ unmerge_columns: { row: 1, column: 3, rows: 2 } }] }
    // oxlint-disable-next-line typescript/no-explicit-any -- the plugin input is unused here
    const hooks = await InfobasePlugin({} as any, { baseUrl: `http://localhost:${relay.port}` })
    expect(tool.schema.object(hooks.tool!["1c_mxl_edit"]!.args).parse(args)).toEqual(args)
    expect(await call("1c_mxl_edit", args)).toContain("объединение колонок отменено в строках 1, 2")
    expect(readFileSync(path, "utf8")).toContain("\t</merge>\n\t<verticalUnmerge>\n\t\t<r>0</r>\n\t\t<c>1</c>\n\t\t<w>2</w>")
  })

  test("a template outside the working directory is not touched", async () => {
    const call = await session()
    const path = join(ROOT, "Template.xml")
    writeFileSync(path, TEMPLATE)
    expect(await call("1c_mxl_edit", { path, edits: [{ row: 1, column: 1, text: "x" }] })).toContain("вне рабочего каталога")
    expect(readFileSync(path, "utf8")).toBe(TEMPLATE)
  })
})

// debrief16.md §16.3 items 1, 2, 4: a report from nothing, built into a new .erf, then run as a user would.
describe("an external report from nothing", () => {
  test("1c_new_external writes the tree through the declared schema; the loader refuses a .epf target for it", async () => {
    const call = await session()
    // oxlint-disable-next-line typescript/no-explicit-any -- the plugin input is unused here
    const hooks = await InfobasePlugin({} as any, { baseUrl: `http://localhost:${relay.port}` })
    const args = { kind: "report", name: "Прибыль", path: join(WORK, "report") }
    expect(tool.schema.object(hooks.tool!["1c_new_external"]!.args).parse(args)).toEqual(args)
    const created = await call("1c_new_external", args)
    expect(created).toContain(join(WORK, "report", "Прибыль.erf"))
    const root = join(WORK, "report", "Прибыль.xml")
    expect(readFileSync(root, "utf8")).toContain("e41aff26-25cf-4bb6-b6c1-3f478a75f374")
    expect(await call("1c_new_external", args)).toContain("не перезаписываются")

    execs.length = 0
    const wrong = await call("1c_load_epf_from_files", { path: root, epfPath: join(WORK, "report", "Прибыль.epf") })
    expect(wrong).toContain(`epfPath: "${join(WORK, "report", "Прибыль.erf")}"`)
    expect(execs).toHaveLength(0)
  })

  // debrief18.md: a processing that needs a form gets one from the tool, not by hand.
  test("a processor with form: true, through the declared schema, gets the form's files and says where they are", async () => {
    const call = await session()
    // oxlint-disable-next-line typescript/no-explicit-any -- the plugin input is unused here
    const hooks = await InfobasePlugin({} as any, { baseUrl: `http://localhost:${relay.port}` })
    const args = { kind: "processor", name: "Загрузка", path: join(WORK, "loader"), form: true }
    expect(tool.schema.object(hooks.tool!["1c_new_external"]!.args).parse(args)).toEqual(args)
    const created = await call("1c_new_external", args)
    expect(created).toContain(join(WORK, "loader", "Загрузка", "Forms", "Форма", "Ext", "Form.xml"))
    expect(readFileSync(join(WORK, "loader", "Загрузка.xml"), "utf8")).toContain("<Form>Форма</Form>")
    expect(readFileSync(join(WORK, "loader", "Загрузка", "Forms", "Форма", "Ext", "Form", "Module.bsl"), "utf8")).toContain(
      "КомандаВыполнить",
    )
  })

  test("a build into a new .erf runs, and a target that did not appear is said", async () => {
    const call = await session()
    await call("1c_new_external", { kind: "report", name: "Отчет2", path: join(WORK, "report2") })
    execs.length = 0
    // The fake configurator writes nothing, which is exactly the «успешно» without a file.
    const text = await call("1c_load_epf_from_files", {
      path: join(WORK, "report2", "Отчет2.xml"),
      epfPath: join(WORK, "report2", "Отчет2.erf"),
    })
    expect(execs).toHaveLength(1)
    expect(text).toContain("не появился")
  })

  test("1c_run_report passes parameters through the declared schema and writes into the working directory", async () => {
    const call = await session()
    const erf = join(WORK, "report", "built.erf")
    writeFileSync(erf, "x")
    const args = { path: erf, params: { ВидЦены: "Оптовая", ПериодОтчета: "2025-01-01..2025-06-30" }, filters: { Подразделение: "Дирекция" } }
    // oxlint-disable-next-line typescript/no-explicit-any -- the plugin input is unused here
    const hooks = await InfobasePlugin({} as any, { baseUrl: `http://localhost:${relay.port}` })
    expect(tool.schema.object(hooks.tool!["1c_run_report"]!.args).parse(args)).toEqual(args)
    execs.length = 0
    expect(await call("1c_run_report", args)).toContain(join(WORK, "report_runs", "built-"))
    expect(execs[0]).toMatchObject({ operation: "run-report", params: args.params, filters: args.filters })
    expect(await call("1c_run_report", { path: join(WORK, "report", "x.epf") })).toContain("Ожидается внешний отчёт .erf")
  })
})
