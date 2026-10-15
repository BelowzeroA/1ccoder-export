// Reading a макет's structure, so nobody has to do it with regexes again.
//
// 2026-09-23, debrief9.md §9.8 / failures_to_tools.md G7. Two runs of two went
// the same way: the agent needed the structure of a supplied макет, decided the
// vendored `/mxl-*` skills did not apply, and hand-rolled PowerShell regex over
// `Template.xml` for fifteen minutes. It got the row numbering wrong -- rows its
// pattern did not match still consumed an index -- and matched `<font>` and
// `<format>` blocks of 14 and 40 characters. It then stopped itself ("let me
// stop the XML archaeology") and worked from the live object model instead.
//
// The object model is the right place for most questions, but not for the one
// that actually cost the run. The heading printed one character per line because
// 1-based row 24 is the lower half of the title cell's VERTICAL MERGE, and the
// object model exposes no merge information at all. Only the XML has it. So this
// is the tool for exactly the facts the runtime cannot answer.
//
// Everything is reported in 1C's own 1-based coordinates, because the 0-based
// XML against 1-based runtime confusion is itself a recorded failure (debrief6
// §5, debrief7 §6.4).
//
// Parsed with regexes rather than an XML parser: the file is machine-generated
// and rigidly regular, the fields wanted are scalars, and a dependency-free
// module is what the plugin bundle can carry. The patterns anchor on the
// one-tab indentation the platform writes, which is what keeps a nested
// `<format>` inside a drawing out of the palette.

/** Field semantics follow `resources/vendor/cc-1c-skills/reference/1c-spreadsheet-spec.md`. */
export interface MxlArea {
  readonly name: string
  /** "Rows", "Columns" or "Table". */
  readonly kind: string
  /** 1-based and inclusive; null where the XML says -1, meaning "all". */
  readonly firstRow: number | null
  readonly lastRow: number | null
  readonly firstColumn: number | null
  readonly lastColumn: number | null
}

export interface MxlMerge {
  /**
   * 1-based anchor row; null for a column merge (`<r>-1</r>`): the columns are
   * merged in every row, each row's cell at `column` being that row's anchor.
   */
  readonly row: number | null
  readonly column: number
  readonly rows: number
  readonly columns: number
  /** For a column merge: the 1-based rows where `<verticalUnmerge>` cancels it. */
  readonly exceptRows?: readonly number[]
}

export interface MxlRow {
  /** 1-based. */
  readonly index: number
  readonly empty: boolean
  /** Rows with no formatIndex have no height of their own. */
  readonly formatIndex: number | null
  readonly height: number | null
  /** Cell contents worth naming: parameters and literal text, by 1-based column, with the cell's format. */
  readonly cells: readonly { readonly column: number; readonly parameter?: string; readonly text?: string; readonly format?: number }[]
}

export interface MxlTemplate {
  readonly rows: readonly MxlRow[]
  readonly areas: readonly MxlArea[]
  readonly merges: readonly MxlMerge[]
  /** Heights from the format palette, indexed as the file orders them. */
  readonly formatHeights: readonly (number | null)[]
  /** The font palette, in file order, as `Arial 14.3 bold`. */
  readonly fonts: readonly string[]
  /** Each format of the palette, 1-based number → what it sets, in words. */
  readonly formats: readonly string[]
  /** Two cells in one row claiming the same column: a damaged template. */
  readonly duplicates: readonly { readonly row: number; readonly column: number }[]
  /** Column widths from the `<columns>` block, by 1-based column (index 0 = column 1), in 1/8 of a character. */
  readonly columnWidths: readonly (number | null)[]
}

const int = (value: string | undefined): number | null => {
  if (value === undefined) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? null : parsed
}

/** -1 means "every row/column"; 1C would show no bound at all. */
const oneBased = (value: number | null): number | null => (value === null || value < 0 ? null : value + 1)

/**
 * One format in words: what it sets, not what the cell ends up with.
 *
 * 2026-09-28, debrief15.md §15.14 item 1: the report named a cell's format by
 * number and never said what was in it, so an agent parsed the palette itself,
 * counted it from zero and read the neighbouring format each time. Font and
 * line numbers are 0-based (spec) and are resolved here, so nobody has to.
 */
