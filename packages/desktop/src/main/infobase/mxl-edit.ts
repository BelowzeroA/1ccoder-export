// Changing a макет in place, so a variant of a standard form isn't redrawn.
//
// 2026-09-28, debrief15.md §15.12. An external print form had to follow a
// sample that was a variant of a form the base already had. The standard
// template carried the whole layout -- grid, frames, fonts, captions -- and the
// variant differed in a handful of texts and fields. The agent had only
// "rebuild the grid from JSON" (mxl-compile) and wrote the layout from scratch;
// what it didn't redraw carefully came out wrong.
//
// 2026-09-28, debrief15.md §15.14 and §15.18. The rerun copied the standard
// template and changed its texts with this tool, and everything else -- one
// caption split into two, a wider title, bold, underlines -- went back to
// hand-written XML: a cell written twice by a retried script, a merge one
// column too wide that swallowed the number cell, a font added after the
// formats where the platform ignores it, and 35 minutes on one title. So the
// tool now also creates a cell, merges and unmerges, and changes a cell's look.
//
// Coordinates are 1C's, 1-based, as 1c_mxl_info reports them. The file's own
// numbering is mixed, and every rule below is from the platform's spec
// (resources/vendor/cc-1c-skills/reference/1c-spreadsheet-spec.md):
// - rows, columns and merges are 0-based in the XML;
// - the format palette is 1-based (`<f>0</f>` or no <f> = no format of its own);
// - the font and line palettes are 0-based;
// - a font no format refers to is dropped, and fonts come before formats;
// - tags inside a <format> keep a fixed order.
//
// What a cell holds is decided by `fillType` in its FORMAT, and formats are
// shared palette entries, so any change to a cell's format clones it rather
// than editing it under every other cell that uses it.

import { hiddenCells, mergeLabel, parseMxlTemplate, type MxlMerge } from "./mxl"

/** How a cell looks. Unset properties stay as they are. */
export interface MxlStyle {
  readonly bold?: boolean
  /** Font size in points, as in the palette (`8.3`, `9`, `10`). */
  readonly size?: number
  /** A thin line under the cell -- how a form's fill-in lines are drawn. */
  readonly underline?: boolean
  readonly align?: "Left" | "Center" | "Right"
  /** Word wrap inside the cell. */
  readonly wrap?: boolean
}

export interface MxlCellEdit {
  readonly row: number
  readonly column: number
  readonly text?: string
  readonly template?: string
  readonly parameter?: string
  readonly clear?: true
  /** Make the cell if the row has none in this column. */
  readonly create?: boolean
  /** For a created cell: take the format of this one. */
  readonly like?: { readonly row: number; readonly column: number }
  readonly style?: MxlStyle
}

export interface MxlMergeEdit {
  /** The merged cell anchored at row/column, `rows` by `columns`. Replaces one anchored there. */
  readonly merge: { readonly row: number; readonly column: number; readonly rows: number; readonly columns: number }
}

export interface MxlUnmergeEdit {
  readonly unmerge: { readonly row: number; readonly column: number }
}

/**
 * Cancels a column merge (`<r>-1</r>`, columns merged in every row) in `rows`
 * rows from `row`, so each of its columns prints on its own there.
 */
export interface MxlUnmergeColumnsEdit {
  readonly unmerge_columns: { readonly row: number; readonly column: number; readonly rows?: number }
}

export type MxlEdit = MxlCellEdit | MxlMergeEdit | MxlUnmergeEdit | MxlUnmergeColumnsEdit

export interface MxlCellContent {
  readonly parameter?: string
  readonly text?: string
}

export type MxlEditResult =
  | { readonly ok: true; readonly xml: string; readonly changes: readonly string[] }
  | { readonly ok: false; readonly error: string }

const ROWS_ITEM = /^\t<rowsItem>[\s\S]*?^\t<\/rowsItem>/gm
const CELL = /<c>\s*(?:<i>(\d+)<\/i>)?([\s\S]*?)<\/c>\s*<\/c>/g
const FORMAT = /^\t<format>([\s\S]*?)^\t<\/format>\n?/gm
const FONT = /^\t<font\s[^>]*\/>\n?/gm
const LINE = /^\t<line\s[\s\S]*?^\t<\/line>\n?/gm
const MERGE = /^\t<merge>[\s\S]*?^\t<\/merge>\n?/gm

/** The spec's tag order inside <format>, taken from 766 960 formats. */
const FORMAT_TAG_ORDER = [
  "print", "drawingBorder", "drawingHaveLeftBorder", "drawingHaveTopBorder", "drawingHaveRightBorder",
  "drawingHaveBottomBorder", "font", "leftBorder", "topBorder", "rightBorder", "bottomBorder", "border", "height",
  "borderColor", "width", "autoWidthCalculation", "widthWeightFactor", "horizontalAlignment", "verticalAlignment",
  "textColor", "backColor", "patternColor", "pattern", "textPlacement", "fillType", "protection", "hidden",
  "textOrientation", "detailsUse", "bySelectedColumns", "markNegatives", "containsValue", "valueType", "format",
  "controlType", "hyperLink", "autoMarkIncomplete", "indent", "autoIndent", "editFormat", "columnSizeChange", "mask",
  "picIndex", "pictureSizeMode", "picHorizontalAlignment", "picVerticalAlignment", "textPosition",
]

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function unescapeXml(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&")
}

