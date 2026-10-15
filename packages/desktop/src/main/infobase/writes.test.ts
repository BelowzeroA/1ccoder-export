import { beforeEach, describe, expect, test } from "bun:test"

import {
  approvalKey,
  clearApprovals,
  consumeApproval,
  hasNearMissApproval,
  inspectBaseWrite,
  inspectOverwrite,
  missingFacts,
  overwriteRefusal,
  recordApproval,
  writeAskText,
  writeRefusal,
  writeTargets,
} from "./writes"

beforeEach(clearApprovals)

// 2026-09-23/24, debrief9.md §9.5 / G6. Twice a loop rewrote every invoice in the
// base and nobody was asked, because `1c_execute_code` is an MCP tool that never
// passes through `infobase_write` and a before-hook has no `ctx` to ask with.
const THE_WRITE = `РефЗаголовок = Справочники.ЗаголовкиСчетовПокупателям.НайтиПоНаименованию("СЧЁТ-ДОГОВОР");
Запрос = Новый Запрос("ВЫБРАТЬ Ссылка ИЗ Документ.СчетНаОплатуПокупателю ГДЕ ЗаголовокСчета <> &Заголовок");
Выборка = Запрос.Выполнить().Выбрать();
Пока Выборка.Следующий() Цикл
\tОбъ = Выборка.Ссылка.ПолучитьОбъект();
\tОбъ.ЗаголовокСчета = РефЗаголовок;
\tОбъ.Записать();
КонецЦикла;`

describe("detecting a write to the base", () => {
  test("the loop that did the damage is a write", () => {
    const verdict = inspectBaseWrite(THE_WRITE)
    expect(verdict.writes).toBe(true)
    expect(verdict.receivers).toContain("Объ")
  })

  test("a record manager is a write", () => {
    const code = `Запись = РегистрыСведений.ПользовательскиеМакетыПечати.СоздатьМенеджерЗаписи();
Запись.Объект = "ОбщийМакет";
Запись.Записать(Истина);`
    expect(inspectBaseWrite(code).writes).toBe(true)
  })

  test("a new catalog element is a write", () => {
    const code = `Новый = Справочники.ДополнительныеУсловия.СоздатьЭлемент();
Новый.Наименование = "Условия";
Новый.Записать();`
    expect(inspectBaseWrite(code).writes).toBe(true)
  })

  test("a one-liner with no intermediate variable is a write", () => {
    expect(inspectBaseWrite("Ссылка.ПолучитьОбъект().Записать();").writes).toBe(true)
  })

  test("setting a constant is a write", () => {
    expect(inspectBaseWrite('Константы.ДополнительнаяКолонка.Установить("x");').writes).toBe(true)
  })

  test("deleting an object is a write", () => {
    const code = `Объ = Ссылка.ПолучитьОбъект();\nОбъ.Удалить();`
    expect(inspectBaseWrite(code).writes).toBe(true)
  })
})