function describeFormat(body: string, fonts: readonly string[], lines: readonly string[]): string {
  const tag = (name: string) => new RegExp(`^\\t\\t<${name}>([^<]*)</${name}>`, "m").exec(body)?.[1]
  const line = (value: string | undefined) => (value === undefined ? undefined : (lines[Number(value)] ?? `линия ${value}`))
  const parts: string[] = []
  const font = tag("font")
  if (font !== undefined) parts.push(`шрифт ${fonts[Number(font)] ?? `№${font}`}`)
  const border = line(tag("border"))
  if (border) parts.push(`рамка: ${border}`)
  const sides = (
    [
      ["слева", "leftBorder"],
      ["сверху", "topBorder"],
      ["справа", "rightBorder"],
      ["снизу", "bottomBorder"],
    ] as const
  ).flatMap(([side, name]) => {
    const value = line(tag(name))
    return value ? [`${side} ${value}`] : []
  })
  if (sides.length) parts.push(`границы: ${sides.join(", ")}`)
  const width = tag("width")
  if (width) parts.push(`ширина ${width}`)
  const height = tag("height")
  if (height) parts.push(`высота ${height}`)
  const horizontal = tag("horizontalAlignment")
  if (horizontal) parts.push(`по горизонтали ${horizontal}`)
  const placement = tag("textPlacement")
  if (placement) parts.push(placement === "Wrap" ? "перенос" : `размещение ${placement}`)
  parts.push(`заполнение ${tag("fillType") ?? "Text"}`)
  const format = /<v8:content>([^<]*)<\/v8:content>/.exec(body)?.[1]
  if (format) parts.push(`формат «${format}»`)
  return parts.join("; ")
}