const isMerge = (edit: MxlEdit): edit is MxlMergeEdit => "merge" in edit
const isUnmerge = (edit: MxlEdit): edit is MxlUnmergeEdit => "unmerge" in edit
const isUnmergeColumns = (edit: MxlEdit): edit is MxlUnmergeColumnsEdit => "unmerge_columns" in edit
const isCell = (edit: MxlEdit): edit is MxlCellEdit => !isMerge(edit) && !isUnmerge(edit) && !isUnmergeColumns(edit)

/** The row's block and where it starts, by 1-based row. */
function findRow(xml: string, row: number): { start: number; block: string } | null {
  for (const match of xml.matchAll(ROWS_ITEM)) {
    const block = match[0]
    const from = Number(/<index>(\d+)<\/index>/.exec(block)?.[1])
    if (from + 1 === row) return { start: match.index ?? 0, block }
  }
  return null
}

interface CellMatch {
  readonly column: number
  /** Whether the cell says its column (`<i>`) or takes the one after the previous cell. */
  readonly declared: boolean
  /** The whole cell, within the row block. */
  readonly outerStart: number
  readonly outerEnd: number
  /** Offsets of group 2 -- the inner <c> and its content -- within the row block. */
  readonly innerStart: number
  readonly innerEnd: number
  readonly inner: string
}

function cellsOf(block: string): CellMatch[] {
  const cells: CellMatch[] = []
  let column = -1
  // `d`: the offsets of group 2, so the inner cell can be spliced exactly.
  for (const cell of block.matchAll(new RegExp(CELL.source, "gd"))) {
    const declared = cell[1] === undefined ? null : Number(cell[1])
    column = declared === null ? column + 1 : declared
    const [innerStart, innerEnd] = cell.indices![2]!
    const outerStart = cell.index ?? 0
    cells.push({
      column: column + 1,
      declared: declared !== null,
      outerStart,
      outerEnd: outerStart + cell[0].length,
      innerStart,
      innerEnd,
      inner: cell[2] ?? "",
    })
  }
  return cells
}

function textOf(inner: string): string | undefined {
  const items = [...inner.matchAll(/<v8:lang>([^<]*)<\/v8:lang>\s*<v8:content>([^<]*)<\/v8:content>/g)]
  const text = (items.find((item) => item[1] === "ru") ?? items[0])?.[2]
  return text === undefined ? undefined : unescapeXml(text)
}

/** What a cell holds now: its parameter, or the Russian (else first) text of its <tl>. */
export function cellContent(xml: string, row: number, column: number): MxlCellContent | null {
  const found = findRow(xml, row)
  if (!found) return null
  const cell = cellsOf(found.block).find((item) => item.column === column)
  if (!cell) return null
  const parameter = /<parameter>([^<]*)<\/parameter>/.exec(cell.inner)?.[1]
  const text = textOf(cell.inner)
  return { ...(parameter ? { parameter } : {}), ...(text !== undefined ? { text } : {}) }
}

/** A cell as a refusal shows it: its column and what it holds, short. */
function cellLabel(cell: CellMatch): string {
  const parameter = /<parameter>([^<]*)<\/parameter>/.exec(cell.inner)?.[1]
  if (parameter) return `кол. ${cell.column} <${parameter}>`
  const raw = textOf(cell.inner)
  if (raw === undefined) return `кол. ${cell.column} (пусто)`
  const text = raw.replace(/\s+/g, " ").trim()
  return `кол. ${cell.column} «${text.length > 30 ? `${text.slice(0, 30)}…` : text}»`
}

const hasContent = (cell: CellMatch) => /<parameter>|<v8:content>[^<]/.test(cell.inner)

/**
 * Every cell edit that points at no cell, each with what its row does have.
 *
 * 2026-09-28, debrief15.md §15.14 item 4: the refusal named only the first
 * missing cell, so each wrong column cost a round trip. All of them are
 * checked against the original at once; a `create` edit makes its own cell.
 */