// The reason this is not a search for `Записать(`. The 09-23 session made six
// legitimate `Записать` calls that never touched the base; a guard that fires on
// read-only work is one the agent learns to route around, and on 09-23 "routing
// around" meant writing its own MCP client.
// 2026-09-25, observed live. `УправлениеПечатью.ЗаписатьМакет(...)` wrote the
// user-template register record through `1c_execute_code` and was neither
// refused, nor asked about, nor journalled -- all three layers consult
// `inspectBaseWrite`. Producer tracking cannot see it: a library procedure
// writes internally and hands back nothing. Worse, this is the idiom the skill
// recommends over a hand-rolled record manager.
describe("a write made by a library call", () => {
  test("the call that got through is caught", () => {
    const code = 'УправлениеПечатью.ЗаписатьМакет("ОбщийМакет.ПФ_MXL_СчетЗаказ", ДвоичныеДанные);'
    expect(inspectBaseWrite(code).writes).toBe(true)
  })

  test("a settings storage save is caught", () => {
    expect(inspectBaseWrite('ХранилищеОбщихНастроек.Сохранить("ключ", "об", Знач);').writes).toBe(true)
  })

  // A bare `Записать(` is ambiguous -- a spreadsheet and a text document both
  // have one -- so it stays with producer tracking. Only a NAMED `ЗаписатьX(`
  // counts, and serialisation and file output are excluded by name.
  test("writing a макет to a file is still not a base write", () => {
    expect(inspectBaseWrite("Макет.Записать(Путь, ТипФайлаТабличногоДокумента.MXL);").writes).toBe(false)
  })

  test("serialisation and file output are not base writes", () => {
    expect(inspectBaseWrite("СериализаторXDTO.ЗаписатьXML(Запись, Значение);").writes).toBe(false)
    expect(inspectBaseWrite("Текст.ЗаписатьТекст(Путь);").writes).toBe(false)
    expect(inspectBaseWrite("ДД.ЗаписатьФайл(Путь);").writes).toBe(false)
  })

  // debrief16.md §16.1: a read-only composition probe was journalled as a write.
  test("the writer objects' own methods are not base writes", () => {
    const probe = [
      "Запись = Новый ЗаписьXML;",
      "Запись.УстановитьСтроку();",
      "Запись.ЗаписатьОбъявлениеXML();",
      'Запись.ЗаписатьНачалоЭлемента("а"); Запись.ЗаписатьАтрибут("б", "в"); Запись.ЗаписатьКонецЭлемента();',
      'ЗаписьJSON.ЗаписатьИмяСвойства("к"); ЗаписьJSON.ЗаписатьЗначение(1);',
      "Поток.ЗаписатьБайт(0); Поток.ЗаписатьЦелое32(1);",
    ].join("\n")
    expect(inspectBaseWrite(probe).writes).toBe(false)
    // …while a named write of the configuration's own API still counts.
    expect(inspectBaseWrite('УправлениеПечатью.ЗаписатьМакет("ОбщийМакет.Х", Данные);').writes).toBe(true)
  })

  // The heuristic keys on the name, so a library procedure that writes under a
  // different name still escapes. It is a second net, not a proof.
  test("a differently named library write is still missed, knowingly", () => {
    expect(inspectBaseWrite("УправлениеПечатью.ОтключитьКомандыПечати(Массив);").writes).toBe(false)
  })
})

// debrief18.md: the writes of a loader built as an external processing are in its
// own module, and the gate said «записи в базу не видно».
describe("a call into an external processing", () => {
  const attach = `ДД = Новый ДвоичныеДанные("C:\\w\\Загрузка.epf");
Адрес = ПоместитьВоВременноеХранилище(ДД);
Имя = ВнешниеОбработки.Подключить(Адрес, "Загрузка", Ложь);`

  test("a method call on a created processing is a write, and the refusal says why", () => {
    const verdict = inspectBaseWrite(`${attach}\nОбработка = ВнешниеОбработки.Создать(Имя);\nОбработка.Загрузить("C:\\w\\in", Ложь);`)
    expect(verdict).toMatchObject({ writes: true, receivers: ["Обработка"], external: true })
    expect(writeRefusal(verdict)).toContain("метод внешней обработки (Обработка)")
    expect(inspectBaseWrite("ВнешниеОтчеты.Создать(Имя).Сформировать(Результат);").writes).toBe(true)
  })

  test("reading its structure or opening its form is not", () => {
    expect(inspectBaseWrite(`${attach}\nМ = ВнешниеОбработки.Создать(Имя, Ложь).Метаданные();`).writes).toBe(false)
    expect(inspectBaseWrite(`${attach}\nО = ВнешниеОбработки.Создать(Имя);\nФ = О.ПолучитьФорму("Форма");`).writes).toBe(false)
    // Attaching alone runs nothing.
    expect(inspectBaseWrite(attach).writes).toBe(false)
  })
})