export function parseMxlTemplate(xml: string): MxlTemplate {
  // The palette: top-level <format> siblings, position = index.
  const formatBodies = [...xml.matchAll(/^\t<format>([\s\S]*?)^\t<\/format>/gm)].map((match) => match[1] ?? "")
  const formatHeights = formatBodies.map((body) => int(/<height>(-?\d+)<\/height>/.exec(body)?.[1]))
  // The line palette: a border names a line by 0-based number.
  const lines = [...xml.matchAll(/^\t<line\s([^>]*)>([\s\S]*?)^\t<\/line>/gm)].map((match) => {
    const width = /width="(\d+)"/.exec(match[1] ?? "")?.[1] ?? "?"
    const style = />(\w+)<\/v8ui:style>/.exec(match[2] ?? "")?.[1] ?? "?"
    return style === "None" ? "нет" : `${style === "Solid" ? "сплошная" : style} ${width}`
  })

  // 2026-09-24. The run after this tool shipped used it for the merges, then
  // spent seven minutes in PowerShell looking for the title's font -- because
  // the title cell's format (`<f>54</f>`) carries only `<height>28</height>`,
  // and the spec's «один формат обслуживает всех» means cell, row, column and
  // `<defaultFormatIndex>` all index one palette, so an unspecified font is
  // inherited rather than absent. Listing the palette answers "what fonts does
  // this макет use at all"; the effective font of a given cell is a question for
  // the object model, and the report says so rather than guessing the cascade.
  const fonts = [...xml.matchAll(/<font\s([^>]*)\/?>/g)].flatMap((match) => {
    const attributes = match[1] ?? ""
    const face = /faceName="([^"]*)"/.exec(attributes)?.[1]
    if (!face) return []
    const size = /height="([^"]*)"/.exec(attributes)?.[1] ?? "?"
    const bold = /bold="true"/.test(attributes) ? " bold" : ""
    const italic = /italic="true"/.test(attributes) ? " italic" : ""
    return [`${face} ${size}${bold}${italic}`]
  })

  const rows: MxlRow[] = []
  const duplicates: { row: number; column: number }[] = []
  for (const item of xml.matchAll(/^\t<rowsItem>([\s\S]*?)^\t<\/rowsItem>/gm)) {
    const block = item[1] ?? ""
    const from = int(/<index>(\d+)<\/index>/.exec(block)?.[1])
    if (from === null) continue
    // <indexTo> collapses a RANGE of identical empty rows into one element. This
    // is what made the hand-rolled pass miscount: one element is not one row.
    const to = int(/<indexTo>(\d+)<\/indexTo>/.exec(block)?.[1]) ?? from
    const empty = /<empty>\s*true\s*<\/empty>/.test(block)
    // The palette is 1-based and 0 means "no format" (spec). 2026-09-28,
    // debrief15.md §15.12: read 0-based until then, so every height reported
    // came from the neighbouring format. Checked on a real template: 72 formats,
    // cells referring to <f>72</f>.
    const declaredFormat = int(/<formatIndex>(\d+)<\/formatIndex>/.exec(block)?.[1])
    const formatIndex = declaredFormat === 0 ? null : declaredFormat
    const height = formatIndex === null ? null : (formatHeights[formatIndex - 1] ?? null)

    // Cells: `<i>` is written only when the sequence breaks, so an absent one
    // means "the column after the previous cell", and the first such cell is
    // column 0.
    const cells: { column: number; parameter?: string; text?: string; format?: number }[] = []
    const seen = new Set<number>()
    let column = -1
    for (const cell of block.matchAll(/<c>\s*(?:<i>(\d+)<\/i>)?([\s\S]*?)<\/c>\s*<\/c>/g)) {
      const declared = int(cell[1])
      column = declared === null ? column + 1 : declared
      // debrief15.md §15.14 item 2: a retried script wrote a second cell at a
      // column that had one, and nothing reported it -- the platform built it.
      if (seen.has(column)) duplicates.push({ row: from + 1, column: column + 1 })
      seen.add(column)
      const inner = cell[2] ?? ""
      const format = int(/<f>(\d+)<\/f>/.exec(inner)?.[1]) ?? undefined
      const parameter = /<parameter>([^<]*)<\/parameter>/.exec(inner)?.[1]
      // Cell text lives in <tl><v8:item><v8:lang>…<v8:content>…; the Russian one
      // if there are several. 2026-09-28, debrief15.md: read as <text>, which the
      // platform never writes, so no caption was ever shown and an agent went
      // back to parsing the XML by hand to find them.
      const items = [...inner.matchAll(/<v8:lang>([^<]*)<\/v8:lang>\s*<v8:content>([^<]*)<\/v8:content>/g)]
      const text = (items.find((item) => item[1] === "ru") ?? items[0])?.[2]
        ?.replace(/&quot;/g, '"')
        .replace(/&gt;/g, ">")
        .replace(/&lt;/g, "<")
        .replace(/&amp;/g, "&")
      if (parameter || text) {
        cells.push({
          column: column + 1,
          ...(parameter ? { parameter } : {}),
          ...(text ? { text } : {}),
          ...(format ? { format } : {}),
        })
      }
    }

    for (let index = from; index <= to; index++) rows.push({ index: index + 1, empty, formatIndex, height, cells })
  }

  const areas = [...xml.matchAll(/<namedItem[^>]*>([\s\S]*?)<\/namedItem>/g)].flatMap((item) => {
    const block = item[1] ?? ""
    const name = /<name>([^<]*)<\/name>/.exec(block)?.[1]
    if (!name) return []
    return [
      {
        name,
        kind: /<type>([^<]*)<\/type>/.exec(block)?.[1] ?? "unknown",
        firstRow: oneBased(int(/<beginRow>(-?\d+)<\/beginRow>/.exec(block)?.[1])),
        lastRow: oneBased(int(/<endRow>(-?\d+)<\/endRow>/.exec(block)?.[1])),
        firstColumn: oneBased(int(/<beginColumn>(-?\d+)<\/beginColumn>/.exec(block)?.[1])),
        lastColumn: oneBased(int(/<endColumn>(-?\d+)<\/endColumn>/.exec(block)?.[1])),
      },
    ]
  })

  // <verticalUnmerge r c w> cancels, in row r, the column merge over columns
  // c..c+w (spec). A merge cancelled for a row is not a merge there, and
  // reporting it as one would recreate the false belief this tool exists to
  // prevent. The same entry on an ordinary merge anchored at r:c drops it.
  const unmerges = [...xml.matchAll(/<verticalUnmerge>([\s\S]*?)<\/verticalUnmerge>/g)].map((item) => {
    const block = item[1] ?? ""
    return {
      row: int(/<r>(-?\d+)<\/r>/.exec(block)?.[1]),
      column: int(/<c>(-?\d+)<\/c>/.exec(block)?.[1]),
      w: int(/<w>(\d+)<\/w>/.exec(block)?.[1]) ?? 0,
    }
  })

  const merges = [...xml.matchAll(/<merge>([\s\S]*?)<\/merge>/g)].flatMap((item): MxlMerge[] => {
    const block = item[1] ?? ""
    const row = int(/<r>(-?\d+)<\/r>/.exec(block)?.[1])
    const col = int(/<c>(-?\d+)<\/c>/.exec(block)?.[1])
    if (col === null) return []
    const w = int(/<w>(\d+)<\/w>/.exec(block)?.[1]) ?? 0
    // Spec: size is (h + 1) rows by (w + 1) columns; an absent <h> is one row.
    const size = { column: col + 1, rows: (int(/<h>(\d+)<\/h>/.exec(block)?.[1]) ?? 0) + 1, columns: w + 1 }
    // 2026-09-29, debrief15.md §15.21: `ПФ_MXL_Т1` merges columns 2–4 in every
    // row (`<r>-1</r>`), cancelled in six rows. Read as "row 1" (or not at all),
    // it let a title anchor move into column 3, where nothing prints.
    if (row === -1) {
      const exceptRows = unmerges.filter((u) => u.column === col && u.w === w && u.row !== null).map((u) => u.row! + 1)
      return [{ row: null, ...size, exceptRows }]
    }
    if (unmerges.some((u) => u.row === row && u.column === col)) return []
    return [{ row: oneBased(row), ...size }]
  })

  // Column widths: <columnsItem><index>0-based</index><column><formatIndex>1-based</formatIndex>.
  const columnWidths: (number | null)[] = []
  for (const item of xml.matchAll(/<columnsItem>([\s\S]*?)<\/columnsItem>/g)) {
    const index = int(/<index>(\d+)<\/index>/.exec(item[1] ?? "")?.[1])
    const format = int(/<formatIndex>(\d+)<\/formatIndex>/.exec(item[1] ?? "")?.[1])
    if (index === null) continue
    columnWidths[index] = format ? int(/<width>(\d+)<\/width>/.exec(formatBodies[format - 1] ?? "")?.[1]) : null
  }

  const formats = formatBodies.map((body) => describeFormat(body, fonts, lines))
  return { rows, areas, merges, formatHeights, fonts, formats, duplicates, columnWidths: [...columnWidths].map((value) => value ?? null) }
}

