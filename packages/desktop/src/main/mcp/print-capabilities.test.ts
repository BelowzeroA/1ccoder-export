import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"

import {
  describePrintCapabilities,
  exportedEntryPoints,
  parsePrintReply,
  PRINT_CAPABILITIES_CODE,
  printCapabilities,
} from "./print-capabilities"

// 2026-09-25, skills_rebuild_plan.md Part 2.5.

const REPLY =
  '1ccoder-print|МакетыПечатныхФорм=0|ПользовательскиеМакетыПечати=1|ДополнительныеОтчетыИОбработки=1|УправлениеПечатью=1|ПользовательскихМакетов=3|БСП=3.1.5.366|СтрокаСоединения=File="C:\\Bases\\Trade";'

describe("asking the base", () => {
  test("asks nothing the toolkit refuses and writes nothing", () => {
    expect(PRINT_CAPABILITIES_CODE).not.toMatch(/Записать|Удалить|УстановитьПривилегированныйРежим|(?<!\.)Выполнить\(|Вычислить/)
    expect(PRINT_CAPABILITIES_CODE).toContain("СтрокаСоединенияИнформационнойБазы()")
  })

  test("reads the answer, plain or wrapped", () => {
    for (const text of [REPLY, JSON.stringify({ success: true, data: REPLY })]) {
      expect(parsePrintReply(text)).toEqual({
        objects: {
          МакетыПечатныхФорм: false,
          ПользовательскиеМакетыПечати: true,
          ДополнительныеОтчетыИОбработки: true,
          УправлениеПечатью: true,
        },
        userTemplates: 3,
        bspVersion: "3.1.5.366",
        connectionString: 'File="C:\\Bases\\Trade";',
      })
    }
  })

  test("the table says what is missing, loudly", () => {
    const text = describePrintCapabilities(parsePrintReply(REPLY)!)
    expect(text).toContain("| `МакетыПечатныхФорм` | НЕТ |")
    expect(text).toContain("Записей в `ПользовательскиеМакетыПечати`: 3.")
    expect(text).toContain("Передай")
  })
})

describe("export status from a dump", () => {
  test("reads the declaration, not a call", () => {
    const module = [
      "Функция СформироватьВнешнююПечатнуюФорму(Ссылка, Ид, Список)",
      "КонецФункции",
      "Функция КомандыПечатиФормы(Форма) Экспорт",
      "КонецФункции",
    ].join("\n")
    expect(exportedEntryPoints(module)).toEqual({
      СформироватьВнешнююПечатнуюФорму: false,
      КомандыПечатиФормы: true,
      ОтключитьКомандыПечати: undefined,
    })
  })

  // The finding this tool exists for, on the real modules when present: point
  // DUMP_BP30, DUMP_UT11 and DUMP_KA2 at configuration dumps (e.g. in .env.test.local).
  const REAL = [
    { dir: process.env.DUMP_BP30 ?? "", name: "БП 3.0.205", exported: true },
    { dir: process.env.DUMP_UT11 ?? "", name: "УТ 11.5.7", exported: false },
    // КА shares УТ's objects but not its БСП: 3.1.12 here, as in БП, and exported.
    { dir: process.env.DUMP_KA2 ?? "", name: "КА 2.6.1.64", exported: true },
  ]
  for (const real of REAL) {
    const path = `${real.dir}/CommonModules/УправлениеПечатью/Ext/Module.bsl`
    test.skipIf(!real.dir || !existsSync(path))(`СформироватьВнешнююПечатнуюФорму in ${real.name}`, () => {
      const found = exportedEntryPoints(readFileSync(path, "utf8"))
      expect(found.СформироватьВнешнююПечатнуюФорму).toBe(real.exported)
      expect(found.КомандыПечатиФормы).toBe(true)
      expect(found.ОтключитьКомандыПечати).toBe(true)
    })
  }
})

describe("the wrong base", () => {
  test("is refused, not reported", async () => {
    const send = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      const result = body.method === "tools/call" ? { content: [{ type: "text", text: REPLY }] } : {}
      if (!("id" in body)) return new Response(null, { status: 202 })
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch
    const outcome = await printCapabilities({ kind: "file", filePath: "C:\\Bases\\Acc" }, { fetch: send })
    expect(outcome).toMatchObject({ ok: false, reason: "other-infobase" })
    const own = await printCapabilities({ kind: "file", filePath: "C:\\Bases\\Trade" }, { fetch: send })
    expect(own).toMatchObject({ ok: true })
  })
})
