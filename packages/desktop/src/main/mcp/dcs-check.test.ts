import { describe, expect, test } from "bun:test"

import { checkDcs, dcsCheckCode, describeDcsCheck, parseDcsCheck } from "./dcs-check"

// debrief14.md §14.5: four rounds of load, update and run to find four schema
// errors. The errors below are the ones those rounds found.

describe("the code sent to the base", () => {
  test("reads the file the way the standard configurations read a schema, then goes step by step", () => {
    const code = dcsCheckCode('C:\\w\\Reports\\Отчет\\Templates\\Схема\\Ext\\Template.xml')
    expect(code).toContain('СериализаторXDTO.ПрочитатьXML(Чтение, Тип("СхемаКомпоновкиДанных"))')
    expect(code).toContain("Новый ИсточникДоступныхНастроекКомпоновкиДанных(Схема)")
    expect(code).toContain("КН.ЗагрузитьНастройки(Схема.НастройкиПоУмолчанию)")
    expect(code).toContain("Компоновщик.Выполнить(Схема, Настройки")
    // debrief17.md §17.3: required parameters get a value of their own type for the check.
    expect(code).toContain("ПарСх.ЗапрещатьНезаполненныеЗначения")
    expect(code).toContain("Процессор.Инициализировать(Макет)")
    expect(code).toContain('Чтение.ОткрытьФайл("C:\\w\\Reports\\Отчет\\Templates\\Схема\\Ext\\Template.xml")')
  })

  test("a quote in the path cannot break out of the literal", () => {
    expect(dcsCheckCode('C:\\a"b.xml')).toContain('"C:\\a""b.xml"')
  })
})

describe("reading the answer", () => {
  test("a required parameter with no value is checked with a placeholder, and said", () => {
    const check = parseDcsCheck(
      '1ccoder-dcs|СтрокаСоединения=File="C:\b";|read=ok|sources=ok|placeholders=ВидЦены;НачалоПериода;|layout=ok|init=ok',
    )!
    expect(check.placeholders).toEqual(["ВидЦены", "НачалоПериода"])
    const described = describeDcsCheck("S.xml", check)
    expect(described.passed).toBe(true)
    expect(described.text).toContain("Обязательные параметры без значения в варианте (ВидЦены, НачалоПериода)")
  })

  test("every step passed", () => {
    const check = parseDcsCheck('1ccoder-dcs|СтрокаСоединения=File="C:\\b";|read=ok|sources=ok|layout=ok|init=ok')
    expect(check).toMatchObject({ passed: ["read", "sources", "layout", "init"] })
    expect(describeDcsCheck("S.xml", check!)).toMatchObject({ passed: true })
  })

  test("the failing step and its error are named, with what to look up", () => {
    const check = parseDcsCheck(
      '1ccoder-dcs|СтрокаСоединения=File="C:\\b";|read=ok|sources=ok|layout={(8)}: Ошибка компоновки макета: Параметр не найден "СрокНеликвида"',
    )!
    expect(check.failed).toEqual({ step: "layout", error: '{(8)}: Ошибка компоновки макета: Параметр не найден "СрокНеликвида"' })
    const described = describeDcsCheck("S.xml", check)
    expect(described.passed).toBe(false)
    expect(described.text).toContain("компоновка макета")
    expect(described.text).toContain('Параметр не найден "СрокНеликвида"')
    expect(described.text).toContain("«Всегда»")
  })

  test("a schema that doesn't read points at the namespace declaration", () => {
    const check = parseDcsCheck('1ccoder-dcs|СтрокаСоединения=x|read=Ошибка преобразования данных XDTO')!
    expect(describeDcsCheck("S.xml", check).text).toContain("`cfg:`")
  })

  test("an answer without the marker is not read as a result", () => {
    expect(parseDcsCheck('{"success": false, "error": "…"}')).toBeNull()
  })
})

describe("the whole check against a scripted toolkit", () => {
  const profile = { kind: "file" as const, filePath: "C:\\b" }

  function toolkit(text: string): typeof fetch {
    const replies = [
      { jsonrpc: "2.0", id: 1, result: {} },
      null,
      { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text }] } },
    ]
    let call = 0
    return (async () => {
      const reply = replies[call++]
      return new Response(reply ? JSON.stringify(reply) : null, {
        status: reply ? 200 : 202,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch
  }

  test("an expression error fails at initialization", async () => {
    const outcome = await checkDcs({ path: "C:/w/Template.xml" }, profile, {
      fetch: toolkit(
        '1ccoder-dcs|СтрокаСоединения=File="C:\\b";|read=ok|sources=ok|layout=ok|init=Ошибка в выражении: Синтаксическая ошибка "ТекущаяДатаСеанса"',
      ),
    })
    expect(outcome).toMatchObject({ ok: true, passed: false })
    expect(outcome.ok && outcome.text).toContain("ТекущаяДатаСеанса")
  })

  test("a different base on the toolkit's port is refused", async () => {
    const outcome = await checkDcs({ path: "C:/w/Template.xml" }, profile, {
      fetch: toolkit('1ccoder-dcs|СтрокаСоединения=File="C:\\other";|read=ok|sources=ok|layout=ok|init=ok'),
    })
    expect(outcome).toMatchObject({ ok: false, reason: "other-infobase" })
  })
})