/**
 * The merge that hides this cell, if any: it lies inside a merge and is not its
 * anchor. Only a merge's anchor prints. A column merge's anchor is its first
 * column, in every row it is not cancelled in.
 */
export function hidingMerge(template: MxlTemplate, row: number, column: number): MxlMerge | null {
  for (const merge of template.merges) {
    const inColumns = column >= merge.column && column < merge.column + merge.columns
    if (!inColumns) continue
    if (merge.row === null) {
      if (column !== merge.column && !(merge.exceptRows ?? []).includes(row)) return merge
      continue
    }
    const inRows = row >= merge.row && row < merge.row + merge.rows
    if (inRows && !(row === merge.row && column === merge.column)) return merge
  }
  return null
}

/** A merge as the reports name it. */
export function mergeLabel(merge: MxlMerge): string {
  const columns = merge.columns > 1 ? `колонки ${merge.column}–${merge.column + merge.columns - 1}` : `колонка ${merge.column}`
  if (merge.row !== null) return `строка ${merge.row}, колонка ${merge.column}: ${merge.rows} стр. × ${merge.columns} кол.`
  const except = merge.exceptRows?.length ? `, кроме строк ${merge.exceptRows.join(", ")}` : ""
  return `${columns} объединены во всех строках${except}`
}

