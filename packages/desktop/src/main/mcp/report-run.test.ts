import { describe, expect, test } from "bun:test"

import { analyseDump, describeReportRun, parseReportRun, reportRunCode } from "./report-run"

// debrief16.md §16.3 item 4. The dump format is the one the generated code wrote
// on a scratch base (8.5.1); the report below mimics the one handed over in that
// run: cost empty on most rows, a long order name in a 9-wide column.

const dump = [
  "widths\t30.00\t9.00\t12.00\t14.00",
  "row\t\t\t\t",
  "row\tВаловая прибыль\t\t\t",
  "row\tПараметры:\tПериод: 01.01.2025 - 30.06.2025\t\t",
  "row\t\tВид цены: Себестоимость\t\t",
  "row\tПодразделение\tЗаказ клиента\tВыручка\tСебестоимость",
  "row\tНоменклатура\tХарактеристика\t\t",
  "row\tДирекция\tЗаказ клиента 00-000001 от 01.06.2025 12:00:00\t16 666.67\t",
  "row\tКондиционер\tС пультом\t16 666.67\t",
  "row\tОтдел продаж\tЗаказ клиента 00-000002 от 06.06.2025\t170 000.00\t120 000.00",
  "row\tКондиционер\tС пультом\t170 000.00\t120 000.00",
  "row\tИтого\t\t186 666.67\t120 000.00",
].join("\n")

describe("reading the rendered report", () => {
  test("finds the header under the parameter block and counts empty cells per column", () => {
    const { columns, dataRows } = analyseDump(dump)
    expect(dataRows).toBe(5)
    const cost = columns.find((column) => column.title === "Себестоимость")!
    expect(cost.filled).toBe(3)
    expect(cost.rows).toBe(5)
    expect(cost.numeric).toBe(true)
    const order = columns.find((column) => column.title.startsWith("Заказ клиента"))!
    expect(order.title).toBe("Заказ клиента / Характеристика")
    expect(order.widest).toBeGreaterThan(order.width)
  })

  test("the description names empty columns, narrow columns and empty parameters", () => {
    const run = parseReportRun(
      "1ccoder-report|СтрокаСоединения=File=\"C:\\b\";|empty_on_open=ВидЦены (обязательный);|not_found=|rows=12|ok=1",
    )!
    expect(run.emptyOnOpen).toEqual(["ВидЦены (обязательный)"])
    const described = describeReportRun({ path: "C:\\r.erf", outBase: "C:\\w\\r-1" }, run, dump)
    expect(described.passed).toBe(false)
    expect(described.text).toContain("«Себестоимость»: пусто в 2 из 5")
    // A grouping column, empty on detail rows by design, is not listed.
    expect(described.text).not.toContain("«Подразделение / Номенклатура»: пусто")
    expect(described.text).toContain("C:\\w\\r-1.pdf")
    expect(described.text).toContain("ВидЦены (обязательный)")
    expect(described.text).toMatch(/«Заказ клиента \/ Характеристика»: ширина 9/)
  })

  test("a failed step is reported as such", () => {
    const run = parseReportRun('{"success": true, "data": "1ccoder-report|СтрокаСоединения=x|failed=compose: Поле не найдено"}')!
    expect(describeReportRun({ path: "C:\\r.erf", outBase: "C:\\w\\r" }, run, null).text).toContain("шаг compose")
    const unset = parseReportRun('1ccoder-report|СтрокаСоединения=x|failed=compose: Не установлено значение параметра "ВидЦены"')!
    expect(describeReportRun({ path: "C:\\r.erf", outBase: "C:\\w\\r" }, unset, null).text).toContain("передай его в params")
  })
})

describe("the generated code", () => {
  test("carries the parameters, filters and output paths as literals, and no reserved words as names", () => {
    const code = reportRunCode({
      path: 'C:\\w\\"r".erf',
      params: { ВидЦены: "Оптовая", ПериодОтчета: "2025-01-01..2025-06-30" },
      filters: { Подразделение: "Дирекция" },
      outBase: "C:\\w\\report_runs\\r-1",
    })
    expect(code).toContain('П.Вставить("ВидЦены", "Оптовая");')
    expect(code).toContain('О.Вставить("Подразделение", "Дирекция");')
    expect(code).toContain('Новый ДвоичныеДанные("C:\\w\\""r"".erf")')
    // Attached from storage with warnings off, never opened from the file.
    expect(code).toMatch(/ВнешниеОтчеты\.Подключить\(Адрес, .+, Ложь, Защита\)/)
    expect(code).toContain("Защита.ПредупреждатьОбОпасныхДействиях = Ложь;")
    expect(code).not.toContain('ВнешниеОтчеты.Создать("')
    expect(code).toContain('"C:\\w\\report_runs\\r-1.pdf"')
    // `Знач` is a keyword; as a variable it stops the module from compiling.
    expect(code).not.toMatch(/(^|[^А-Яа-яЁё])Знач\s*=/m)
    expect(code).not.toMatch(/^\s*(Процедура|Функция)\s/m)
  })
})