function missingCells(xml: string, edits: readonly MxlEdit[]): string | null {
  const cellEdits = edits.filter(isCell)
  const creating = new Set(cellEdits.filter((edit) => edit.create).map((edit) => `${edit.row}:${edit.column}`))
  const problems = cellEdits.flatMap((edit) => {
    const found = findRow(xml, edit.row)
    if (!found) return [`- строка ${edit.row}: строки с ячейками в макете нет (пустые строки ячеек не имеют)`]
    const cells = cellsOf(found.block)
    if (cells.some((item) => item.column === edit.column) || creating.has(`${edit.row}:${edit.column}`)) return []
    const present = cells.map(cellLabel).join("; ") || "ячеек нет"
    return [
      `- строка ${edit.row}, колонка ${edit.column}: такой ячейки нет. В строке: ${present}. ` +
        "Создать — `create: true` (формат можно взять у соседней: `like`).",
    ]
  })
  if (!problems.length) return null
  return [`Не найдено ячеек: ${problems.length} из ${cellEdits.length}.`, ...problems].join("\n")
}

// ---------------------------------------------------------------------------
// Formats, fonts, lines

interface Chunk {
  readonly tag: string
  readonly text: string
}

/** A format's top-level tags, in file order. The nested <format> (number format) stays one chunk. */
function chunksOf(body: string): Chunk[] {
  return [...body.matchAll(/^\t\t<(\w+)>[\s\S]*?<\/\1>\n/gm)].map((match) => ({ tag: match[1]!, text: match[0] }))
}

/** Sets or removes one tag, keeping the spec's order. */
function setTag(body: string, tag: string, value: string | null): string {
  const chunks = chunksOf(body).filter((chunk) => chunk.tag !== tag)
  if (value !== null) {
    const rank = (name: string) => {
      const index = FORMAT_TAG_ORDER.indexOf(name)
      return index < 0 ? FORMAT_TAG_ORDER.length : index
    }
    const at = chunks.findIndex((chunk) => rank(chunk.tag) > rank(tag))
    const chunk = { tag, text: `\t\t<${tag}>${value}</${tag}>\n` }
    chunks.splice(at < 0 ? chunks.length : at, 0, chunk)
  }
  return chunks.map((chunk) => chunk.text).join("")
}

const tagValue = (body: string | undefined, tag: string) =>
  body === undefined ? undefined : new RegExp(`^\\t\\t<${tag}>([^<]*)</${tag}>`, "m").exec(body)?.[1]

/** A format with no `fillType` fills as Text -- the platform's default, and how plain captions are stored. */
const fillTypeOf = (body: string | undefined) => tagValue(body, "fillType") ?? "Text"

type FillType = "Text" | "Template" | "Parameter"

/** The palettes, read fresh each time -- an edit may have grown them. */
function palettes(xml: string) {
  return {
    formats: [...xml.matchAll(FORMAT)],
    fonts: [...xml.matchAll(FONT)],
    lines: [...xml.matchAll(LINE)],
  }
}

/**
 * A format's body as this module handles it: its tag lines, no leading newline.
 * One shape everywhere, so a format equal to one in the palette is recognised
 * as that one rather than added again.
 */
const bodyOf = (match: RegExpMatchArray | undefined) => (match?.[1] === undefined ? undefined : match[1].replace(/^\n/, ""))

/** The 1-based number of a format with this body, adding it to the palette if it is new. */
function internFormat(xml: string, body: string): { xml: string; index: number } | { error: string } {
  const { formats } = palettes(xml)
  const existing = formats.findIndex((item) => bodyOf(item) === body)
  if (existing >= 0) return { xml, index: existing + 1 }
  const last = formats.at(-1)
  if (!last) return { error: "В макете нет палитры форматов — править нечего." }
  const at = (last.index ?? 0) + last[0].length
  return { xml: xml.slice(0, at) + `\t<format>\n${body}\t</format>\n` + xml.slice(at), index: formats.length + 1 }
}

/** The 0-based number of a font, adding it after the last font -- fonts must come before formats. */
function internFont(xml: string, entry: string): { xml: string; index: number } {
  const { fonts } = palettes(xml)
  const existing = fonts.findIndex((item) => item[0].trimEnd() === entry)
  if (existing >= 0) return { xml, index: existing }
  const last = fonts.at(-1)!
  const at = (last.index ?? 0) + last[0].length
  return { xml: xml.slice(0, at) + `${entry}\n` + xml.slice(at), index: fonts.length }
}

/** The 0-based number of a thin solid cell line, adding one after the last line if there is none. */
function thinLine(xml: string): { xml: string; index: number } | { error: string } {
  const { lines } = palettes(xml)
  const existing = lines.findIndex(
    (item) => /width="1"/.test(item[0]) && /SpreadsheetDocumentCellLineType">Solid</.test(item[0]),
  )
  if (existing >= 0) return { xml, index: existing }
  const last = lines.at(-1)
  if (!last) return { error: "В макете нет палитры линий — подчеркнуть нечем." }
  const at = (last.index ?? 0) + last[0].length
  const entry =
    '\t<line width="1" gap="false">\n' +
    '\t\t<v8ui:style xsi:type="v8ui:SpreadsheetDocumentCellLineType">Solid</v8ui:style>\n' +
    "\t</line>\n"
  return { xml: xml.slice(0, at) + entry + xml.slice(at), index: lines.length }
}