/**
 * Cells with content that a merge covers without being its anchor.
 *
 * Only the top-left cell of a merge prints. 2026-09-28, debrief15.md §15.18: a
 * title merge widened by one column covered the number cell, and both stopped
 * printing -- with nothing in the template to say why.
 */
export function hiddenCells(template: MxlTemplate): { row: number; column: number; anchor: MxlMerge }[] {
  return template.rows.flatMap((row) =>
    row.cells.flatMap((cell) => {
      const anchor = hidingMerge(template, row.index, cell.column)
      return anchor ? [{ row: row.index, column: cell.column, anchor }] : []
    }),
  )
}

/**
 * Rows that are the continuation of a cell above them.
 *
 * The single most useful thing here, and the fact the 09-23 run needed: such a
 * row looks empty and free in every view, and writing into it destroys the
 * merge that owns it.
 */
export function mergeTailRows(template: MxlTemplate): ReadonlyMap<number, number> {
  const tails = new Map<number, number>()
  for (const merge of template.merges) {
    if (merge.row === null || merge.rows < 2) continue
    for (let offset = 1; offset < merge.rows; offset++) tails.set(merge.row + offset, merge.row)
  }
  return tails
}

/** What the agent reads. 1-based throughout, and the warnings come first. */
export function describeMxlTemplate(template: MxlTemplate, area?: string): string {
  const tails = mergeTailRows(template)
  const areas = area ? template.areas.filter((item) => item.name === area) : template.areas
  const lines: string[] = []

  if (area && areas.length === 0) {
    const names = template.areas.map((item) => item.name).join(", ")
    return `Область «${area}» не найдена. Есть: ${names}`
  }

  lines.push(`Строк: ${template.rows.length}, областей: ${template.areas.length}, объединений: ${template.merges.length}`)
  lines.push("Всё ниже — в нумерации 1С, с единицы.")

  if (template.duplicates.length) {
    lines.push(
      "",
      "**Макет повреждён: две ячейки в одной колонке** — " +
        template.duplicates.map((cell) => `строка ${cell.row}, колонка ${cell.column}`).join("; ") +
        ". Какую из них напечатает платформа, не определено. Оставь одну.",
    )
  }
  const hidden = hiddenCells(template)
  if (hidden.length) {
    lines.push(
      "",
      "**Не напечатается** — ячейки с содержимым внутри объединения, не в его левом верхнем углу: " +
        hidden
          .map((cell) => `строка ${cell.row}, колонка ${cell.column} (${mergeLabel(cell.anchor)})`)
          .join("; ") +
        ".",
    )
  }

  lines.push("", "## Области")
  for (const item of areas) {
    const rowsPart = item.firstRow === null ? "все строки" : `строки ${item.firstRow}..${item.lastRow}`
    const colsPart = item.firstColumn === null ? "все колонки" : `колонки ${item.firstColumn}..${item.lastColumn}`
    lines.push(`- ${item.name} (${item.kind}): ${rowsPart}, ${colsPart}`)
  }

  const shown = areas.filter((item) => item.firstRow !== null)
  const inScope = (row: MxlRow) =>
    !area || shown.some((item) => row.index >= (item.firstRow ?? 0) && row.index <= (item.lastRow ?? 0))

  lines.push("", "## Строки")
  for (const row of template.rows.filter(inScope)) {
    const notes: string[] = []
    const anchor = tails.get(row.index)
    if (anchor !== undefined)
      notes.push(`**продолжение ячейки из строки ${anchor}** — писать сюда нельзя, объединение сломается`)
    // Three different states, and the difference is the one that matters: a row
    // with no format has no height at all, while a row whose format sets only a
    // border has a format and still no height of its own.
    if (row.formatIndex === null) notes.push("нет формата, а значит и своей высоты")
    else if (row.height === null) notes.push(`формат ${row.formatIndex}, высота в нём не задана`)
    else notes.push(`высота ${row.height}`)
    if (row.empty) notes.push("помечена пустой")
    const content = row.cells
      .map(
        (cell) =>
          `кол.${cell.column}${cell.format ? ` [ф${cell.format}]` : ""}: ${cell.parameter ? `<${cell.parameter}>` : JSON.stringify(cell.text)}`,
      )
      .join("; ")
    lines.push(`- строка ${row.index}: ${notes.join(", ")}${content ? ` | ${content}` : ""}`)
  }

  const used = [...new Set(template.rows.filter(inScope).flatMap((row) => row.cells.flatMap((cell) => (cell.format ? [cell.format] : []))))].sort(
    (a, b) => a - b,
  )
  if (used.length) {
    lines.push("", "## Форматы ячеек выше")
    lines.push("[фN] — N-й формат палитры, с единицы. Здесь — что в нём задано; чего нет, то наследуется.")
    for (const index of used) lines.push(`- ф${index}: ${template.formats[index - 1] ?? "нет такого формата"}`)
  }

  // 2026-09-24. Added because the run that first used this tool got the merges
  // from it and then spent seven minutes in PowerShell after the title's font,
  // which is not in the cell's format at all: formats cascade, and the runtime
  // is what resolves them. Naming the palette and the working call is worth more
  // than reimplementing the cascade here and being subtly wrong about it.
  if (template.fonts.length) {
    lines.push("", "## Шрифты макета")
    lines.push("Номера — с нуля: так их считает `<font>N</font>` в формате.")
    lines.push(template.fonts.map((font, index) => `${index}: ${font}`).join(" | "))
    lines.push(
      "",
      "Это палитра, а не соответствие ячейкам. Один формат обслуживает всех: ячейка (`<f>`),",
      "строка и колонка (`<formatIndex>`) и документ (`<defaultFormatIndex>`) индексируют одну",
      "палитру, поэтому у формата ячейки шрифта может не быть вовсе — он наследуется. **Действующее",
      "оформление ячейки спрашивай у объектной модели, а не у XML:**",
      "",
      "    Ячейка = Макет.Область(\"R23C2\");",
      "    Результат = Ячейка.Шрифт.Имя + \"/\" + Ячейка.Шрифт.Размер + \"/жирный=\" + Ячейка.Шрифт.Жирный",
      "        + \" гор=\" + Ячейка.ГоризонтальноеПоложение + \" перенос=\" + Ячейка.РазмещениеТекста;",
      "",
      "Курсив — это `Шрифт.Наклонный`, не «Курсив». Границы печатай целиком (`Строка(Ячейка.ГраницаСнизу)`):",
      "у линии нет свойства `СтильЛинии`.",
    )
  }

  // 2026-09-29, debrief15.md §15.21: only vertical merges were listed, so the
  // agent read horizontal ones and column widths out of the XML by hand, and a
  // column merge (`<r>-1</r>`) was not listed at all.
  const rowsShown = template.rows.filter(inScope).map((row) => row.index)
  const onRows = template.merges.filter(
    (merge) => merge.row !== null && rowsShown.some((index) => index >= merge.row! && index < merge.row! + merge.rows),
  )
  if (onRows.length) {
    lines.push("", "## Объединения в строках выше")
    lines.push("Печатается только левая верхняя ячейка объединения. Вертикальные — те, из-за которых строка может выглядеть свободной.")
    for (const merge of onRows) {
      const span = merge.rows > 1 ? ` (занимает строки ${merge.row}..${merge.row! + merge.rows - 1})` : ""
      lines.push(`- ${mergeLabel(merge)}${span}`)
    }
  }
  const byColumns = template.merges.filter((merge) => merge.row === null)
  if (byColumns.length) {
    lines.push("", "## Объединения колонок (во всех строках)")
    lines.push(
      "В каждой строке эти колонки — одна ячейка с углом в первой из них: текст в остальных не печатается. " +
        "Отменить объединение в нужных строках — `unmerge_columns` в 1c_mxl_edit.",
    )
    for (const merge of byColumns) lines.push(`- ${mergeLabel(merge)}`)
  }
  if (template.columnWidths.some((width) => width !== null)) {
    lines.push("", "## Ширины колонок")
    lines.push(
      template.columnWidths.map((width, index) => `${index + 1}: ${width ?? "—"}`).join(" | ") +
        " (в 1/8 символа: 72 — это 9 символов)",
    )
  }

  return lines.join("\n")
}
