import { describe, expect, test } from "bun:test"

import { checkComparison, registrationRefusal, type SampleField } from "./sample-check"

// debrief15.md §15.24 item 31: run 4 called its print matching while the
// acknowledgement date, a split field and an amount were wrong.

const times: Record<string, number> = { "sample.jpg": 1, "form.epf": 100, "print.pdf": 200, "old.pdf": 50 }
const modified = (path: string) => times[path] ?? null

const fine: SampleField[] = [
  { field: "организация", sample: "(заклеено)", print: "ООО \"ФАЛМЕК РУССИА\"", match: true },
  { field: "номер документа", sample: "22-в/к", print: "1", match: true },
  { field: "заголовок", sample: "ПРИКАЗ (распоряжение) о приеме на профессиональное обучение", print: "то же, 4 строки", match: true },
  { field: "табельный номер", sample: "СУ000144", print: "ЗПЗК-00016", match: true },
  { field: "дата ознакомления", sample: "от руки: «01» 03 2025", print: "пусто", match: true },
  { field: "характер работы", sample: "На период обучения", print: "нет такого поля", match: false, reason: "разделю ячейку" },
]
const args = (fields: SampleField[], print = "print.pdf") => ({ sample: "sample.jpg", print, epf: "form.epf", fields })

describe("a comparison handed in", () => {
  test("a consistent table is accepted, recorded for this build, and comes back as a table for the report", () => {
    const result = checkComparison(args(fine), modified)
    if (!result.ok) throw new Error(result.error)
    expect(result.check).toMatchObject({ epf: "form.epf", epfModified: 100 })
    expect(result.report).toContain("| дата ознакомления | от руки: «01» 03 2025 | пусто | да |")
    expect(result.report).toContain("| характер работы | На период обучения | нет такого поля | нет: разделю ячейку |")
    expect(result.report).toContain("Отличий: 1.")
  })

  test("run 4's acknowledgement date: handwriting in the sample, a date in the print, called a match", () => {
    const rows = fine.map((row) => (row.field === "дата ознакомления" ? { ...row, print: "\"03\" февраля 2025 г." } : row))
    const result = checkComparison(args(rows), modified)
    expect(result.ok ? "" : result.error).toContain("«дата ознакомления»: в образце вписано от руки")
  })

  test("blank on one side, a value on the other, is not a match", () => {
    const rows = [...fine, { field: "по (дата)", sample: "31/05/2023", print: "пусто", match: true }]
    expect(checkComparison(args(rows), modified).ok).toBe(false)
    const blanks = [...fine, { field: "подпись", sample: "пусто", print: "—", match: true }]
    expect(checkComparison(args(blanks), modified).ok).toBe(true)
  })

  test("a difference with no reason is refused", () => {
    const rows = fine.map((row) => (row.field === "характер работы" ? { ...row, reason: " " } : row))
    const result = checkComparison(args(rows), modified)
    expect(result.ok ? "" : result.error).toContain("«характер работы»: отличается, а причины нет")
  })

  test("a PDF older than the build, a missing file, or a handful of fields is refused", () => {
    const old = checkComparison(args(fine, "old.pdf"), modified)
    expect(old.ok ? "" : old.error).toContain("PDF старше сборки")
    const missing = checkComparison(args(fine, "nowhere.pdf"), modified)
    expect(missing.ok ? "" : missing.error).toContain("Нет файла: print = nowhere.pdf")
    const few = checkComparison(args(fine.slice(0, 4)), modified)
    expect(few.ok ? "" : few.error).toContain("Полей в сверке 4")
  })
})

describe("registration waits for the comparison", () => {
  const register = 'Обработка = Справочники.ДополнительныеОтчетыИОбработки.СоздатьЭлемент();\nОбработка.Записать();'
  const recorded = () => {
    const result = checkComparison(args(fine), modified)
    if (!result.ok) throw new Error(result.error)
    return result.check
  }

  test("without one it is refused; with one of the current build it goes on", () => {
    expect(registrationRefusal(register, undefined, modified)).toContain("после сверки печати с образцом")
    expect(registrationRefusal(register, recorded(), modified)).toBeNull()
  })

  test("a rebuild after the comparison needs a new one", () => {
    const check = recorded()
    const rebuilt = (path: string) => (path === "form.epf" ? 300 : modified(path))
    expect(registrationRefusal(register, check, rebuilt)).toContain("пересобрали после сверки")
  })

  test("other code is not held", () => {
    expect(registrationRefusal("Сотрудник = Справочники.Сотрудники.НайтиПоКоду(\"1\");", undefined, modified)).toBeNull()
  })
})