/**
 * The font the cell prints with, as a palette entry.
 *
 * A cell's format may carry no font: it is inherited from the row's format,
 * then the document default (spec: one palette serves cell, row, column and
 * `<defaultFormatIndex>`). The column level is skipped -- a column format that
 * sets a font is rare, and the row and default cover what print forms do.
 */
function effectiveFont(xml: string, cellFormat: string | undefined, rowBlock: string): string | null {
  const { formats, fonts } = palettes(xml)
  const byFormat = (index: number | undefined) => (index && index > 0 ? formats[index - 1]?.[1] : undefined)
  const rowFormat = byFormat(Number(/<formatIndex>(\d+)<\/formatIndex>/.exec(rowBlock)?.[1]))
  const defaultFormat = byFormat(Number(/<defaultFormatIndex>(\d+)<\/defaultFormatIndex>/.exec(xml)?.[1]))
  const font = [cellFormat, rowFormat, defaultFormat].map((body) => tagValue(body, "font")).find((value) => value !== undefined)
  const entry = fonts[Number(font ?? 0)]?.[0].trimEnd()
  return entry ?? null
}

/** A cell's new format body with the style applied, or an error. */
function styled(
  xml: string,
  body: string,
  style: MxlStyle,
  rowBlock: string,
): { xml: string; body: string } | { error: string } {
  let next = body
  let out = xml
  if (style.bold !== undefined || style.size !== undefined) {
    const font = effectiveFont(out, body || undefined, rowBlock)
    if (!font) return { error: "В макете нет палитры шрифтов — сменить шрифт нечему." }
    // A style item or a system font carries no size or weight to change.
    if (!/faceName=/.test(font)) {
      return { error: "Шрифт ячейки задан стилем конфигурации, а не явно — размер и жирность этим инструментом не поменять." }
    }
    const bold = style.bold === undefined ? font : font.replace(/bold="[^"]*"/, `bold="${style.bold}"`)
    const changed = style.size === undefined ? bold : bold.replace(/height="[^"]*"/, `height="${style.size}"`)
    const interned = internFont(out, changed)
    out = interned.xml
    next = setTag(next, "font", String(interned.index))
  }
  if (style.underline !== undefined) {
    // Four sides and the collapsed <border> exclude each other (spec): open it up first.
    const collapsed = tagValue(next, "border")
    if (collapsed !== undefined) {
      next = setTag(next, "border", null)
      for (const side of ["leftBorder", "topBorder", "rightBorder", "bottomBorder"]) next = setTag(next, side, collapsed)
    }
    if (style.underline) {
      const line = thinLine(out)
      if ("error" in line) return line
      out = line.xml
      next = setTag(next, "bottomBorder", String(line.index))
    } else {
      next = setTag(next, "bottomBorder", null)
    }
  }
  if (style.align !== undefined) next = setTag(next, "horizontalAlignment", style.align)
  if (style.wrap !== undefined) next = setTag(next, "textPlacement", style.wrap ? "Wrap" : null)
  return { xml: out, body: next }
}

// ---------------------------------------------------------------------------
// Merges

interface MergeBox {
  /** 1-based anchor and size in cells. */
  readonly row: number
  readonly column: number
  readonly rows: number
  readonly columns: number
}

/**
 * The ordinary merges, anchored at a row. A column merge (`<r>-1</r>`) is left
 * out: it is not a box, and the checks that need it read it from the parsed
 * template. 2026-09-29, debrief15.md §15.21: `<r>` was read as `\d+`, so `-1`
 * came out as row 1 -- a merge nobody had made.
 */
function mergesOf(xml: string): (MergeBox & { readonly start: number; readonly text: string })[] {
  return [...xml.matchAll(MERGE)].flatMap((match) => {
    const block = match[0]
    const number = (tag: string) => Number(new RegExp(`<${tag}>(-?\\d+)</${tag}>`).exec(block)?.[1] ?? 0)
    if (number("r") < 0) return []
    return {
      row: number("r") + 1,
      column: number("c") + 1,
      rows: number("h") + 1,
      columns: number("w") + 1,
      start: match.index ?? 0,
      text: block,
    }
  })
}

/** The column merges of the template, as `1c_mxl_info` reports them. */
const columnMergesOf = (xml: string) => parseMxlTemplate(xml).merges.filter((merge) => merge.row === null)

/** A column merge that still holds over some of the box's columns in some of its rows. */
function columnMergeClash(xml: string, box: MergeBox): MxlMerge | null {
  const rows = Array.from({ length: box.rows }, (_, offset) => box.row + offset)
  return (
    columnMergesOf(xml).find(
      (merge) =>
        box.column < merge.column + merge.columns &&
        merge.column < box.column + box.columns &&
        rows.some((row) => !(merge.exceptRows ?? []).includes(row)),
    ) ?? null
  )
}

