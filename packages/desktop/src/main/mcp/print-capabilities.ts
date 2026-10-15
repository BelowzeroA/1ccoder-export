// What this base offers for print forms, as facts rather than as a skill's claims.
//
// 2026-09-25, skills_rebuild_plan.md Part 2.5. The print-forms skill used to
// assert which БСП objects exist, and verification against three dumps found it
// wrong for some of them: МакетыПечатныхФорм is absent in УТ 11.5.7, and
// УправлениеПечатью.СформироватьВнешнююПечатнуюФорму exists there but is not
// exported. The objects differ by БСП version, so the answer belongs to the
// base, and a tool result is the form of fact the agent acts on (debrief5 §4.2).
//
// Whether a module function is exported cannot be asked of a running base
// without calling it, and a print entry point is not something to call with
// placeholder arguments to find out. That one question is answered from a
// configuration dump when the caller has one.

import { sameInfobase } from "../profiles/configuration"
import { callToolkitTool, findMarkedLine, type ToolkitCallOptions } from "./toolkit-client"

const MARKER = "1ccoder-print"

/** Objects whose presence decides which rung of the mechanism ladder exists here. */
export const PRINT_OBJECTS = [
  { kind: "Справочники", name: "МакетыПечатныхФорм" },
  { kind: "РегистрыСведений", name: "ПользовательскиеМакетыПечати" },
  { kind: "Справочники", name: "ДополнительныеОтчетыИОбработки" },
  { kind: "ОбщиеМодули", name: "УправлениеПечатью" },
] as const

/** Entry points whose export status the print-forms skill's checks depend on. */
export const PRINT_ENTRY_POINTS = ["СформироватьВнешнююПечатнуюФорму", "КомандыПечатиФормы", "ОтключитьКомандыПечати"]

/** Read-only: metadata lookups, one count query, the БСП version and the connection string. */
export const PRINT_CAPABILITIES_CODE = [
  `Р = "${MARKER}";`,
  ...PRINT_OBJECTS.map(
    (object) =>
      `Р = Р + "|${object.name}=" + ?(Метаданные.${object.kind}.Найти("${object.name}") = Неопределено, "0", "1");`,
  ),
  "Попытка",
  // Assigned first: 1C does not allow a method call on a `Новый` expression,
  // and a compile error takes the whole snippet down -- Попытка cannot catch
  // it. Found live, 2026-09-25: «Неопознанный оператор» at the chained call.
  '\tЗапрос = Новый Запрос("ВЫБРАТЬ КОЛИЧЕСТВО(*) КАК К ИЗ РегистрСведений.ПользовательскиеМакетыПечати");',
  "\tВыборка = Запрос.Выполнить().Выбрать();",
  "\tВыборка.Следующий();",
  '\tР = Р + "|ПользовательскихМакетов=" + Формат(Выборка.К, "ЧН=0; ЧГ=");',
  "Исключение",
  "КонецПопытки;",
  "Попытка",
  '\tР = Р + "|БСП=" + СтандартныеПодсистемыСервер.ВерсияБиблиотеки();',
  "Исключение",
  "КонецПопытки;",
  'Р = Р + "|СтрокаСоединения=" + СтрокаСоединенияИнформационнойБазы();',
  "Результат = Р;",
].join("\n")

export interface PrintCapabilities {
  readonly objects: Readonly<Record<string, boolean>>
  readonly userTemplates?: number
  readonly bspVersion?: string
  readonly connectionString: string
}

export function parsePrintReply(text: string): PrintCapabilities | null {
  const line = findMarkedLine(text, MARKER)
  if (!line) return null
  const fields = new Map<string, string>()
  for (const part of line.split("|").slice(1)) {
    const at = part.indexOf("=")
    if (at > 0) fields.set(part.slice(0, at), part.slice(at + 1))
  }
  const count = fields.get("ПользовательскихМакетов")
  return {
    objects: Object.fromEntries(PRINT_OBJECTS.map((object) => [object.name, fields.get(object.name) === "1"])),
    ...(count !== undefined && count !== "" ? { userTemplates: Number(count) } : {}),
    ...(fields.get("БСП") ? { bspVersion: fields.get("БСП") } : {}),
    connectionString: fields.get("СтрокаСоединения") ?? "",
  }
}

/** Which entry points a dump's УправлениеПечатью module declares with `Экспорт`. */
export function exportedEntryPoints(moduleText: string): Record<string, boolean | undefined> {
  return Object.fromEntries(
    PRINT_ENTRY_POINTS.map((name) => {
      const declaration = new RegExp(`^\\s*(?:Процедура|Функция)\\s+${name}\\s*\\(([^)]*)\\)\\s*(Экспорт)?`, "im").exec(
        moduleText,
      )
      return [name, declaration ? Boolean(declaration[2]) : undefined]
    }),
  )
}

export function describePrintCapabilities(
  found: PrintCapabilities,
  exported?: Record<string, boolean | undefined>,
): string {
  const yes = (value: boolean | undefined) => (value === undefined ? "нет в модуле" : value ? "да" : "НЕТ")
  return [
    `БСП: ${found.bspVersion ?? "не найдена"}`,
    "",
    "| Объект | Есть в этой базе |",
    "|---|---|",
    ...PRINT_OBJECTS.map((object) => `| \`${object.name}\` | ${found.objects[object.name] ? "да" : "НЕТ"} |`),
    ...(found.userTemplates !== undefined ? ["", `Записей в \`ПользовательскиеМакетыПечати\`: ${found.userTemplates}.`] : []),
    "",
    ...(exported
      ? [
          "| `УправлениеПечатью.…` | Экспортная |",
          "|---|---|",
          ...PRINT_ENTRY_POINTS.map((name) => `| \`${name}\` | ${yes(exported[name])} |`),
          "",
          "Неэкспортную функцию вызвать извне нельзя — соответствующий шаг проверки пропусти.",
        ]
      : [
          "Экспортность функций `УправлениеПечатью` по работающей базе не проверить, не вызвав их. Передай",
          "`dump` — каталог выгрузки конфигурации, — и она будет прочитана из модуля.",
        ]),
  ].join("\n")
}

export type PrintOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "other-infobase" | "unreadable" | "failed"; readonly detail?: string }

export async function printCapabilities(
  profile: { kind: "file" | "server"; filePath?: string; serverCluster?: string; serverDatabase?: string },
  options: ToolkitCallOptions & { readModule?: () => Promise<string | null> } = {},
): Promise<PrintOutcome> {
  let text: string
  try {
    text = await callToolkitTool("execute_code", { code: PRINT_CAPABILITIES_CODE }, options)
  } catch (error) {
    return { ok: false, reason: "failed", detail: String(error) }
  }
  const found = parsePrintReply(text)
  if (!found) return { ok: false, reason: "unreadable", detail: text.slice(0, 300) }
  if (!sameInfobase(found.connectionString, profile)) {
    return { ok: false, reason: "other-infobase", detail: found.connectionString }
  }
  const module = options.readModule ? await options.readModule().catch(() => null) : null
  return { ok: true, text: describePrintCapabilities(found, module ? exportedEntryPoints(module) : undefined) }
}