describe("what must NOT be taken for a write", () => {
  test("writing a макет to a file", () => {
    const code = `Макет = ПолучитьОбщийМакет("ПФ_MXL_СчетЗаказ");
Макет.Записать("C:\\\\out\\\\ПФ_MXL_СчетЗаказ.mxl", ТипФайлаТабличногоДокумента.MXL);`
    expect(inspectBaseWrite(code).writes).toBe(false)
  })

  test("writing a print form to PDF", () => {
    const code = `ПечатнаяФорма = ПечатьТорговыхДокументов.ПечатьСчетаНаОплату(Сведения, ОбъектыПечати, Параметры);
ПечатнаяФорма.Записать(ПутьPDF, ТипФайлаТабличногоДокумента.PDF);`
    expect(inspectBaseWrite(code).writes).toBe(false)
  })

  test("writing a text document", () => {
    const code = `Текст = Новый ТекстовыйДокумент;\nТекст.УстановитьТекст("x");\nТекст.Записать("C:\\\\out\\\\a.txt");`
    expect(inspectBaseWrite(code).writes).toBe(false)
  })

  test("a read-only query loop", () => {
    const code = `Выборка = Запрос.Выполнить().Выбрать();
Пока Выборка.Следующий() Цикл
\tРезультат = Результат + Строка(Выборка.Ссылка);
КонецЦикла;`
    expect(inspectBaseWrite(code).writes).toBe(false)
  })

  // Fetching an object to READ its attributes is common and harmless.
  test("getting an object without writing it", () => {
    const code = `Объ = Ссылка.ПолучитьОбъект();\nРезультат = Объ.Наименование;`
    expect(inspectBaseWrite(code).writes).toBe(false)
  })

  test("an empty body", () => {
    expect(inspectBaseWrite("").writes).toBe(false)
  })
})

// 2026-09-24. F9's second half, third occurrence: 09-20 §4, 09-21 §6.8, and
// 09-23 twice in one call. Verbatim shape from the 22:06 call. Neither element
// belonged to the task, both pre-dated the run, and for these two catalogs the
// stored text is what PRINTS -- so renaming one changes the output of every
// document still pointing at it, silently.
const THE_OVERWRITE = `РефЗаголовок = Справочники.ЗаголовкиСчетовПокупателям.НайтиПоНаименованию("Счет-договор");
Объ = РефЗаголовок.ПолучитьОбъект();
Объ.Наименование = "СЧЁТ-ДОГОВОР";
Объ.Записать();
РефУсловия = Справочники.ДополнительныеУсловия.НайтиПоНаименованию("Счет-оферта");
ОбъУсл = РефУсловия.ПолучитьОбъект();
ОбъУсл.Наименование = "Условия поставки (оферта) СЧЁТ-ДОГОВОР";
ОбъУсл.ТекстУсловий = НовыйТекст;
ОбъУсл.Записать();`

describe("changing an element it did not create", () => {
  test("both elements are recognised, by name", () => {
    const verdict = inspectOverwrite(THE_OVERWRITE)
    expect(verdict.overwrites).toBe(true)
    expect(verdict.elements).toEqual(["Счет-договор", "Счет-оферта"])
  })

  test("the chained one-expression form is recognised too", () => {
    const code = `Объ = Справочники.ДополнительныеУсловия.НайтиПоНаименованию("Типовые условия").ПолучитьОбъект();
Объ.ТекстУсловий = "…";
Объ.Записать();`
    expect(inspectOverwrite(code).overwrites).toBe(true)
  })

  // The whole point: creating must stay frictionless, or the guard teaches the
  // opposite of the lesson.
  test("creating a new element is not an overwrite", () => {
    const code = `Новый = Справочники.ДополнительныеУсловия.СоздатьЭлемент();
Новый.Наименование = "Условия поставки (оферта)";
Новый.ТекстУсловий = НовыйТекст;
Новый.Записать();`
    expect(inspectOverwrite(code).overwrites).toBe(false)
  })

  test("looking an element up to READ it is not an overwrite", () => {
    const code = `Реф = Справочники.ДополнительныеУсловия.НайтиПоНаименованию("Типовые условия");
Объ = Реф.ПолучитьОбъект();
Результат = Объ.ТекстУсловий;`
    expect(inspectOverwrite(code).overwrites).toBe(false)
  })

  // Pointing an organisation's default at a NEW element is the additive route
  // being recommended, so it must not itself be called an overwrite.
  test("setting the organisation default is not an overwrite of the catalog", () => {
    const code = `ОбъОрг = НайденнаяОрг.ПолучитьОбъект();
ОбъОрг.ДополнительныеУсловияПоУмолчанию = РефНовый;
ОбъОрг.Записать();`
    expect(inspectOverwrite(code).overwrites).toBe(false)
  })

  test("a mass document update is not reported as an element overwrite", () => {
    // It is still a write, and still needs approval -- but "create a new one
    // instead" is not an alternative there, so the advice must not appear.
    expect(inspectOverwrite(THE_WRITE).overwrites).toBe(false)
    expect(inspectBaseWrite(THE_WRITE).writes).toBe(true)
  })

  test("the refusal leads with the additive route and names the harm", () => {
    const text = overwriteRefusal(inspectOverwrite(THE_OVERWRITE))
    expect(text).toContain("«Счет-договор»")
    expect(text).toContain("СоздатьЭлемент()")
    expect(text).toContain("значение по умолчанию")
    expect(text).toContain("печатаются")
    expect(text).toContain("менять уже созданные документы")
    expect(text).toContain("allow_overwrite: true")
  })

  test("the ask names what changes before what it is", () => {
    const text = writeAskText(
      { summary: "s", objects: "o", count: 2, organisations: "Организация" },
      undefined,
      ["Счет-договор", "Счет-оферта"],
    )
    expect(text).toContain("ИЗМЕНЯЮТСЯ существующие элементы")
    expect(text.indexOf("ИЗМЕНЯЮТСЯ")).toBeLessThan(text.indexOf("Объекты:"))
  })

  test("nothing is said about overwriting when nothing is overwritten", () => {
    expect(writeAskText({ summary: "s", objects: "o", count: 1, organisations: "x" }, undefined, [])).not.toContain(
      "ИЗМЕНЯЮТСЯ",
    )
  })
})