const overlaps = (a: MergeBox, b: MergeBox) =>
  a.row < b.row + b.rows && b.row < a.row + a.rows && a.column < b.column + b.columns && b.column < a.column + a.columns

const boxText = (box: MergeBox) => `строка ${box.row}, колонка ${box.column}: ${box.rows} стр. × ${box.columns} кол.`

function mergeXml(box: MergeBox): string {
  return [
    "\t<merge>",
    `\t\t<r>${box.row - 1}</r>`,
    `\t\t<c>${box.column - 1}</c>`,
    ...(box.rows > 1 ? [`\t\t<h>${box.rows - 1}</h>`] : []),
    ...(box.columns > 1 ? [`\t\t<w>${box.columns - 1}</w>`] : []),
    "\t</merge>",
    "",
  ].join("\n")
}

function applyMerge(xml: string, box: MergeBox): { xml: string } | { error: string } {
  if (box.rows < 1 || box.columns < 1 || box.rows * box.columns < 2) {
    return { error: `Объединение ${boxText(box)}: нужно хотя бы две ячейки.` }
  }
  const merges = mergesOf(xml)
  const same = merges.find((item) => item.row === box.row && item.column === box.column)
  const clashing = merges.filter((item) => item !== same && overlaps(item, box))
  if (clashing.length) {
    return {
      error:
        `Объединение ${boxText(box)} задевает другие: ${clashing.map(boxText).join("; ")}. ` +
        "Сначала разъедини их (`unmerge`) или выбери другой размер.",
    }
  }
  const columnMerge = columnMergeClash(xml, box)
  if (columnMerge) {
    return {
      error:
        `Объединение ${boxText(box)} попадает на объединение колонок: ${mergeLabel(columnMerge)}. ` +
        "В этих строках его сначала надо отменить (`unmerge_columns`).",
    }
  }
  // 2026-09-28, debrief15.md §15.18: a title merge one column too wide covered
  // the number cell, and both the title and the number stopped printing.
  const hidden: string[] = []
  for (let row = box.row; row < box.row + box.rows; row++) {
    const found = findRow(xml, row)
    if (!found) continue
    for (const cell of cellsOf(found.block)) {
      const inside = cell.column >= box.column && cell.column < box.column + box.columns
      const anchor = row === box.row && cell.column === box.column
      if (inside && !anchor && hasContent(cell)) hidden.push(`строка ${row}, ${cellLabel(cell)}`)
    }
  }
  if (hidden.length) {
    return {
      error:
        `Объединение ${boxText(box)} накроет ячейки с содержимым: ${hidden.join("; ")}. Внутри объединения ` +
        "печатается только левая верхняя ячейка — остальное пропадёт. Очисти их или выбери другой размер.",
    }
  }
  if (same) return { xml: xml.slice(0, same.start) + mergeXml(box) + xml.slice(same.start + same.text.length) }
  const last = merges.at(-1)
  const at = last
    ? last.start + last.text.length
    : (() => {
        const vg = /^\t<vgRows>\d+<\/vgRows>\n/m.exec(xml)
        return vg ? (vg.index ?? 0) + vg[0].length : -1
      })()
  if (at < 0) return { error: "Не нашёл, куда записать объединение: в макете нет ни объединений, ни <vgRows>." }
  return { xml: xml.slice(0, at) + mergeXml(box) + xml.slice(at) }
}

function applyUnmerge(xml: string, row: number, column: number): { xml: string } | { error: string } {
  const merges = mergesOf(xml)
  const found = merges.find((item) => item.row === row && item.column === column)
  if (!found) {
    const near = merges.filter((item) => item.row === row).map(boxText).join("; ") || "нет"
    return { error: `Объединения с левой верхней ячейкой в строке ${row}, колонке ${column} нет. В этой строке: ${near}.` }
  }
  return { xml: xml.slice(0, found.start) + xml.slice(found.start + found.text.length) }
}

/**
 * Cancels the column merge over `column` in the given rows, a
 * `<verticalUnmerge>` per row, placed after the others (else after the merges)
 * as the platform writes them.
 */
