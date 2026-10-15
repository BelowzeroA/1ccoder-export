import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { describeDumpObject } from "./dump-object"

// debrief15.md §15.24 item 34: nine PowerShell calls to read one document's
// attributes from the dump. Shaped on calc_conf\Documents\ПриемНаРаботу.xml:
// tab-indented, CRLF, an attribute of the same tag inside a tabular section.
const attribute = (tabs: number, name: string, synonym: string, type: string) =>
  [
    `${"\t".repeat(tabs)}<Attribute uuid="u-${name}">`,
    `${"\t".repeat(tabs + 1)}<Properties>`,
    `${"\t".repeat(tabs + 2)}<Name>${name}</Name>`,
    `${"\t".repeat(tabs + 2)}<Synonym>`,
    `${"\t".repeat(tabs + 3)}<v8:item>`,
    `${"\t".repeat(tabs + 4)}<v8:lang>ru</v8:lang>`,
    `${"\t".repeat(tabs + 4)}<v8:content>${synonym}</v8:content>`,
    `${"\t".repeat(tabs + 3)}</v8:item>`,
    `${"\t".repeat(tabs + 2)}</Synonym>`,
    `${"\t".repeat(tabs + 2)}<Type>`,
    ...type.split("\n").map((line) => `${"\t".repeat(tabs + 3)}${line}`),
    `${"\t".repeat(tabs + 2)}</Type>`,
    `${"\t".repeat(tabs + 1)}</Properties>`,
    `${"\t".repeat(tabs)}</Attribute>`,
  ].join("\n")

const DOCUMENT = [
  '\uFEFF<?xml version="1.0" encoding="UTF-8"?>',
  '<MetaDataObject xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:v8="http://v8.1c.ru/8.1/data/core" version="2.21">',
  '\t<Document uuid="d">',
  "\t\t<Properties>",
  "\t\t\t<Name>ПриемНаРаботу</Name>",
  "\t\t\t<Synonym>",
  "\t\t\t\t<v8:item>",
  "\t\t\t\t\t<v8:lang>ru</v8:lang>",
  "\t\t\t\t\t<v8:content>Прием на работу</v8:content>",
  "\t\t\t\t</v8:item>",
  "\t\t\t</Synonym>",
  "\t\t</Properties>",
  "\t\t<ChildObjects>",
  attribute(3, "Сотрудник", "Сотрудник", "<v8:Type>cfg:CatalogRef.Сотрудники</v8:Type>"),
  attribute(3, "ДатаПриема", "Дата приема", "<v8:Type>xs:dateTime</v8:Type>\n<v8:DateQualifiers>\n\t<v8:DateFractions>Date</v8:DateFractions>\n</v8:DateQualifiers>"),
  attribute(3, "УсловияПриема", "Условия приема", "<v8:Type>xs:string</v8:Type>\n<v8:StringQualifiers>\n\t<v8:Length>0</v8:Length>\n</v8:StringQualifiers>"),
  "\t\t\t<Form>ФормаДокумента</Form>",
  '\t\t\t<TabularSection uuid="t">',
  "\t\t\t\t<Properties>",
  "\t\t\t\t\t<Name>Начисления</Name>",
  "\t\t\t\t</Properties>",
  "\t\t\t\t<ChildObjects>",
  attribute(5, "Размер", "Размер", "<v8:Type>xs:decimal</v8:Type>\n<v8:NumberQualifiers>\n\t<v8:Digits>15</v8:Digits>\n\t<v8:FractionDigits>2</v8:FractionDigits>\n</v8:NumberQualifiers>"),
  "\t\t\t\t</ChildObjects>",
  "\t\t\t</TabularSection>",
  "\t\t\t<Template>ПФ_MXL_Т1</Template>",
  "\t\t</ChildObjects>",
  "\t</Document>",
  "</MetaDataObject>",
].join("\r\n")

const ROOT = "C:/dump"
const files: Record<string, string> = {
  [join(ROOT, "Documents", "ПриемНаРаботу.xml")]: DOCUMENT,
  [join(ROOT, "Documents", "ПриемНаРаботу", "Ext", "ManagerModule.bsl")]: "a\nb\nc",
}
const reader = {
  readText: (path: string) => files[path] ?? null,
  list: (dir: string) => (dir === join(ROOT, "Documents") ? ["ПриемНаРаботу.xml", "ПриемНаРаботуСписком.xml", "Увольнение.xml"] : null),
}

describe("an object's make-up from the dump", () => {
  test("attributes with types as code reads them, tabular sections apart, forms, templates, modules", () => {
    const text = describeDumpObject(ROOT, "Документ.ПриемНаРаботу", reader)
    expect(text).toContain("Документ.ПриемНаРаботу «Прием на работу»")
    expect(text).toContain("Реквизиты (3):")
    expect(text).toContain("- Сотрудник: CatalogRef.Сотрудники")
    expect(text).toContain("- ДатаПриема «Дата приема»: Дата")
    expect(text).toContain("- УсловияПриема «Условия приема»: Строка(неогр.)")
    // The section's own attribute is not counted among the document's.
    expect(text).toContain("Табличные части (1):\n- Начисления:\n  - Размер: Число(15,2)")
    expect(text).toContain("Формы: ФормаДокумента")
    expect(text).toContain("Макеты: ПФ_MXL_Т1")
    expect(text).toContain("ManagerModule.bsl (3 стр.)")
  })

  test("the plural and English kinds name the same object", () => {
    expect(describeDumpObject(ROOT, "Документы.ПриемНаРаботу", reader)).toContain("Реквизиты (3):")
    expect(describeDumpObject(ROOT, "Document.ПриемНаРаботу", reader)).toContain("Реквизиты (3):")
  })

  test("a name not in the dump gets the near ones; a name without a kind is explained", () => {
    expect(describeDumpObject(ROOT, "Документ.ПриемНаРабо", reader)).toContain("Похожие: ПриемНаРаботу, ПриемНаРаботуСписком.")
    expect(describeDumpObject(ROOT, "ПриемНаРаботу", reader)).toContain("Нужно «Вид.Имя»")
  })
})
