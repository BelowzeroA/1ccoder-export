import { describe, expect, test } from "bun:test"

import { describeMxlTemplate, hidingMerge, mergeTailRows, parseMxlTemplate } from "./mxl"

// 2026-09-23, debrief9.md §9.8 / G7. The fixture is the shape of the real
// ПФ_MXL_СчетЗаказ around its heading, with the numbers this parser was checked
// against: the live object model reports the Заголовок area as rows 23..26 and
// the table height as 121, and the file's merge block puts a 2×32 cell at
// 0-based row 22 column 1. 1-based row 24 is therefore the lower half of the
// title cell -- which is why writing into it printed the heading vertically, one
// character per line, and which no runtime property exposes.
const TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<document>
\t<format>
\t\t<width>8</width>
\t</format>
\t<format>
\t\t<height>28</height>
\t</format>
\t<format>
\t\t<bottomBorder>2</bottomBorder>
\t</format>
\t<rowsItem>
\t\t<index>20</index>
\t\t<indexTo>21</indexTo>
\t\t<row>
\t\t\t<empty>true</empty>
\t\t</row>
\t</rowsItem>
\t<rowsItem>
\t\t<index>22</index>
\t\t<row>
\t\t\t<c>
\t\t\t\t<i>1</i>
\t\t\t\t<c>
\t\t\t\t\t<f>1</f>
\t\t\t\t\t<parameter>ТекстЗаголовка</parameter>
\t\t\t\t</c>
\t\t\t</c>
\t\t</row>
\t</rowsItem>
\t<rowsItem>
\t\t<index>23</index>
\t\t<row>
\t\t\t<empty>true</empty>
\t\t</row>
\t</rowsItem>
\t<rowsItem>
\t\t<index>24</index>
\t\t<row>
\t\t\t<formatIndex>3</formatIndex>
\t\t\t<c>
\t\t\t\t<i>1</i>
\t\t\t\t<c>
\t\t\t\t\t<f>1</f>
\t\t\t\t</c>
\t\t\t</c>
\t\t</row>
\t</rowsItem>
\t<namedItem xsi:type="NamedItemCells">
\t\t<name>Заголовок</name>
\t\t<area>
\t\t\t<type>Rows</type>
\t\t\t<beginRow>22</beginRow>
\t\t\t<endRow>25</endRow>
\t\t\t<beginColumn>-1</beginColumn>
\t\t\t<endColumn>-1</endColumn>
\t\t</area>
\t</namedItem>
\t<merge>
\t\t<r>22</r>
\t\t<c>1</c>
\t\t<h>1</h>
\t\t<w>31</w>
\t</merge>
</document>`

describe("coordinates", () => {
  // The 0-based XML against the 1-based runtime is itself a recorded failure
  // (debrief6 §5, debrief7 §6.4), so the tool only ever speaks 1-based.
  test("areas are reported the way the runtime reports them", () => {
    const area = parseMxlTemplate(TEMPLATE).areas.find((item) => item.name === "Заголовок")!
    expect(area.firstRow).toBe(23)
    expect(area.lastRow).toBe(26)
  })

  test("a -1 bound means all, not row zero", () => {
    const area = parseMxlTemplate(TEMPLATE).areas.find((item) => item.name === "Заголовок")!
    expect(area.firstColumn).toBeNull()
    expect(area.lastColumn).toBeNull()
  })

  // This is what the hand-rolled pass got wrong: one <rowsItem> is not one row.
  // Ignoring <indexTo> is why its row numbering drifted from the real макет.
  test("an indexTo range expands to every row it covers", () => {
    const rows = parseMxlTemplate(TEMPLATE).rows
    expect(rows.map((row) => row.index)).toEqual([21, 22, 23, 24, 25])
  })
})

describe("the fact the object model cannot answer", () => {
  test("a row inside a vertical merge is named as a continuation", () => {
    expect(mergeTailRows(parseMxlTemplate(TEMPLATE)).get(24)).toBe(23)
  })

  test("the anchor row itself is not a continuation", () => {
    expect(mergeTailRows(parseMxlTemplate(TEMPLATE)).get(23)).toBeUndefined()
  })

  test("size is (h+1) rows by (w+1) columns, per the platform's own spec", () => {
    const merge = parseMxlTemplate(TEMPLATE).merges.find((item) => item.row === 23)!
    expect(merge.rows).toBe(2)
    expect(merge.columns).toBe(32)
    expect(merge.column).toBe(2)
  })

  test("the report warns before it describes", () => {
    const text = describeMxlTemplate(parseMxlTemplate(TEMPLATE), "Заголовок")
    expect(text).toContain("строка 24: **продолжение ячейки из строки 23**")
    expect(text).toContain("объединение сломается")
  })
})

describe("heights", () => {
  // Three states, and the middle one is easy to misread: a format that sets only
  // a border gives the row a formatIndex and still no height.
  test("a row with no format is distinguished from one whose format sets no height", () => {
    const text = describeMxlTemplate(parseMxlTemplate(TEMPLATE), "Заголовок")
    expect(text).toContain("строка 24: **продолжение")
    expect(text).toContain("нет формата, а значит и своей высоты")
    expect(text).toContain("высота в нём не задана")
  })

  test("the palette is indexed by position", () => {
    expect(parseMxlTemplate(TEMPLATE).formatHeights).toEqual([null, 28, null])
  })

  // debrief15.md §15.13: cell text is stored in <tl>, and was read as <text>, so
  // no caption was ever shown.
  test("a cell's text is read from <tl>, the Russian one first", () => {
    const withText = TEMPLATE.replace(
      "\t\t\t\t\t<parameter>ТекстЗаголовка</parameter>",
      "\t\t\t\t\t<tl>\n\t\t\t\t\t\t<v8:item>\n\t\t\t\t\t\t\t<v8:lang>en</v8:lang>\n\t\t\t\t\t\t\t<v8:content>Hire</v8:content>\n\t\t\t\t\t\t</v8:item>\n" +
        "\t\t\t\t\t\t<v8:item>\n\t\t\t\t\t\t\t<v8:lang>ru</v8:lang>\n\t\t\t\t\t\t\t<v8:content>Принять &amp; оформить</v8:content>\n\t\t\t\t\t\t</v8:item>\n\t\t\t\t\t</tl>",
    )
    const row = parseMxlTemplate(withText).rows.find((item) => item.index === 23)
    expect(row?.cells).toEqual([{ column: 2, text: "Принять & оформить", format: 1 }])
  })

  // debrief15.md §15.12: the palette is 1-based and 0 is "no format" (spec). Read
  // 0-based, every height came from the neighbouring format.
  test("a row's formatIndex counts the palette from one", () => {
    const row = (index: string) =>
      TEMPLATE.replace("\t\t\t<formatIndex>3</formatIndex>", `\t\t\t<formatIndex>${index}</formatIndex>`)
    expect(parseMxlTemplate(row("2")).rows.find((item) => item.index === 25)?.height).toBe(28)
    expect(parseMxlTemplate(row("0")).rows.find((item) => item.index === 25)?.formatIndex).toBeNull()
  })
})

// 2026-09-24. The run that first used this tool took the merges from it and then
// spent seven minutes in PowerShell after the title's font, because the title
// cell's format carries only `<height>28</height>`. Per the spec one palette
// serves cell, row, column and document default, so an unspecified font is
// inherited, not absent -- and the runtime is what resolves that.
describe("fonts", () => {
  const WITH_FONTS = TEMPLATE.replace(
    "\t<format>",
    '\t<font faceName="Arial" height="9" bold="false" italic="false"/>\n' +
      '\t<font faceName="Arial" height="14.3" bold="true" italic="false"/>\n' +
      "\t<format>",
  )

  test("the palette is listed in file order", () => {
    expect(parseMxlTemplate(WITH_FONTS).fonts).toEqual(["Arial 9", "Arial 14.3 bold"])
  })

  test("the report says the palette is not a per-cell mapping", () => {
    const text = describeMxlTemplate(parseMxlTemplate(WITH_FONTS))
    expect(text).toContain("Это палитра, а не соответствие ячейкам")
    expect(text).toContain("наследуется")
  })

  // The point of the section: send the agent to the call that works, with the
  // two property names that cost it three failed attempts.
  test("it points at the object model for effective formatting", () => {
    const text = describeMxlTemplate(parseMxlTemplate(WITH_FONTS))
    expect(text).toContain("Ячейка.Шрифт.Имя")
    expect(text).toContain("Шрифт.Наклонный")
    expect(text).toContain("ГраницаСнизу")
  })

  test("a макет with no font palette says nothing about fonts", () => {
    expect(describeMxlTemplate(parseMxlTemplate(TEMPLATE))).not.toContain("## Шрифты")
  })
})

describe("cells", () => {
  test("a parameter is reported with its 1-based column", () => {
    const row = parseMxlTemplate(TEMPLATE).rows.find((item) => item.index === 23)!
    expect(row.cells).toEqual([{ column: 2, parameter: "ТекстЗаголовка", format: 1 }])
  })
})

describe("when the area does not exist", () => {
  test("the answer lists the ones that do, rather than nothing", () => {
    const text = describeMxlTemplate(parseMxlTemplate(TEMPLATE), "Подвал")
    expect(text).toContain("не найдена")
    expect(text).toContain("Заголовок")
  })
})

// <verticalUnmerge> cancels a merge for one row. Reporting it as merged anyway
// would manufacture exactly the kind of false belief this tool exists to stop.
describe("cancelled merges", () => {
  test("a row whose merge was cancelled is not called a continuation", () => {
    const withUnmerge = TEMPLATE.replace(
      "</document>",
      "\t<verticalUnmerge>\n\t\t<r>22</r>\n\t\t<c>1</c>\n\t\t<w>31</w>\n\t</verticalUnmerge>\n</document>",
    )
    expect(mergeTailRows(parseMxlTemplate(withUnmerge)).get(24)).toBeUndefined()
  })
})

// debrief15.md §15.14 items 1–2 and §15.18: the report named a format by number
// only, said nothing of a cell written twice, and nothing of a cell a merge hid.
describe("what the report says about formats and damage", () => {
  test("each cell shows its format, and each format shown is described, borders and all", () => {
    const withBorder = TEMPLATE.replace("\t<rowsItem>", '\t<line width="1" gap="false">\n\t\t<v8ui:style xsi:type="v8ui:SpreadsheetDocumentCellLineType">Solid</v8ui:style>\n\t</line>\n\t<rowsItem>')
    const text = describeMxlTemplate(parseMxlTemplate(withBorder.replace("<f>1</f>\n\t\t\t\t\t<parameter>", "<f>3</f>\n\t\t\t\t\t<parameter>")))
    expect(text).toContain("кол.2 [ф3]: <ТекстЗаголовка>")
    expect(text).toContain("## Форматы ячеек выше")
    expect(text).toContain("- ф3: границы: снизу линия 2; заполнение Text")
  })

  test("a line the palette has is named", () => {
    const withLines = TEMPLATE.replace(
      "\t<rowsItem>",
      '\t<line width="2" gap="false">\n\t\t<v8ui:style xsi:type="v8ui:SpreadsheetDocumentCellLineType">Solid</v8ui:style>\n\t</line>\n' +
        '\t<line width="0" gap="false">\n\t\t<v8ui:style xsi:type="v8ui:SpreadsheetDocumentCellLineType">None</v8ui:style>\n\t</line>\n' +
        '\t<line width="1" gap="false">\n\t\t<v8ui:style xsi:type="v8ui:SpreadsheetDocumentCellLineType">Solid</v8ui:style>\n\t</line>\n\t<rowsItem>',
    )
    expect(parseMxlTemplate(withLines).formats[2]).toBe("границы: снизу сплошная 1; заполнение Text")
  })

  test("two cells in one column are reported as damage, first", () => {
    const doubled = TEMPLATE.replace(
      "\t\t\t\t\t<parameter>ТекстЗаголовка</parameter>\n\t\t\t\t</c>\n\t\t\t</c>",
      "\t\t\t\t\t<parameter>ТекстЗаголовка</parameter>\n\t\t\t\t</c>\n\t\t\t</c>\n\t\t\t<c>\n\t\t\t\t<i>1</i>\n\t\t\t\t<c>\n\t\t\t\t\t<parameter>Ещё</parameter>\n\t\t\t\t</c>\n\t\t\t</c>",
    )
    expect(parseMxlTemplate(doubled).duplicates).toEqual([{ row: 23, column: 2 }])
    const text = describeMxlTemplate(parseMxlTemplate(doubled))
    expect(text).toContain("**Макет повреждён: две ячейки в одной колонке** — строка 23, колонка 2")
    expect(text.indexOf("повреждён")).toBeLessThan(text.indexOf("## Области"))
  })

  test("content inside a merge, not at its top-left, is reported as not printing", () => {
    const covered = TEMPLATE.replace(
      "\t\t\t\t\t<parameter>ТекстЗаголовка</parameter>\n\t\t\t\t</c>\n\t\t\t</c>",
      "\t\t\t\t\t<parameter>ТекстЗаголовка</parameter>\n\t\t\t\t</c>\n\t\t\t</c>\n\t\t\t<c>\n\t\t\t\t<i>5</i>\n\t\t\t\t<c>\n\t\t\t\t\t<parameter>Номер</parameter>\n\t\t\t\t</c>\n\t\t\t</c>",
    )
    const text = describeMxlTemplate(parseMxlTemplate(covered))
    expect(text).toContain("**Не напечатается**")
    expect(text).toContain("строка 23, колонка 6 (строка 23, колонка 2: 2 стр. × 32 кол.)")
    expect(describeMxlTemplate(parseMxlTemplate(TEMPLATE))).not.toContain("Не напечатается")
  })
})

// debrief15.md §15.21: `ПФ_MXL_Т1` merges columns 2–4 in every row (`<r>-1</r>`)
// and cancels it in some rows. Read as row 1, it let a title anchor move to
// column 3, where nothing printed, and the report called the template clean.
describe("a column merge (<r>-1</r>) and its per-row cancellations", () => {
  const COLUMNS = TEMPLATE.replace(
    "</document>",
    "\t<merge>\n\t\t<r>-1</r>\n\t\t<c>1</c>\n\t\t<w>2</w>\n\t</merge>\n" +
      "\t<verticalUnmerge>\n\t\t<r>24</r>\n\t\t<c>1</c>\n\t\t<w>2</w>\n\t</verticalUnmerge>\n</document>",
  )

  test("is read as columns 2–4 in every row, except the cancelled ones", () => {
    const merge = parseMxlTemplate(COLUMNS).merges.find((item) => item.row === null)
    expect(merge).toEqual({ row: null, column: 2, rows: 1, columns: 3, exceptRows: [25] })
  })

  test("hides columns 3–4 in a row it applies to, and nothing in a cancelled row", () => {
    const template = parseMxlTemplate(COLUMNS)
    expect(hidingMerge(template, 10, 3)).not.toBeNull()
    expect(hidingMerge(template, 10, 2)).toBeNull()
    expect(hidingMerge(template, 25, 3)).toBeNull()
  })

  test("the report lists it with its exceptions", () => {
    const text = describeMxlTemplate(parseMxlTemplate(COLUMNS))
    expect(text).toContain("## Объединения колонок (во всех строках)")
    expect(text).toContain("колонки 2–4 объединены во всех строках, кроме строк 25")
    expect(text).toContain("`unmerge_columns`")
  })

  test("content in a hidden column is reported as not printing", () => {
    const moved = COLUMNS.replace("\t\t\t\t<i>1</i>\n\t\t\t\t<c>\n\t\t\t\t\t<f>1</f>\n\t\t\t\t\t<parameter>", "\t\t\t\t<i>2</i>\n\t\t\t\t<c>\n\t\t\t\t\t<f>1</f>\n\t\t\t\t\t<parameter>")
    expect(describeMxlTemplate(parseMxlTemplate(moved))).toContain("**Не напечатается**")
  })
})

describe("column widths", () => {
  test("are read from <columns> through the format palette", () => {
    const withColumns = TEMPLATE.replace(
      "\t<rowsItem>",
      "\t<columns>\n\t\t<size>2</size>\n\t\t<columnsItem>\n\t\t\t<index>1</index>\n\t\t\t<column>\n\t\t\t\t<formatIndex>1</formatIndex>\n\t\t\t</column>\n\t\t</columnsItem>\n\t</columns>\n\t<rowsItem>",
    )
    const template = parseMxlTemplate(withColumns)
    expect(template.columnWidths).toEqual([null, 8])
    expect(describeMxlTemplate(template)).toContain("1: — | 2: 8")
  })
})