function applyUnmergeColumns(
  xml: string,
  edit: MxlUnmergeColumnsEdit["unmerge_columns"],
): { xml: string; rows: number[] } | { error: string } {
  const merges = columnMergesOf(xml)
  const merge = merges.find((item) => edit.column >= item.column && edit.column < item.column + item.columns)
  if (!merge) {
    const listed = merges.map(mergeLabel).join("; ") || "их в макете нет"
    return { error: `Колонка ${edit.column} не входит ни в одно объединение колонок. Объединения колонок: ${listed}.` }
  }
  const rows = Array.from({ length: edit.rows ?? 1 }, (_, offset) => edit.row + offset).filter(
    (row) => !(merge.exceptRows ?? []).includes(row),
  )
  const entries = rows
    .map((row) =>
      [
        "\t<verticalUnmerge>",
        `\t\t<r>${row - 1}</r>`,
        `\t\t<c>${merge.column - 1}</c>`,
        ...(merge.columns > 1 ? [`\t\t<w>${merge.columns - 1}</w>`] : []),
        "\t</verticalUnmerge>",
        "",
      ].join("\n"),
    )
    .join("")
  const last =
    [...xml.matchAll(/^\t<verticalUnmerge>[\s\S]*?^\t<\/verticalUnmerge>\n/gm)].at(-1) ?? [...xml.matchAll(MERGE)].at(-1)
  if (!last) return { error: "Не нашёл, куда записать отмену объединения." }
  const at = (last.index ?? 0) + last[0].length
  return { xml: xml.slice(0, at) + entries + xml.slice(at), rows }
}

// ---------------------------------------------------------------------------
// Cells

/** Adds an empty cell (with a format, if given) in column order. */
function createCell(xml: string, row: number, column: number, format: number | null): { xml: string } | { error: string } {
  const found = findRow(xml, row)
  if (!found) return { error: `Строки ${row} с ячейками в макете нет.` }
  if (/<indexTo>/.test(found.block)) return { error: `Строка ${row} — часть диапазона пустых строк; ячейку в неё не добавить.` }
  const cells = cellsOf(found.block)
  const indent = "\t\t\t"
  const cell = [
    `${indent}<c>`,
    `${indent}\t<i>${column - 1}</i>`,
    `${indent}\t<c>`,
    ...(format ? [`${indent}\t\t<f>${format}</f>`] : []),
    `${indent}\t</c>`,
    `${indent}</c>`,
  ].join("\n")
  const next = cells.find((item) => item.column > column)
  let block = found.block
  if (next) {
    // The next cell may take its column from its predecessor; after an insert
    // that predecessor is this cell, so it has to say its column outright.
    const fixed = next.declared ? "" : `\n${indent}\t<i>${next.column - 1}</i>`
    const head = block.slice(0, next.outerStart)
    const nextCell = block.slice(next.outerStart, next.outerEnd).replace(/^<c>/, `<c>${fixed}`)
    block = `${head}${cell.trimStart()}\n${indent}${nextCell}${block.slice(next.outerEnd)}`
  } else {
    const last = cells.at(-1)
    if (last) block = `${block.slice(0, last.outerEnd)}\n${cell}${block.slice(last.outerEnd)}`
    else {
      // A row with no cells: `<empty>true</empty>` goes, the cell takes its place.
      const opened = /<row>\n/.exec(block)
      if (!opened) return { error: `Строка ${row}: не нашёл, куда вставить ячейку.` }
      const at = (opened.index ?? 0) + opened[0].length
      block = `${block.slice(0, at)}${cell}\n${block.slice(at)}`.replace(/\n\t*<empty>true<\/empty>/, "")
    }
  }
  return { xml: xml.slice(0, found.start) + block + xml.slice(found.start + found.block.length) }
}

