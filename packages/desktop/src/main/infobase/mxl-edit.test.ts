import { describe, expect, test } from "bun:test"

import { parseMxlTemplate } from "./mxl"
import { cellContent, editMxlCells } from "./mxl-edit"

// debrief15.md §15.12: a variant of a standard form was redrawn from scratch
// because nothing could change a few cells of the standard template.

// Shaped on the platform's own files: one-tab palette entries, 1-based <f>, a
// text cell whose format has no fillType, a parameter cell, a merge.
const TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<document xmlns:v8="http://v8.1c.ru/8.1/data/core">
\t<rowsItem>
\t\t<index>0</index>
\t\t<row>
\t\t\t<c>
\t\t\t\t<c>
\t\t\t\t\t<f>1</f>
\t\t\t\t\t<tl>
\t\t\t\t\t\t<v8:item>
\t\t\t\t\t\t\t<v8:lang>ru</v8:lang>
\t\t\t\t\t\t\t<v8:content>Принять на работу</v8:content>
\t\t\t\t\t\t</v8:item>
\t\t\t\t\t</tl>
\t\t\t\t</c>
\t\t\t</c>
\t\t\t<c>
\t\t\t\t<i>3</i>
\t\t\t\t<c>
\t\t\t\t\t<f>2</f>
\t\t\t\t\t<parameter>ДатаПриема</parameter>
\t\t\t\t</c>
\t\t\t</c>
\t\t</row>
\t</rowsItem>
\t<rowsItem>
\t\t<index>1</index>
\t\t<indexTo>2</indexTo>
\t\t<row>
\t\t\t<empty>true</empty>
\t\t</row>
\t</rowsItem>
\t<format>
\t\t<font>0</font>
\t</format>
\t<format>
\t\t<font>1</font>
\t\t<fillType>Parameter</fillType>
\t</format>
\t<merge>
\t\t<r>0</r>
\t\t<c>0</c>
\t\t<w>2</w>
\t</merge>
</document>
`

describe("editing cells of a template", () => {
  test("text and parameter change in place; a text cell needs no new format", () => {
    const result = editMxlCells(TEMPLATE, [
      { row: 1, column: 1, text: "Принять на обучение" },
      { row: 1, column: 4, parameter: "ДатаНачалаОбучения" },
    ])
    if (!result.ok) throw new Error(result.error)
    expect(cellContent(result.xml, 1, 1)).toEqual({ text: "Принять на обучение" })
    expect(cellContent(result.xml, 1, 4)).toEqual({ parameter: "ДатаНачалаОбучения" })
    expect([...result.xml.matchAll(/^\t<format>/gm)]).toHaveLength(2)
  })

  test("a change of kind clones the cell's format, 1-based, and leaves the shared one alone", () => {
    const result = editMxlCells(TEMPLATE, [{ row: 1, column: 1, parameter: "Условия" }])
    if (!result.ok) throw new Error(result.error)
    // The third palette entry: font of format 1, fillType Parameter.
    expect(result.xml).toMatch(/<f>3<\/f>\s*<parameter>Условия<\/parameter>/)
    expect(result.xml).toMatch(/\t<format>\s*<font>0<\/font>\s*<fillType>Parameter<\/fillType>\s*<\/format>/)
    expect(result.xml).toContain("\t<format>\n\t\t<font>0</font>\n\t</format>")
    expect(result.changes[0]).toContain("формат 3")
  })

  test("text is escaped, and clearing removes the content", () => {
    const result = editMxlCells(TEMPLATE, [
      { row: 1, column: 1, text: 'ООО "Рога & копыта" <1>' },
      { row: 1, column: 4, clear: true },
    ])
    if (!result.ok) throw new Error(result.error)
    expect(cellContent(result.xml, 1, 1)).toEqual({ text: 'ООО "Рога & копыта" <1>' })
    expect(cellContent(result.xml, 1, 4)).toEqual({})
  })

  test("a cell that doesn't exist, or an empty row, is refused and nothing is written", () => {
    const missing = editMxlCells(TEMPLATE, [{ row: 1, column: 2, text: "x" }])
    expect(missing).toMatchObject({ ok: false })
    expect(missing.ok ? "" : missing.error).toContain("кол. 1 «Принять на работу»; кол. 4 <ДатаПриема>")
    expect(editMxlCells(TEMPLATE, [{ row: 2, column: 1, text: "x" }])).toMatchObject({ ok: false })
  })

  // debrief15.md §15.14 item 4: one missing cell named per refusal cost a round
  // trip per wrong column.
  test("every missing cell is named in one refusal, beside the edits that were fine", () => {
    const result = editMxlCells(TEMPLATE, [
      { row: 1, column: 1, text: "ок" },
      { row: 1, column: 2, text: "x" },
      { row: 7, column: 1, text: "y" },
    ])
    const error = result.ok ? "" : result.error
    expect(error).toContain("Не найдено ячеек: 2 из 3")
    expect(error).toContain("строка 1, колонка 2")
    expect(error).toContain("строка 7:")
    expect(error).not.toContain("колонка 1:")
  })
})

// debrief15.md §15.14, §15.18: a caption split in two, a wider title, bold and
// underlines were all hand-written XML, and each went wrong once. Shaped on
// ПФ_MXL_Т1: merges after <vgRows>, then lines, fonts, formats.
const FORM = `<?xml version="1.0" encoding="UTF-8"?>
<document xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
\t<rowsItem>
\t\t<index>0</index>
\t\t<row>
\t\t\t<c>
\t\t\t\t<c>
\t\t\t\t\t<f>1</f>
\t\t\t\t\t<tl>
\t\t\t\t\t\t<v8:item>
\t\t\t\t\t\t\t<v8:lang>ru</v8:lang>
\t\t\t\t\t\t\t<v8:content>условия приема на работу, характер работы</v8:content>
\t\t\t\t\t\t</v8:item>
\t\t\t\t\t</tl>
\t\t\t\t</c>
\t\t\t</c>
\t\t</row>
\t</rowsItem>
\t<rowsItem>
\t\t<index>1</index>
\t\t<row>
\t\t\t<c>
\t\t\t\t<c>
\t\t\t\t\t<f>2</f>
\t\t\t\t\t<tl>
\t\t\t\t\t\t<v8:item>
\t\t\t\t\t\t\t<v8:lang>ru</v8:lang>
\t\t\t\t\t\t\t<v8:content>ПРИКАЗ</v8:content>
\t\t\t\t\t\t</v8:item>
\t\t\t\t\t</tl>
\t\t\t\t</c>
\t\t\t</c>
\t\t\t<c>
\t\t\t\t<i>2</i>
\t\t\t\t<c>
\t\t\t\t\t<f>3</f>
\t\t\t\t\t<parameter>Номер</parameter>
\t\t\t\t</c>
\t\t\t</c>
\t\t</row>
\t</rowsItem>
\t<rowsItem>
\t\t<index>2</index>
\t\t<row>
\t\t\t<empty>true</empty>
\t\t</row>
\t</rowsItem>
\t<height>3</height>
\t<vgRows>3</vgRows>
\t<merge>
\t\t<r>0</r>
\t\t<c>0</c>
\t\t<w>5</w>
\t</merge>
\t<line width="2" gap="false">
\t\t<v8ui:style xsi:type="v8ui:SpreadsheetDocumentCellLineType">Solid</v8ui:style>
\t</line>
\t<line width="0" gap="false">
\t\t<v8ui:style xsi:type="v8ui:SpreadsheetDocumentCellLineType">None</v8ui:style>
\t</line>
\t<font faceName="Verdana" height="9" bold="false" italic="false" underline="false" strikeout="false" kind="Absolute" scale="100"/>
\t<font faceName="Verdana" height="9" bold="true" italic="false" underline="false" strikeout="false" kind="Absolute" scale="100"/>
\t<format>
\t\t<font>0</font>
\t\t<border>0</border>
\t</format>
\t<format>
\t\t<font>1</font>
\t\t<horizontalAlignment>Center</horizontalAlignment>
\t</format>
\t<format>
\t\t<font>0</font>
\t\t<fillType>Parameter</fillType>
\t</format>
</document>
`

const merges = (xml: string) => parseMxlTemplate(xml).merges.map((m) => `${m.row}:${m.column}:${m.rows}x${m.columns}`)

describe("changing a template's geometry and look", () => {
  test("one merged caption becomes two, with a second cell made in the format of the first", () => {
    const result = editMxlCells(FORM, [
      { unmerge: { row: 1, column: 1 } },
      { merge: { row: 1, column: 1, rows: 1, columns: 3 } },
      { merge: { row: 1, column: 4, rows: 1, columns: 3 } },
      { row: 1, column: 1, text: "условия приема на работу" },
      { row: 1, column: 4, create: true, like: { row: 1, column: 1 }, text: "характер работы" },
    ])
    if (!result.ok) throw new Error(result.error)
    expect(merges(result.xml).sort()).toEqual(["1:1:1x3", "1:4:1x3"])
    expect(cellContent(result.xml, 1, 4)).toEqual({ text: "характер работы" })
    expect(result.xml).toMatch(/<i>3<\/i>\s*<c>\s*<f>1<\/f>/)
    expect(parseMxlTemplate(result.xml).duplicates).toEqual([])
  })

  // The title regression: a merge one column too wide covered the number cell.
  test("a merge that would cover a cell with content is refused, and names it", () => {
    const result = editMxlCells(FORM, [{ merge: { row: 2, column: 1, rows: 1, columns: 4 } }])
    expect(result.ok ? "" : result.error).toContain("накроет")
    expect(result.ok ? "" : result.error).toContain("кол. 3 <Номер>")
  })

  test("a merge overlapping another is refused; one anchored at the same cell is resized", () => {
    expect(editMxlCells(FORM, [{ merge: { row: 1, column: 2, rows: 1, columns: 2 } }])).toMatchObject({ ok: false })
    const resized = editMxlCells(FORM, [{ merge: { row: 1, column: 1, rows: 1, columns: 4 } }])
    if (!resized.ok) throw new Error(resized.error)
    expect(merges(resized.xml)).toEqual(["1:1:1x4"])
    expect(resized.xml).toContain("\t<merge>\n\t\t<r>0</r>\n\t\t<c>0</c>\n\t\t<w>3</w>\n\t</merge>")
  })

  test("a merge where there were none goes right after <vgRows>", () => {
    const bare = FORM.replace(/\t<merge>[\s\S]*?\t<\/merge>\n/, "")
    const result = editMxlCells(bare, [{ merge: { row: 3, column: 1, rows: 1, columns: 2 } }])
    if (!result.ok) throw new Error(result.error)
    expect(result.xml).toContain("<vgRows>3</vgRows>\n\t<merge>\n\t\t<r>2</r>")
  })

  test("a cell is made in an empty row, and at the end of a row", () => {
    const result = editMxlCells(FORM, [
      { row: 3, column: 2, create: true, text: "подпись" },
      { row: 2, column: 5, create: true, like: { row: 2, column: 3 }, parameter: "Дата" },
    ])
    if (!result.ok) throw new Error(result.error)
    expect(cellContent(result.xml, 3, 2)).toEqual({ text: "подпись" })
    expect(cellContent(result.xml, 2, 5)).toEqual({ parameter: "Дата" })
    expect(cellContent(result.xml, 2, 3)).toEqual({ parameter: "Номер" })
    expect(result.xml).not.toContain("<empty>true</empty>")
  })

  // The run's font went after the formats, where the platform drops it.
  test("a smaller font: a new font entry before the formats, numbered from 0, in a cloned format", () => {
    const result = editMxlCells(FORM, [{ row: 2, column: 1, style: { size: 8.3 } }])
    if (!result.ok) throw new Error(result.error)
    const font = '\t<font faceName="Verdana" height="8.3" bold="true"'
    expect(result.xml.indexOf(font)).toBeGreaterThan(0)
    expect(result.xml.indexOf(font)).toBeLessThan(result.xml.indexOf("\t<format>"))
    expect(parseMxlTemplate(result.xml).fonts[2]).toBe("Verdana 8.3 bold")
    // Format 2 is shared; the cell gets a copy with <font>2</font>, in the spec's tag order.
    expect(result.xml).toContain("\t<format>\n\t\t<font>1</font>\n\t\t<horizontalAlignment>Center</horizontalAlignment>\n\t</format>")
    expect(result.xml).toContain("\t<format>\n\t\t<font>2</font>\n\t\t<horizontalAlignment>Center</horizontalAlignment>\n\t</format>")
    expect(result.xml).toMatch(/<f>4<\/f>\s*<tl>[\s\S]*?ПРИКАЗ/)
  })

  test("an underline opens up a collapsed border and adds a thin line when there is none", () => {
    const result = editMxlCells(FORM, [{ row: 1, column: 1, style: { underline: true } }])
    if (!result.ok) throw new Error(result.error)
    expect(result.xml).toContain('\t<line width="1" gap="false">')
    expect(result.xml).toContain(
      "\t<format>\n\t\t<font>0</font>\n\t\t<leftBorder>0</leftBorder>\n\t\t<topBorder>0</topBorder>\n" +
        "\t\t<rightBorder>0</rightBorder>\n\t\t<bottomBorder>2</bottomBorder>\n\t</format>",
    )
  })

  test("alignment lands before fillType, as the platform orders them", () => {
    const result = editMxlCells(FORM, [{ row: 2, column: 3, style: { align: "Right" } }])
    if (!result.ok) throw new Error(result.error)
    expect(result.xml).toContain(
      "\t<format>\n\t\t<font>0</font>\n\t\t<horizontalAlignment>Right</horizontalAlignment>\n\t\t<fillType>Parameter</fillType>\n\t</format>",
    )
  })

  test("an edit that asks for nothing, or for two contents, is refused", () => {
    expect(editMxlCells(FORM, [{ row: 1, column: 1 }])).toMatchObject({ ok: false })
    expect(editMxlCells(FORM, [{ row: 1, column: 1, text: "a", parameter: "b" }])).toMatchObject({ ok: false })
  })
})

// The platform writes CRLF; every fixture above is LF. The first platform check
// found cloned formats emptied and a new font glued to the previous one's line.
describe("a template with the platform's own CRLF line ends", () => {
  test("formats clone whole, the font gets its own line, and the file keeps CRLF", () => {
    const crlf = FORM.replace(/\n/g, "\r\n")
    const result = editMxlCells(crlf, [
      { row: 2, column: 1, style: { size: 8.3 } },
      { row: 2, column: 3, text: "текст" },
    ])
    if (!result.ok) throw new Error(result.error)
    expect(result.xml.replace(/\r\n/g, "")).not.toContain("\n")
    const lf = result.xml.replace(/\r\n/g, "\n")
    expect(lf).toContain("\t<format>\n\t\t<font>2</font>\n\t\t<horizontalAlignment>Center</horizontalAlignment>\n\t</format>")
    expect(lf).toMatch(/scale="100"\/>\n\t<font faceName="Verdana" height="8.3" bold="true"/)
    // The parameter cell's format without fillType Parameter is format 1's twin -- no empty format appears.
    expect(lf).not.toContain("\t<format>\n\t</format>")
  })

  test("a line break inside a text stays a bare LF, as the platform writes it", () => {
    const result = editMxlCells(FORM.replace(/\n/g, "\r\n"), [{ row: 2, column: 1, text: "ПРИКАЗ\n(распоряжение)" }])
    if (!result.ok) throw new Error(result.error)
    expect(result.xml).toContain("<v8:content>ПРИКАЗ\n(распоряжение)</v8:content>")
    expect(result.xml).toContain("</v8:content>\r\n")
  })
})

// The platform check: splitting a merge leaves blank cells behind it; a `create`
// on one of them made nothing, and the text landed in a format holding only
// `fillType` -- which, emptied, became a <format></format> the platform drops,
// shifting every later format by one.
describe("a cell left over from a merge", () => {
  const LEFTOVER = FORM.replace(
    "\t\t\t\t\t<v8:content>условия приема на работу, характер работы</v8:content>\n\t\t\t\t\t\t</v8:item>\n\t\t\t\t\t</tl>\n\t\t\t\t</c>\n\t\t\t</c>",
    "\t\t\t\t\t<v8:content>условия приема на работу, характер работы</v8:content>\n\t\t\t\t\t\t</v8:item>\n\t\t\t\t\t</tl>\n\t\t\t\t</c>\n\t\t\t</c>\n\t\t\t<c>\n\t\t\t\t<i>3</i>\n\t\t\t\t<c>\n\t\t\t\t\t<f>3</f>\n\t\t\t\t</c>\n\t\t\t</c>",
  )
    .replace("\t\t<font>0</font>\n\t\t<fillType>Parameter</fillType>", "\t\t<fillType>Parameter</fillType>")
    // The merge already split: columns 1–3, so column 4 is out of it.
    .replace("\t\t<w>5</w>", "\t\t<w>2</w>")

  test("`like` on it takes that cell's look, and no empty format is ever written", () => {
    const result = editMxlCells(LEFTOVER, [{ row: 1, column: 4, create: true, like: { row: 1, column: 1 }, text: "характер работы" }])
    if (!result.ok) throw new Error(result.error)
    expect(result.xml).toMatch(/<i>3<\/i>\s*<c>\s*<f>1<\/f>\s*<tl>/)
    expect(result.xml).not.toContain("\t<format>\n\t</format>")
  })

  test("text in a cell whose format held only fillType: the cell loses its format, not gains an empty one", () => {
    const result = editMxlCells(LEFTOVER, [{ row: 1, column: 4, text: "характер работы" }])
    if (!result.ok) throw new Error(result.error)
    expect(result.xml).not.toContain("\t<format>\n\t</format>")
    expect(result.xml).toMatch(/<i>3<\/i>\s*<c>\s*<tl>/)
    expect(result.changes[0]).toContain("без своего формата")
  })
})

// A format an edit produces may already be in the palette. Read and built
// bodies differ in a leading newline; compared raw, the twin was missed and a
// duplicate appended.
describe("a format the palette already has", () => {
  test("is reused, not appended again", () => {
    // Appended last, so the numbers the cells refer to stay as they were: format 4 is font 0, nothing else.
    const withTwin = FORM.replace("\t</format>\n</document>", "\t</format>\n\t<format>\n\t\t<font>0</font>\n\t</format>\n</document>")
    const before = [...withTwin.matchAll(/^\t<format>/gm)].length
    expect(before).toBe(4)
    // Cell 2:3 is format 3 (font 0, Parameter); as text it is font 0 alone -- format 4.
    const result = editMxlCells(withTwin, [{ row: 2, column: 3, text: "текст" }])
    if (!result.ok) throw new Error(result.error)
    expect([...result.xml.matchAll(/^\t<format>/gm)].length).toBe(before)
    expect(result.xml).toMatch(/<f>4<\/f>\s*<tl>[\s\S]*?текст/)
    expect(result.xml).not.toContain("\t<format>\n\n")
  })
})

// debrief15.md §15.21: ПФ_MXL_Т1 merges columns 2–4 in every row (`<r>-1</r>`),
// cancelled in a few rows by <verticalUnmerge>. A title anchor moved into
// column 3 printed nothing. Here: columns 2–4 merged everywhere but row 3.
const COLUMNS = `<?xml version="1.0" encoding="UTF-8"?>
<document xmlns:v8="http://v8.1c.ru/8.1/data/core">
\t<rowsItem>
\t\t<index>0</index>
\t\t<row>
\t\t\t<c>
\t\t\t\t<i>1</i>
\t\t\t\t<c>
\t\t\t\t\t<f>1</f>
\t\t\t\t\t<parameter>Дата</parameter>
\t\t\t\t</c>
\t\t\t</c>
\t\t</row>
\t</rowsItem>
\t<rowsItem>
\t\t<index>1</index>
\t\t<row>
\t\t\t<c>
\t\t\t\t<i>4</i>
\t\t\t\t<c>
\t\t\t\t\t<f>2</f>
\t\t\t\t\t<tl>
\t\t\t\t\t\t<v8:item>
\t\t\t\t\t\t\t<v8:lang>ru</v8:lang>
\t\t\t\t\t\t\t<v8:content>ПРИКАЗ</v8:content>
\t\t\t\t\t\t</v8:item>
\t\t\t\t\t</tl>
\t\t\t\t</c>
\t\t\t</c>
\t\t</row>
\t</rowsItem>
\t<rowsItem>
\t\t<index>2</index>
\t\t<row>
\t\t\t<c>
\t\t\t\t<i>2</i>
\t\t\t\t<c>
\t\t\t\t\t<f>2</f>
\t\t\t\t\t<tl>
\t\t\t\t\t\t<v8:item>
\t\t\t\t\t\t\t<v8:lang>ru</v8:lang>
\t\t\t\t\t\t\t<v8:content>подпись</v8:content>
\t\t\t\t\t\t</v8:item>
\t\t\t\t\t</tl>
\t\t\t\t</c>
\t\t\t</c>
\t\t</row>
\t</rowsItem>
\t<vgRows>3</vgRows>
\t<merge>
\t\t<r>-1</r>
\t\t<c>1</c>
\t\t<w>2</w>
\t</merge>
\t<verticalUnmerge>
\t\t<r>2</r>
\t\t<c>1</c>
\t\t<w>2</w>
\t</verticalUnmerge>
\t<format>
\t\t<fillType>Parameter</fillType>
\t</format>
\t<format>
\t\t<horizontalAlignment>Center</horizontalAlignment>
\t</format>
</document>
`

describe("a column merge (<r>-1</r>)", () => {
  test("an anchor moved inside it is refused, and the merge and its exceptions are named", () => {
    const result = editMxlCells(COLUMNS, [
      { row: 2, column: 3, create: true, like: { row: 2, column: 5 }, text: "ПРИКАЗ" },
      { row: 2, column: 5, clear: true },
    ])
    const error = result.ok ? "" : result.error
    expect(error).toContain("строка 2, колонка 3 (колонки 2–4 объединены во всех строках, кроме строк 3)")
    expect(error).toContain("unmerge_columns")
  })

  test("unmerge_columns cancels it in the chosen rows, after the other exceptions; then the anchor prints", () => {
    const result = editMxlCells(COLUMNS, [
      { unmerge_columns: { row: 1, column: 3, rows: 3 } },
      { row: 2, column: 3, create: true, like: { row: 2, column: 5 }, text: "ПРИКАЗ" },
      { row: 2, column: 5, clear: true },
    ])
    if (!result.ok) throw new Error(result.error)
    expect(result.changes[0]).toBe("объединение колонок отменено в строках 1, 2")
    expect(result.xml).toContain(
      "\t\t<r>2</r>\n\t\t<c>1</c>\n\t\t<w>2</w>\n\t</verticalUnmerge>\n" +
        "\t<verticalUnmerge>\n\t\t<r>0</r>\n\t\t<c>1</c>\n\t\t<w>2</w>\n\t</verticalUnmerge>\n" +
        "\t<verticalUnmerge>\n\t\t<r>1</r>\n\t\t<c>1</c>\n\t\t<w>2</w>\n\t</verticalUnmerge>\n\t<format>",
    )
    const merge = parseMxlTemplate(result.xml).merges[0]!
    expect([...(merge.exceptRows ?? [])].sort()).toEqual([1, 2, 3])
    expect(cellContent(result.xml, 2, 3)).toEqual({ text: "ПРИКАЗ" })
  })

  test("unmerge_columns on a column outside any column merge is refused", () => {
    const result = editMxlCells(COLUMNS, [{ unmerge_columns: { row: 1, column: 5 } }])
    expect(result.ok ? "" : result.error).toContain("Колонка 5 не входит ни в одно объединение колонок")
  })

  test("a row merge over it is refused until it is cancelled in those rows", () => {
    const refused = editMxlCells(COLUMNS, [{ merge: { row: 2, column: 1, rows: 1, columns: 3 } }])
    expect(refused.ok ? "" : refused.error).toContain("объединение колонок: колонки 2–4")
    const done = editMxlCells(COLUMNS, [
      { unmerge_columns: { row: 2, column: 2 } },
      { merge: { row: 2, column: 1, rows: 1, columns: 3 } },
    ])
    if (!done.ok) throw new Error(done.error)
    expect(merges(done.xml).sort()).toEqual(["2:1:1x3", "null:2:1x3"])
  })

  // `<r>-1</r>` read as `\d+` (no match, so 0) was row 1: an unmerge there deleted the column merge.
  test("is not taken for a merge anchored in a row", () => {
    const result = editMxlCells(COLUMNS, [{ unmerge: { row: 1, column: 2 } }])
    expect(result.ok ? "" : result.error).toContain("Объединения с левой верхней ячейкой в строке 1, колонке 2 нет")
  })
})
