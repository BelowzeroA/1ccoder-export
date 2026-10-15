// Comparing a print with its sample, field by field, before it is registered.
//
// 2026-09-29, debrief15.md §15.24 item 31. Three runs in a row an agent said
// its print matched the sample while fields were wrong: a pen-written date
// printed, one field where the sample has two, a description where the sample
// has an amount. The skill asked for a field-by-field comparison each time,
// and each time the comparison covered only what the agent was already looking
// at. So the comparison is now a table the agent has to hand in, with the
// contradictions a table can show refused, and registration waits for it.

import { writeTargets } from "./writes"

export interface SampleField {
  /** What the field is: «дата ознакомления», «условия приема на работу». */
  readonly field: string
  /** What the sample shows there; «пусто» for a blank, and say when it is handwriting. */
  readonly sample: string
  /** What the print shows there; «пусто» for a blank. */
  readonly print: string
  readonly match: boolean
  /** For a field that differs: why it may stay so, or what will be fixed. */
  readonly reason?: string
}

export interface SampleCheck {
  readonly epf: string
  /** The build compared: registration of a later build needs a new comparison. */
  readonly epfModified: number
  readonly rows: readonly SampleField[]
}

/** File facts the check needs; injected so tests need no files. */
export type FileTime = (path: string) => number | null

const MIN_FIELDS = 5

// «пусто», «(пусто)», «—», «-», «""», «нет»: a blank however it is written.
const BLANK = /^\s*(?:\(?пуст[а-яё]*\)?|[—–-]+|""|«»|нет|ничего)?\s*$/i
const HANDWRITING = /от руки|рукой|рукоп|ручкой|вписан/i

const isBlank = (value: string) => BLANK.test(value) || /^\s*\(?пуст/i.test(value)

/** Contradictions a row can show by itself. */
function rowProblem(row: SampleField): string | null {
  const name = row.field.trim() || "(поле без названия)"
  if (!row.match) {
    return row.reason?.trim() ? null : `«${name}»: отличается, а причины нет — исправь или напиши, почему остаётся так.`
  }
  // debrief15.md §15.24: the pen-written acknowledgement date was printed and
  // listed among the fields that matched.
  if (HANDWRITING.test(row.sample) && !isBlank(row.print)) {
    return (
      `«${name}»: в образце вписано от руки, а в печати «${row.print}» — это не совпадение. ` +
      "Место для записи от руки печать оставляет пустым."
    )
  }
  // A handwritten field is a blank the print leaves: a blank print matches it.
  if ((isBlank(row.sample) || HANDWRITING.test(row.sample)) !== isBlank(row.print)) {
    return `«${name}»: с одной стороны пусто, с другой «${isBlank(row.sample) ? row.print : row.sample}» — это не совпадение.`
  }
  return null
}

export function checkComparison(
  args: { readonly sample: string; readonly print: string; readonly epf: string; readonly fields: readonly SampleField[] },
  modified: FileTime,
): { ok: true; check: SampleCheck; report: string } | { ok: false; error: string } {
  const missing = (["sample", "print", "epf"] as const).filter((key) => modified(args[key]) === null)
  if (missing.length) return { ok: false, error: `Нет файла: ${missing.map((key) => `${key} = ${args[key]}`).join("; ")}.` }
  const epfModified = modified(args.epf)!
  if (modified(args.print)! < epfModified) {
    return {
      ok: false,
      error: "PDF старше сборки обработки: сверять надо печать текущей сборки. Напечатай заново и сверь этот PDF.",
    }
  }
  if (args.fields.length < MIN_FIELDS) {
    return {
      ok: false,
      error:
        `Полей в сверке ${args.fields.length}. Пройди каждое поле образца сверху вниз — шапку, каждую подпись, ` +
        "каждое значение, каждую пустую строку для записи от руки, — а не только те, что правил.",
    }
  }
  const problems = args.fields.map(rowProblem).filter((problem): problem is string => problem !== null)
  if (problems.length) return { ok: false, error: ["Сверка не принята:", ...problems.map((problem) => `- ${problem}`)].join("\n") }

  const cell = (text: string) => text.replace(/\|/g, "/").replace(/\s+/g, " ").trim()
  const differing = args.fields.filter((row) => !row.match)
  const report = [
    "| Поле | Образец | Печать | Совпало |",
    "|---|---|---|---|",
    ...args.fields.map(
      (row) => `| ${cell(row.field)} | ${cell(row.sample)} | ${cell(row.print)} | ${row.match ? "да" : `нет: ${cell(row.reason ?? "")}`} |`,
    ),
  ].join("\n")
  return { ok: true, check: { epf: args.epf, epfModified, rows: args.fields }, report: `${report}\n\nОтличий: ${differing.length}.` }
}

const REGISTRY = "Справочник.ДополнительныеОтчетыИОбработки"

/**
 * Why this code may not run yet, if it registers a processing: no comparison
 * in this session, or the build changed since. Null for any other code.
 */
export function registrationRefusal(code: string, check: SampleCheck | undefined, modified: FileTime): string | null {
  if (!writeTargets(code).includes(REGISTRY)) return null
  if (!check) {
    return (
      "Регистрация обработки — после сверки печати с образцом. Напечатай текущую сборку в PDF, пройди поля " +
      "образца и передай их в `1c_compare_with_sample`; потом регистрируй. Если образца нет, так и передай: " +
      "sample — файл задания, в полях — что задание требует."
    )
  }
  if (modified(check.epf) !== check.epfModified) {
    return (
      `Обработку пересобрали после сверки (${check.epf}). Регистрируется то, что сверено: напечатай новую ` +
      "сборку, сверь её через `1c_compare_with_sample` и регистрируй."
    )
  }
  return null
}