function applyCell(xml: string, edit: MxlCellEdit): { xml: string; change: string } | { error: string } {
  let out = xml
  const exists = () => cellsOf(findRow(out, edit.row)?.block ?? "").some((item) => item.column === edit.column)
  const source = edit.like ? cellsOf(findRow(out, edit.like.row)?.block ?? "").find((item) => item.column === edit.like!.column) : undefined
  if (edit.like && !source) return { error: `Ячейки-образца (строка ${edit.like.row}, колонка ${edit.like.column}) нет.` }
  const likeFormat = source ? Number(/<f>(\d+)<\/f>/.exec(source.inner)?.[1] ?? 0) || null : null
  let created = false
  if (!exists()) {
    const made = createCell(out, edit.row, edit.column, likeFormat)
    if ("error" in made) return made
    out = made.xml
    created = true
  }

  const wanted: FillType | null =
    edit.text !== undefined ? "Text" : edit.template !== undefined ? "Template" : edit.parameter !== undefined ? "Parameter" : null
  const row = findRow(out, edit.row)!
  const cell = cellsOf(row.block).find((item) => item.column === edit.column)!
  const formatIndex = Number(/<f>(\d+)<\/f>/.exec(cell.inner)?.[1] ?? "0")
  // The palette is 1-based; `<f>0</f>` or no <f> means no format of its own (spec).
  const current = formatIndex > 0 ? bodyOf(palettes(out).formats[formatIndex - 1]) : undefined
  // `like` on a cell that is already there: it is to look like that one, so that
  // one's format is the starting point. 2026-09-28, the platform check: splitting
  // a merge leaves blank cells behind it, and a `create` on one of them made
  // nothing -- the text landed in a leftover format that held only `fillType`.
  const start = likeFormat !== null && !created ? bodyOf(palettes(out).formats[likeFormat - 1]) : current
  let body = start ?? ""
  if (wanted && fillTypeOf(start) !== wanted) body = setTag(body, "fillType", wanted === "Text" ? null : wanted)
  if (edit.style) {
    const result = styled(out, body, edit.style, row.block)
    if ("error" in result) return result
    out = result.xml
    body = result.body
  }
  // `newFormat` 0: no format of its own. An empty <format> must never be written:
  // the platform drops it on load and every format after it shifts by one, so
  // other cells print with their neighbour's look (found on the platform check).
  let newFormat: number | null = null
  if (body !== (current ?? "")) {
    if (!body.trim()) newFormat = 0
    else {
      const interned = internFormat(out, body)
      if ("error" in interned) return interned
      out = interned.xml
      newFormat = interned.index
    }
  }

  // The palettes may have grown in front of this row: find it again.
  const again = findRow(out, edit.row)!
  const target = cellsOf(again.block).find((item) => item.column === edit.column)!
  const indent = /\n(\t+)<f>/.exec(target.inner)?.[1] ?? "\t\t\t\t\t"
  let inner = target.inner
  const content = wanted !== null || edit.clear
  if (content) {
    inner = inner
      .replace(/\n\t*<parameter>[^<]*<\/parameter>/g, "")
      .replace(/\n\t*<tl>[\s\S]*?<\/tl>/g, "")
      .replace(/\n\t*<tl\/>/g, "")
  }
  if (newFormat === 0) inner = inner.replace(/\n\t*<f>\d+<\/f>/, "")
  else if (newFormat !== null) {
    inner = /<f>\d+<\/f>/.test(inner)
      ? inner.replace(/<f>\d+<\/f>/, `<f>${newFormat}</f>`)
      : inner.replace(/<c>/, `<c>\n${indent}<f>${newFormat}</f>`)
  }
  const value =
    edit.parameter !== undefined
      ? `\n${indent}<parameter>${escapeXml(edit.parameter)}</parameter>`
      : edit.text !== undefined || edit.template !== undefined
        ? [
            `\n${indent}<tl>`,
            `${indent}\t<v8:item>`,
            `${indent}\t\t<v8:lang>ru</v8:lang>`,
            `${indent}\t\t<v8:content>${escapeXml(edit.text ?? edit.template ?? "")}</v8:content>`,
            `${indent}\t</v8:item>`,
            `${indent}</tl>`,
          ].join("\n")
        : ""
  // Content goes after <f> (or right after <c>), before the closing tag's whitespace.
  if (value) inner = /<f>\d+<\/f>/.test(inner) ? inner.replace(/(<f>\d+<\/f>)/, `$1${value}`) : inner.replace(/<c>/, `<c>${value}`)
  out = out.slice(0, again.start + target.innerStart) + inner + out.slice(again.start + target.innerEnd)

  const described = [
    ...(created ? ["создана"] : []),
    ...(edit.parameter !== undefined
      ? [`параметр <${edit.parameter}>`]
      : edit.text !== undefined
        ? [`текст ${JSON.stringify(edit.text)}`]
        : edit.template !== undefined
          ? [`шаблон ${JSON.stringify(edit.template)}`]
          : edit.clear
            ? ["пусто"]
            : []),
    ...(edit.style ? [`оформление ${JSON.stringify(edit.style)}`] : []),
  ].join(", ")
  return { xml: out, change: `строка ${edit.row}, колонка ${edit.column}: ${described}${newFormat === 0 ? " (без своего формата)" : newFormat !== null ? ` (формат ${newFormat})` : ""}` }
}

/** What an edit asks for is one thing, and says so. */
function malformed(edit: MxlEdit): string | null {
  if (!isCell(edit)) return null
  const kinds = [edit.text !== undefined, edit.template !== undefined, edit.parameter !== undefined, edit.clear === true]
  if (kinds.filter(Boolean).length > 1) return `Строка ${edit.row}, колонка ${edit.column}: не больше одного из text, template, parameter, clear.`
  if (!kinds.some(Boolean) && !edit.style && !edit.create) {
    return `Строка ${edit.row}, колонка ${edit.column}: нечего менять — нужно одно из text, template, parameter, clear или style.`
  }
  return null
}

/**
 * Applies the edits in order. Nothing is written unless every edit applies.
 *
 * Afterwards the geometry is checked against what was asked: the same rows and
 * areas, and exactly the merges the edits set.
 */
