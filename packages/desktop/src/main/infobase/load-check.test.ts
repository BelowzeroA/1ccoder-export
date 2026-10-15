import { describe, expect, test } from "bun:test"

import {
  commandModuleFinding,
  droppedParts,
  FORM_ELEMENT_TAGS,
  nearestTag,
  undeclaredPrefixes,
  unknownFormTags,
} from "./load-check"

// debrief14.md §14.5.

describe("skipped parts in the configurator's output", () => {
  test("the observed messages are found, each once", () => {
    const skipped =
      "Файл - Подсистема.xml: ошибка формата документа - объект метаданных Command не был загружен поскольку не является подчиненным для объекта Subsystem."
    expect(droppedParts([skipped, skipped, skipped].join("\n"))).toEqual([skipped])
    expect(
      droppedParts("Неверное свойство объекта метаданных. Свойство Placement не входит в состав объекта метаданных CommonCommand. - Placement"),
    ).toHaveLength(1)
  })

  test("the informational lines of a clean load are not", () => {
    const clean = [
      "Загрузка внешней обработки или отчета из XML.",
      "Корневой файл выгрузки: C:\\w\\src\\Обработка.xml",
      "Целевой каталог или файл: C:\\w\\Обработка.epf",
      "Загрузка завершена. Суммарное время выполнения операции: 12190 миллисекунд.",
      "Загрузка конфигурации успешно завершена",
    ].join("\r\n")
    expect(droppedParts(clean)).toEqual([])
  })
})

describe("form element tags", () => {
  test("a case slip is caught and corrected", () => {
    const xml = `<Form><ChildItems><SpreadsheetDocumentField name="Результат" id="5"/></ChildItems></Form>`
    expect(unknownFormTags(xml)).toEqual([{ tag: "SpreadsheetDocumentField", name: "Результат", suggestion: "SpreadSheetDocumentField" }])
  })

  test("only direct children of ChildItems are elements; their properties are not", () => {
    const xml =
      `<Form><Events><Event name="OnOpen">ПриОткрытии</Event></Events><ChildItems>` +
      `<UsualGroup name="Группа" id="1"><Title><v8:item/></Title><ContextMenu name="М" id="2"/>` +
      `<ExtendedTooltip name="П" id="3"/><ChildItems><InputField name="Поле" id="4"><DataPath>Объект.Поле</DataPath>` +
      `</InputField></ChildItems></UsualGroup></ChildItems></Form>`
    expect(unknownFormTags(xml)).toEqual([])
  })

  test("comments, CDATA and namespace prefixes don't confuse it", () => {
    const xml =
      `<?xml version="1.0"?><f:Form xmlns:f="x"><!-- <ChildItems><Bogus/></ChildItems> -->` +
      `<f:ChildItems><f:Buton name="Кнопка" id="1"/><![CDATA[<Bogus/>]]></f:ChildItems></f:Form>`
    expect(unknownFormTags(xml)).toEqual([{ tag: "Buton", name: "Кнопка", suggestion: "Button" }])
  })

  test("an unknown tag far from every known one has no suggestion", () => {
    expect(nearestTag("HologramField")).toBeUndefined()
    // The platform elements the dumps don't use must not be "corrected" into others.
    for (const tag of ["DendrogramField", "GeographicalSchemaField", "ViewStatusAddition"]) {
      expect(FORM_ELEMENT_TAGS.has(tag)).toBe(true)
    }
  })

  test("no two known tags are near misses of each other", () => {
    // Otherwise a correct tag could never be told from a slip of its neighbour.
    for (const tag of FORM_ELEMENT_TAGS) {
      const others = new Set([...FORM_ELEMENT_TAGS].filter((other) => other !== tag))
      const near = [...others].filter((other) => nearestTag(other) === tag && other.toLowerCase() !== tag.toLowerCase())
      expect({ tag, near }).toEqual({ tag, near: [] })
    }
  })
})

describe("command modules", () => {
  const standard = `&НаКлиенте
Процедура ОбработкаКоманды(ПараметрКоманды, ПараметрыВыполненияКоманды)
	ОткрытьФорму("Документ.Имя.ФормаСписка");
КонецПроцедуры`

  test("the standard handler passes", () => {
    expect(commandModuleFinding(standard)).toBeNull()
    expect(commandModuleFinding(standard.replace("&НаКлиенте", "&AtClient").replace("Процедура ОбработкаКоманды", "Procedure CommandProcessing"))).toBeNull()
  })

  test("a handler under another name is no handler", () => {
    expect(commandModuleFinding(standard.replace("ОбработкаКоманды(", "ОбработчикКоманды("))).toEqual({ kind: "no-handler" })
  })

  test("a commented-out handler is no handler", () => {
    const commented = `// Процедура ОбработкаКоманды(А, Б)\nПроцедура Другая()\nКонецПроцедуры`
    expect(commandModuleFinding(commented)).toEqual({ kind: "no-handler" })
  })

  test("an empty module is left alone: standard configurations keep them for obsolete commands", () => {
    expect(commandModuleFinding("")).toBeNull()
    expect(commandModuleFinding("// устарела\n")).toBeNull()
  })

  test("an extension intercepting the handler counts as having one", () => {
    const intercepted = `&НаКлиенте\n&Вместо("ОбработкаКоманды")\nПроцедура Расш_ОбработкаКоманды(П, ПВ)\nКонецПроцедуры`
    expect(commandModuleFinding(intercepted)).toBeNull()
  })

  test("a handler unlike the standard one is reported, not refused", () => {
    expect(commandModuleFinding(standard.replace("&НаКлиенте\n", ""))).toEqual({ kind: "unusual", directive: "", parameters: 2 })
    expect(commandModuleFinding(standard.replace(", ПараметрыВыполненияКоманды", ""))).toEqual({
      kind: "unusual",
      directive: "&НаКлиенте",
      parameters: 1,
    })
  })
})

// debrief14.md §14.5: «Исключение XDTO … Template.xml», bisected over several
// loads to a `cfg:` type in a schema that never declared the prefix.
describe("namespace prefixes", () => {
  const schema = (root: string, body: string) =>
    `<?xml version="1.0"?><DataCompositionSchema xmlns="http://v8.1c.ru/8.1/data-composition-system/schema" ${root}>${body}</DataCompositionSchema>`
  const typed = '<parameter><valueType><v8:Type>cfg:EnumRef.Виды</v8:Type></valueType></parameter>'

  test("a type value with an undeclared prefix is found", () => {
    expect(undeclaredPrefixes(schema('xmlns:v8="http://v8.1c.ru/8.1/data/core"', typed))).toEqual(["cfg"])
  })

  test("declared, it passes -- at the root or on the element itself", () => {
    expect(undeclaredPrefixes(schema('xmlns:v8="a" xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config"', typed))).toEqual([])
    expect(
      undeclaredPrefixes(schema('xmlns:v8="a"', '<v8:Type xmlns:d5p1="x">d5p1:CatalogRef.Имя</v8:Type>')),
    ).toEqual([])
  })

  test("element names, attribute names and xsi:type count; text elsewhere doesn't", () => {
    expect(undeclaredPrefixes('<a xmlns:x="1"><y:b/></a>')).toEqual(["y"])
    expect(undeclaredPrefixes('<a xmlns:x="1" z:attr="2"/>')).toEqual(["z"])
    expect(undeclaredPrefixes('<a xmlns:xsi="i"><b xsi:type="q:Name"/></a>')).toEqual(["q"])
    expect(undeclaredPrefixes("<a><Comment>см. http://example.com и Время: 10:00</Comment></a>")).toEqual([])
  })
})