describe("approvals", () => {
  test("are single use", () => {
    recordApproval("ses_1", THE_WRITE)
    expect(consumeApproval("ses_1", THE_WRITE)).toBe(true)
    expect(consumeApproval("ses_1", THE_WRITE)).toBe(false)
  })

  test("do not leak between sessions", () => {
    recordApproval("ses_1", THE_WRITE)
    expect(consumeApproval("ses_2", THE_WRITE)).toBe(false)
  })

  test("do not cover a different write", () => {
    recordApproval("ses_1", THE_WRITE)
    expect(consumeApproval("ses_1", THE_WRITE.replace("СЧЁТ-ДОГОВОР", "ЧТО-ТО ЕЩЁ"))).toBe(false)
  })

  // Reformatting between the ask and the run must not silently lose the grant;
  // anything else is a different decision.
  test("survive reformatting but not rewording", () => {
    recordApproval("ses_1", THE_WRITE)
    expect(consumeApproval("ses_1", THE_WRITE.replace(/\n/g, "\n  "))).toBe(true)
    expect(approvalKey("s", "А = 1;\n\tБ = 2;")).toBe(approvalKey("s", "А = 1; Б = 2;"))
  })
})

// 2026-09-24, observed live. The approved write was refused on retry because the
// agent had appended a verification section, so the text no longer matched the
// grant. It recovered in one turn by reasoning it out; the refusal should have
// told it.
describe("a grant for almost this code", () => {
  test("is recognised when a verification tail was appended", () => {
    recordApproval("ses_1", THE_WRITE)
    const withCheck = `${THE_WRITE}\nРезультат = "Обновлено: " + ЧислоОбновлено;`
    expect(consumeApproval("ses_1", withCheck)).toBe(false)
    expect(hasNearMissApproval("ses_1", withCheck)).toBe(true)
  })

  test("and when something was removed instead", () => {
    recordApproval("ses_1", THE_WRITE)
    expect(hasNearMissApproval("ses_1", THE_WRITE.slice(0, THE_WRITE.length - 40))).toBe(true)
  })

  // Two different writes that merely open with the same assignment must not be
  // treated as the same decision.
  test("a different write is not a near miss", () => {
    recordApproval("ses_1", THE_WRITE)
    expect(hasNearMissApproval("ses_1", "Объ = Ссылка.ПолучитьОбъект();\nОбъ.Записать();")).toBe(false)
  })

  test("nothing approved is not a near miss", () => {
    expect(hasNearMissApproval("ses_1", THE_WRITE)).toBe(false)
  })

  test("the message says where the check belongs", () => {
    const text = writeRefusal(inspectBaseWrite(THE_WRITE), undefined, true)
    expect(text).toContain("разрешение выдано на другой текст")
    expect(text).toContain("дописана проверка")
    expect(text).toContain("отдельным")
  })
})