export function editMxlCells(file: string, edits: readonly MxlEdit[]): MxlEditResult {
  // The platform writes CRLF. Everything below matches line by line with `\n`,
  // so the file is edited as LF and given its own line ends back. 2026-09-28:
  // the first platform check found cloned formats emptied and a new font glued
  // to the previous one's line -- the unit fixtures had all been LF.
  const crlf = file.includes("\r\n")
  const original = crlf ? file.replace(/\r\n/g, "\n") : file
  const bad = edits.map(malformed).find((error) => error !== null)
  if (bad) return { ok: false, error: bad }
  const missing = missingCells(original, edits)
  if (missing) return { ok: false, error: missing }

  let xml = original
  const changes: string[] = []
  for (const edit of edits) {
    if (isMerge(edit)) {
      const result = applyMerge(xml, edit.merge)
      if ("error" in result) return { ok: false, error: result.error }
      xml = result.xml
      changes.push(`объединение: ${boxText(edit.merge)}`)
      continue
    }
    if (isUnmerge(edit)) {
      const result = applyUnmerge(xml, edit.unmerge.row, edit.unmerge.column)
      if ("error" in result) return { ok: false, error: result.error }
      xml = result.xml
      changes.push(`разъединено: строка ${edit.unmerge.row}, колонка ${edit.unmerge.column}`)
      continue
    }
    if (isUnmergeColumns(edit)) {
      const result = applyUnmergeColumns(xml, edit.unmerge_columns)
      if ("error" in result) return { ok: false, error: result.error }
      xml = result.xml
      changes.push(
        result.rows.length
          ? `объединение колонок отменено в строках ${result.rows.join(", ")}`
          : "объединение колонок в этих строках уже отменено — ничего не менял",
      )
      continue
    }
    const result = applyCell(xml, edit)
    if ("error" in result) return { ok: false, error: result.error }
    xml = result.xml
    changes.push(result.change)
  }

  const before = parseMxlTemplate(original)
  const after = parseMxlTemplate(xml)
  const key = (box: MxlMerge) =>
    `${box.row}:${box.column}:${box.rows}:${box.columns}:${[...(box.exceptRows ?? [])].sort((a, b) => a - b).join(",")}`
  const expected = new Map<string, MxlMerge>(before.merges.map((box) => [`${box.row}:${box.column}`, box]))
  for (const edit of edits) {
    if (isMerge(edit)) expected.set(`${edit.merge.row}:${edit.merge.column}`, edit.merge)
    if (isUnmerge(edit)) expected.delete(`${edit.unmerge.row}:${edit.unmerge.column}`)
    if (isUnmergeColumns(edit)) {
      const cancel = edit.unmerge_columns
      const added = Array.from({ length: cancel.rows ?? 1 }, (_, offset) => cancel.row + offset)
      for (const [at, box] of expected) {
        if (box.row !== null || cancel.column < box.column || cancel.column >= box.column + box.columns) continue
        expected.set(at, { ...box, exceptRows: [...new Set([...(box.exceptRows ?? []), ...added])] })
      }
    }
  }
  const sameMerges = JSON.stringify([...expected.values()].map(key).sort()) === JSON.stringify(after.merges.map(key).sort())
  const sameShape = before.rows.length === after.rows.length && JSON.stringify(before.areas) === JSON.stringify(after.areas)
  if (!sameMerges || !sameShape) return { ok: false, error: "После правки геометрия макета не та, что заказана — правка отменена." }
  if (/^\t<format>\n\t<\/format>/m.test(xml) && !/^\t<format>\n\t<\/format>/m.test(original)) {
    return { ok: false, error: "После правки в палитре оказался пустой формат — правка отменена." }
  }
  // 2026-09-29, debrief15.md §15.21: a title anchor moved into column 3, inside
  // a column merge, and printed nothing. Whatever the edits, text that printed
  // before and is covered by a merge now is refused, with the merge named.
  const wasHidden = new Set(hiddenCells(before).map((cell) => `${cell.row}:${cell.column}`))
  const nowHidden = hiddenCells(after).filter((cell) => !wasHidden.has(`${cell.row}:${cell.column}`))
  if (nowHidden.length) {
    return {
      ok: false,
      error:
        "После правки не напечатаются ячейки с содержимым — в объединении печатается только его первая ячейка: " +
        nowHidden.map((cell) => `строка ${cell.row}, колонка ${cell.column} (${mergeLabel(cell.anchor)})`).join("; ") +
        ". Правка отменена. " +
        (nowHidden.some((cell) => cell.anchor.row === null)
          ? "Объединение колонок в нужных строках отменяет `unmerge_columns`."
          : "Объединение разъединяет `unmerge`."),
    }
  }
  const duplicated = after.duplicates.filter((cell) => !before.duplicates.some((item) => item.row === cell.row && item.column === cell.column))
  if (duplicated.length) return { ok: false, error: "После правки в строке оказались две ячейки в одной колонке — правка отменена." }
  // CRLF between elements, a bare LF inside a multi-line text: that is how the
  // platform writes it (ПФ_MXL_Т1: 2021 CRLF, and 6 LF, all inside <v8:content>).
  const out = crlf
    ? xml.replace(/\n/g, "\r\n").replace(/<v8:content>[\s\S]*?<\/v8:content>/g, (text) => text.replace(/\r\n/g, "\n"))
    : xml
  return { ok: true, xml: out, changes }
}
