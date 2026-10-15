import { describe, expect, test } from "bun:test"

import { findFormModule, replaceFormModule, unboundEventHandlers } from "./form-module"

/**
 * A form description in miniature: braces, commas and quoted values, with the
 * module as one of them. The shape is what matters here, not the field names --
 * nothing in the implementation parses the description.
 */
function form(module: string, extra = ""): Buffer {
  const escaped = module.replace(/"/g, '""')
  return Buffer.from(`{1,\n{0,"Форма",${extra}"ru"},\n{2,"${escaped}"},0\n}`, "utf8")
}

const MODULE = ["&НаКлиенте", "Процедура Выполнить(Команда)", '\tСообщить("готово");', "КонецПроцедуры", ""].join("\n")

describe("finding the module in a form description", () => {
  test("returns the text with its escaping undone", () => {
    const found = findFormModule(form(MODULE))
    expect(found?.text).toBe(MODULE)
  })

  // The reference Python implementation looked for a string starting with a
  // directive, so a module opening with Перем was invisible to it -- and that
  // is how the one module in Загрузка спецификаций stayed unreachable.
  test("finds a module that opens with Перем, not a directive", () => {
    const module = ["Перем Host;", "", "&НаСервере", "Процедура Загрузить()", "КонецПроцедуры", ""].join("\n")
    expect(findFormModule(form(module))?.text).toBe(module)
  })

  test("finds one that opens with a comment", () => {
    const module = ["// Заголовок", "Функция Прочитать()", "\tВозврат 1;", "КонецФункции", ""].join("\n")
    expect(findFormModule(form(module))?.text).toBe(module)
  })

  // Descriptions are full of short literals, and a caption reading "Процедура"
  // must not be mistaken for a program.
  test("ignores short strings that merely look like code", () => {
    expect(findFormModule(Buffer.from('{1,"Процедура","Функция",0}', "utf8"))).toBeNull()
  })

  test("prefers the longest candidate, since a module may quote BSL itself", () => {
    const decoy = ["&НаКлиенте", "Процедура Мелочь()", "КонецПроцедуры", ""].join("\n")
    const found = findFormModule(form(MODULE, `"${decoy.replace(/"/g, '""')}",`))
    expect(found?.text).toBe(MODULE.length > decoy.length ? MODULE : decoy)
    expect(found!.text.length).toBeGreaterThanOrEqual(decoy.length)
  })

  test("declines an entry that is not text", () => {
    expect(findFormModule(Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x02]))).toBeNull()
  })

  test("declines a description with no module in it", () => {
    expect(findFormModule(Buffer.from('{1,{0,"Форма","ru"},0}', "utf8"))).toBeNull()
  })

  test("does not run off the end of an unterminated string", () => {
    expect(findFormModule(Buffer.from('{1,"&НаКлиенте Процедура Выполнить() КонецПроцедуры', "utf8"))).toBeNull()
  })
})

describe("putting the module back", () => {
  // The guarantee the whole feature rests on: only the module moves.
  test("writing back what was read changes nothing at all", () => {
    const original = form(MODULE)
    const found = findFormModule(original)!
    expect(replaceFormModule(original, Buffer.from(found.text, "utf8"))!.equals(original)).toBe(true)
  })

  test("an edit lands and survives a second read", () => {
    const original = form(MODULE)
    const next = `${MODULE}\n&НаСервере\nПроцедура Ещё()\nКонецПроцедуры\n`
    const spliced = replaceFormModule(original, Buffer.from(next, "utf8"))!
    expect(findFormModule(spliced)?.text).toBe(next)
  })

  test("quotes in the new module are escaped, not left to end the string", () => {
    const next = `${MODULE}\nПроцедура Ещё()\n\tСообщить("кавычки");\nКонецПроцедуры\n`
    const spliced = replaceFormModule(form(MODULE), Buffer.from(next, "utf8"))!
    expect(findFormModule(spliced)?.text).toBe(next)
    expect(spliced.toString("utf8")).toContain('""кавычки""')
  })

  test("everything around the module is preserved byte for byte", () => {
    const original = form(MODULE, '"соседнее значение",')
    const spliced = replaceFormModule(original, Buffer.from(`${MODULE}\n`, "utf8"))!
    expect(spliced.toString("utf8")).toContain('"соседнее значение"')
    expect(spliced.toString("utf8").startsWith("{1,\n")).toBe(true)
  })

  // A BOM belongs to the entry, not to a value inside it. An editor that adds
  // one to the .bsl must not plant it in the middle of the description.
  test("a BOM on the edited module is not carried inside", () => {
    const spliced = replaceFormModule(form(MODULE), Buffer.from(`﻿${MODULE}`, "utf8"))!
    expect(findFormModule(spliced)?.text).toBe(MODULE)
  })

  test("refuses when the description no longer holds a module", () => {
    expect(replaceFormModule(Buffer.from('{1,"Форма",0}', "utf8"), Buffer.from(MODULE, "utf8"))).toBeNull()
  })
})

// debrief13.md §13.12. The event table's shape is taken from real forms (the
// toolkit's): `{N,<event uuid>,"<procedure>",…}`.
describe("event handlers the form does not bind", () => {
  const onCreate = "9f2e5ddb-3492-4f5d-8f0d-416b8d1d5c5b"
  const module = '&НаСервере\nПроцедура ПриСозданииНаСервере(Отказ, СтандартнаяОбработка)\n\tЗапись = "x";\nКонецПроцедуры\n'

  test("a handler with no entry in the event table is reported", () => {
    expect(unboundEventHandlers(form(module), Buffer.from(module))).toEqual(["ПриСозданииНаСервере"])
  })

  test("a handler the table binds is not", () => {
    const bound = form(module, `{1,${onCreate},"ПриСозданииНаСервере",1},`)
    expect(unboundEventHandlers(bound, Buffer.from(module))).toEqual([])
  })

  test("the module text inside the description does not count as a binding", () => {
    const quoted = '&НаСервере\nПроцедура ПриСозданииНаСервере(Отказ, СтандартнаяОбработка)\n\tИмя = "ПриСозданииНаСервере";\nКонецПроцедуры\n'
    expect(unboundEventHandlers(form(quoted), Buffer.from(quoted))).toEqual(["ПриСозданииНаСервере"])
  })

  test("procedures that are not form events are not its business", () => {
    const plain = "&НаСервере\nПроцедура ВыполнитьНаСервере()\nКонецПроцедуры\n"
    expect(unboundEventHandlers(form(plain), Buffer.from(plain))).toEqual([])
  })
})