describe("the refusal", () => {
  test("names the tool, the same code, and how to get the facts", () => {
    const text = writeRefusal(inspectBaseWrite(THE_WRITE))
    expect(text).toContain("1c_write_code")
    expect(text).toContain("тем же")
    expect(text).toContain("КОЛИЧЕСТВО(*)")
    expect(text).toContain("узнан слишком поздно")
    expect(text).toContain("до записи")
  })

  test("carries the bulk warning when there is one", () => {
    expect(writeRefusal(inspectBaseWrite(THE_WRITE), "ОСТОРОЖНО: выборка не ограничена")).toContain(
      "ОСТОРОЖНО: выборка не ограничена",
    )
  })
})

// Scale and scope are the two facts that were missing both times, so they are
// required arguments rather than something the summary might mention.
describe("what the user is shown", () => {
  test("leads with scale and scope", () => {
    const text = writeAskText({
      summary: "Переключить заголовок счёта на СЧЁТ-ДОГОВОР",
      objects: "Документ.СчетНаОплатуПокупателю",
      count: 8567,
      organisations: "все четыре",
    })
    expect(text).toContain("Сколько: 8567")
    expect(text).toContain("Организации: все четыре")
  })

  test("a missing count is refused before the user is bothered", () => {
    const gap = missingFacts({ summary: "x", objects: "y", organisations: "z" })
    expect(gap).toContain("count")
    expect(gap).toContain("КОЛИЧЕСТВО(*)")
  })

  test("nothing is missing when all four are given", () => {
    expect(missingFacts({ summary: "a", objects: "b", count: 0, organisations: "d" })).toBeNull()
  })
})

// 2026-09-25, skills_rebuild_plan.md 1.7. The overwrite guard was written
// against two БП catalogs; detection must be about the shape (found by name,
// then written), not about which catalog. Справочник.ВидыЦен is УТ 11.
describe("an overwrite in another configuration", () => {
  const code = `Объ = Справочники.ВидыЦен.НайтиПоНаименованию("Оптовая").ПолучитьОбъект();
Объ.Наименование = "Оптовая (новая)";
Объ.Записать();`

  test("is recognised", () => {
    const verdict = inspectOverwrite(code)
    expect(verdict.overwrites).toBe(true)
    expect(verdict.elements).toEqual(["Оптовая"])
  })

  test("is refused without naming БП objects", () => {
    const text = overwriteRefusal(inspectOverwrite(code))
    expect(text).toContain("СоздатьЭлемент()")
    expect(text).not.toContain("Счет")
    expect(text).not.toContain("ПоУмолчанию`")
  })
})

// debrief15.md §15.18: with writes allowed in the profile, the journal said
// «Объекты: не указано» for every entry of a run.
describe("what a write names, for the journal", () => {
  test("each manager access becomes Kind.Name, once, in order", () => {
    const code =
      "Э = Справочники.ДополнительныеОтчетыИОбработки.СоздатьЭлемент();\n" +
      "Ид = ОбщегоНазначения.ИдентификаторОбъектаМетаданных(Метаданные.Документы.ПриемНаРаботу);\n" +
      "Набор = РегистрыСведений.НазначениеДополнительныхОбработок.СоздатьНаборЗаписей();\n" +
      "Э2 = Справочники.ДополнительныеОтчетыИОбработки.НайтиПоНаименованию(\"x\");"
    expect(writeTargets(code)).toEqual([
      "Справочник.ДополнительныеОтчетыИОбработки",
      "РегистрСведений.НазначениеДополнительныхОбработок",
    ])
  })

  test("metadata access is not a manager, and code that names none gives nothing", () => {
    expect(writeTargets("Х = Метаданные.Справочники.Номенклатура;")).toEqual([])
    expect(writeTargets("Объект.Записать();")).toEqual([])
  })
})
