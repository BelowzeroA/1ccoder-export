import { describe, expect, test } from "bun:test"

import { EXTERNAL_CLASS_IDS, externalKind, externalSkeleton } from "./external-skeleton"

// debrief16.md §16.3 item 1. The shape below is the one built on a scratch base
// (8.5.1): both trees loaded into NEW files, and the report composed with its
// starter schema -- the parameter, the grouping, the nested detail records, the
// total, and a column 15 wide from МинимальнаяШирина.

let counter = 0
const ids = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`

describe("the source tree of a new external object", () => {
  test("a report has the report class id, its main schema and a starter schema", () => {
    const files = externalSkeleton("report", { name: "Прибыль", synonym: "Прибыль <по> заказам" }, ids)
    expect(Object.keys(files).sort()).toEqual([
      "Прибыль.xml",
      "Прибыль/Ext/ObjectModule.bsl",
      "Прибыль/Templates/ОсновнаяСхемаКомпоновкиДанных.xml",
      "Прибыль/Templates/ОсновнаяСхемаКомпоновкиДанных/Ext/Template.xml",
    ])
    const root = files["Прибыль.xml"]!
    expect(root).toContain(`<xr:ClassId>${EXTERNAL_CLASS_IDS.report}</xr:ClassId>`)
    expect(root).toContain('<xr:GeneratedType name="ExternalReportObject.Прибыль" category="Object">')
    expect(root).toContain(
      "<MainDataCompositionSchema>ExternalReport.Прибыль.Template.ОсновнаяСхемаКомпоновкиДанных</MainDataCompositionSchema>",
    )
    expect(root).toContain("Прибыль &lt;по&gt; заказам")
    expect(files["Прибыль/Templates/ОсновнаяСхемаКомпоновкиДанных.xml"]).toContain(
      "<TemplateType>DataCompositionSchema</TemplateType>",
    )
    const schema = files["Прибыль/Templates/ОсновнаяСхемаКомпоновкиДанных/Ext/Template.xml"]!
    expect(schema).toContain("<dataSource>ИсточникДанных1</dataSource>")
    expect(schema).toContain("<denyIncompleteValues>true</denyIncompleteValues>")
    expect(schema).toContain("МинимальнаяШирина")
  })

  test("a processor has the processor class id and no template", () => {
    const files = externalSkeleton("processor", { name: "Обработка1" }, ids)
    expect(Object.keys(files).sort()).toEqual(["Обработка1.xml", "Обработка1/Ext/ObjectModule.bsl"])
    expect(files["Обработка1.xml"]).toContain(`<xr:ClassId>${EXTERNAL_CLASS_IDS.processor}</xr:ClassId>`)
    expect(files["Обработка1.xml"]).toContain("ExternalDataProcessorObject.Обработка1")
  })

  // debrief18.md: built on a scratch base (8.5.1) into a new .epf, the form
  // opening with its «Выполнить» button.
  test("a processor with a form: a name in ChildObjects, metadata, layout and module in the dump's places", () => {
    const files = externalSkeleton("processor", { name: "Загрузка", form: true }, ids)
    expect(Object.keys(files).sort()).toEqual([
      "Загрузка.xml",
      "Загрузка/Ext/ObjectModule.bsl",
      "Загрузка/Forms/Форма.xml",
      "Загрузка/Forms/Форма/Ext/Form.xml",
      "Загрузка/Forms/Форма/Ext/Form/Module.bsl",
    ])
    const root = files["Загрузка.xml"]!
    expect(root).toContain("<DefaultForm>ExternalDataProcessor.Загрузка.Form.Форма</DefaultForm>")
    expect(root).toContain("<ChildObjects>\n\t\t\t<Form>Форма</Form>\n\t\t</ChildObjects>")
    expect(files["Загрузка/Forms/Форма.xml"]).toContain("<FormType>Managed</FormType>")
    expect(files["Загрузка/Forms/Форма/Ext/Form.xml"]).toContain("<v8:Type>cfg:ExternalDataProcessorObject.Загрузка</v8:Type>")
    expect(files["Загрузка/Forms/Форма/Ext/Form/Module.bsl"]).toContain("Процедура КомандаВыполнить(Команда)")
    // Without the option nothing changes.
    expect(externalSkeleton("processor", { name: "Загрузка" }, ids)["Загрузка.xml"]).toContain("<ChildObjects/>")
  })

  test("the kind is read back from the root element", () => {
    expect(externalKind(externalSkeleton("report", { name: "О" }, ids)["О.xml"]!)).toBe("report")
    expect(externalKind(externalSkeleton("processor", { name: "О" }, ids)["О.xml"]!)).toBe("processor")
    expect(externalKind("<MetaDataObject><Configuration/></MetaDataObject>")).toBeNull()
  })
})
