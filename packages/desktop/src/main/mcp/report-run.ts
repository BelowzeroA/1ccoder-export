// Run an external report the way its user will, and look at what came out.
//
// 2026-09-29, debrief16.md §16.3 item 4. A report agent-tested only through
// hand-written composition scripts (~15 of them in one run, each rebuilt from
// scratch) was handed over with the cost column empty on most rows and
// columns too narrow to read. Every script had set the price type itself,
// used one price type, and read cell text -- none opened the report with the
// variant's own settings or looked at the result. So this tool:
//
//   - composes with the main schema's DEFAULT variant, then applies only the
//     parameters and filters given, by name, converting text to the parameter's
//     own type (a catalog item by its description, a period as `from..to`);
//   - names the parameters left empty -- what the user gets on first open;
//   - writes the result to MXL and PDF in the working directory, plus a text
//     dump read back from disk (the toolkit masks words in its own replies, and
//     a masked cell is not a value);
//   - reports, per column, how many data rows are empty and whether the widest
//     text fits the column.

import { sameInfobase } from "../profiles/configuration"
import { callToolkitTool, findMarkedLine, type ToolkitCallOptions } from "./toolkit-client"

const MARKER = "1ccoder-report"

/** A BSL string literal: quotes are doubled, nothing else is special. */
function literal(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

export interface ReportRunRequest {
  readonly path: string
  /** Parameter name → value as text. */
  readonly params?: Readonly<Record<string, string>>
  /** Field → value as text; a catalog value filters «в иерархии». */
  readonly filters?: Readonly<Record<string, string>>
  /** Files are written as `<outBase>.mxl`, `.pdf`, `.txt`. */
  readonly outBase: string
}

// Converts `Стр` to a value of the types in `Типы`, into `ЗначП`. Flat code: the
// toolkit's execute_code does not accept procedures.
function convertCode(): string[] {
  return [
    "\tЗначП = Неопределено;",
    '\tЕсли Типы.СодержитТип(Тип("СтандартныйПериод")) Тогда',
    '\t\tЧасти = СтрРазделить(Стр, ".", Ложь);',
    "\t\tЕсли Части.Количество() = 2 Тогда",
    '\t\t\tЗначП = Новый СтандартныйПериод(XMLЗначение(Тип("Дата"), СокрЛП(Части[0]) + "T00:00:00"), КонецДня(XMLЗначение(Тип("Дата"), СокрЛП(Части[1]) + "T00:00:00")));',
    "\t\tКонецЕсли;",
    '\tИначеЕсли Типы.СодержитТип(Тип("Дата")) Тогда',
    '\t\tЗначП = XMLЗначение(Тип("Дата"), Лев(Стр, 10) + "T00:00:00");',
    '\tИначеЕсли Типы.СодержитТип(Тип("Число")) Тогда',
    '\t\tЗначП = Число(СтрЗаменить(Стр, ",", "."));',
    '\tИначеЕсли Типы.СодержитТип(Тип("Булево")) Тогда',
    '\t\tЗначП = НРег(Стр) = "истина" ИЛИ НРег(Стр) = "true" ИЛИ Стр = "1";',
    '\tИначеЕсли Типы.СодержитТип(Тип("Строка")) Тогда',
    "\t\tЗначП = Стр;",
    "\tИначе",
    "\t\tДля Каждого ТипЗн Из Типы.Типы() Цикл",
    "\t\t\tМд = Метаданные.НайтиПоТипу(ТипЗн);",
    "\t\t\tЕсли Мд = Неопределено Тогда Продолжить; КонецЕсли;",
    "\t\t\tЕсли Метаданные.Справочники.Содержит(Мд) Тогда",
    "\t\t\t\tЗначП = Справочники[Мд.Имя].НайтиПоНаименованию(Стр, Истина);",
    "\t\t\t\tЕсли Не ЗначениеЗаполнено(ЗначП) Тогда ЗначП = Справочники[Мд.Имя].НайтиПоКоду(Стр); КонецЕсли;",
    "\t\t\tИначеЕсли Метаданные.Перечисления.Содержит(Мд) Тогда",
    "\t\t\t\tДля Каждого ЗнПер Из Мд.ЗначенияПеречисления Цикл",
    "\t\t\t\t\tЕсли ЗнПер.Имя = Стр ИЛИ ЗнПер.Синоним = Стр Тогда ЗначП = Перечисления[Мд.Имя][ЗнПер.Имя]; КонецЕсли;",
    "\t\t\t\tКонецЦикла;",
    "\t\t\tКонецЕсли;",
    "\t\t\tЕсли ЗначениеЗаполнено(ЗначП) Тогда Прервать; КонецЕсли;",
    "\t\tКонецЦикла;",
    "\tКонецЕсли;",
  ]
}

export function reportRunCode(request: ReportRunRequest): string {
  const params = Object.entries(request.params ?? {}).map(([name, value]) => `П.Вставить(${literal(name)}, ${literal(value)});`)
  const filters = Object.entries(request.filters ?? {}).map(([name, value]) => `О.Вставить(${literal(name)}, ${literal(value)});`)
  return [
    `Р = "${MARKER}|СтрокаСоединения=" + СтрЗаменить(СтрокаСоединенияИнформационнойБазы(), "|", "/");`,
    'Шаг = "open";',
    'Т = "";',
    "П = Новый Соответствие;",
    ...params,
    "О = Новый Соответствие;",
    ...filters,
    "Попытка",
    // Attached from storage with warnings off rather than created from the file:
    // with the user's «Защита от опасных действий» on, opening from a file asks
    // «Разрешить открывать данный файл?» and the call hangs (debrief18.md). A
    // fresh name per run, because an attachment is cached for the session and
    // reusing a name would run the previous build.
    `\tАдрес = ПоместитьВоВременноеХранилище(Новый ДвоичныеДанные(${literal(request.path)}));`,
    "\tЗащита = Новый ОписаниеЗащитыОтОпасныхДействий;",
    "\tЗащита.ПредупреждатьОбОпасныхДействиях = Ложь;",
    '\tИмя = ВнешниеОтчеты.Подключить(Адрес, "Отчет" + СтрЗаменить(Строка(Новый УникальныйИдентификатор), "-", ""), Ложь, Защита);',
    "\tОтчет = ВнешниеОтчеты.Создать(Имя);",
    "\tМдСхемы = Отчет.Метаданные().ОсновнаяСхемаКомпоновкиДанных;",
    '\tСхема = Отчет.ПолучитьМакет(?(МдСхемы = Неопределено, "ОсновнаяСхемаКомпоновкиДанных", МдСхемы.Имя));',
    "\tКН = Новый КомпоновщикНастроекКомпоновкиДанных;",
    "\tКН.Инициализировать(Новый ИсточникДоступныхНастроекКомпоновкиДанных(Схема));",
    "\tКН.ЗагрузитьНастройки(Схема.НастройкиПоУмолчанию);",
    "\tНастройки = КН.Настройки;",
    // What the user gets on first open: data parameters with no value in the variant.
    '\tПустыеСразу = "";',
    "\tДля Каждого ПарСх Из Схема.Параметры Цикл",
    "\t\tЕсли ПарСх.ОграничениеИспользования ИЛИ ЗначениеЗаполнено(ПарСх.Выражение) Тогда Продолжить; КонецЕсли;",
    "\t\tЭл = Настройки.ПараметрыДанных.НайтиЗначениеПараметра(Новый ПараметрКомпоновкиДанных(ПарСх.Имя));",
    "\t\tЕсли Эл = Неопределено ИЛИ Не ЗначениеЗаполнено(Эл.Значение) Тогда",
    '\t\t\tПустыеСразу = ПустыеСразу + ПарСх.Имя + ?(ПарСх.ЗапрещатьНезаполненныеЗначения, " (обязательный)", "") + ";";',
    "\t\tКонецЕсли;",
    "\tКонецЦикла;",
    '\tР = Р + "|empty_on_open=" + ПустыеСразу;',
    'Шаг = "params";',
    '\tНеНайдены = "";',
    "\tДля Каждого КЗ Из П Цикл",
    "\t\tЭл = Настройки.ПараметрыДанных.НайтиЗначениеПараметра(Новый ПараметрКомпоновкиДанных(КЗ.Ключ));",
    "\t\tПарСх = Схема.Параметры.Найти(КЗ.Ключ);",
    '\t\tЕсли Эл = Неопределено ИЛИ ПарСх = Неопределено Тогда НеНайдены = НеНайдены + КЗ.Ключ + " (нет такого параметра);"; Продолжить; КонецЕсли;',
    "\t\tТипы = ПарСх.ТипЗначения; Стр = КЗ.Значение;",
    ...convertCode(),
    '\t\tЕсли Не ЗначениеЗаполнено(ЗначП) И ЗначП <> Ложь Тогда НеНайдены = НеНайдены + КЗ.Ключ + " = " + Стр + " (значение не найдено);"; КонецЕсли;',
    "\t\tЭл.Значение = ЗначП; Эл.Использование = Истина;",
    "\tКонецЦикла;",
    'Шаг = "filters";',
    "\tДля Каждого КЗ Из О Цикл",
    "\t\tПоле = Новый ПолеКомпоновкиДанных(КЗ.Ключ);",
    "\t\tДП = Настройки.Отбор.ДоступныеПоляОтбора.НайтиПоле(Поле);",
    '\t\tЕсли ДП = Неопределено Тогда НеНайдены = НеНайдены + КЗ.Ключ + " (нет такого поля отбора);"; Продолжить; КонецЕсли;',
    "\t\tТипы = ДП.ТипЗначения; Стр = КЗ.Значение;",
    ...convertCode(),
    '\t\tЕсли Не ЗначениеЗаполнено(ЗначП) Тогда НеНайдены = НеНайдены + КЗ.Ключ + " = " + Стр + " (значение не найдено);"; Продолжить; КонецЕсли;',
    "\t\tЭлО = Неопределено;",
    "\t\tДля Каждого Э Из Настройки.Отбор.Элементы Цикл",
    '\t\t\tЕсли ТипЗнч(Э) = Тип("ЭлементОтбораКомпоновкиДанных") И Э.ЛевоеЗначение = Поле Тогда ЭлО = Э; КонецЕсли;',
    "\t\tКонецЦикла;",
    '\t\tЕсли ЭлО = Неопределено Тогда ЭлО = Настройки.Отбор.Элементы.Добавить(Тип("ЭлементОтбораКомпоновкиДанных")); ЭлО.ЛевоеЗначение = Поле; КонецЕсли;',
    "\t\tМд = Метаданные.НайтиПоТипу(ТипЗнч(ЗначП));",
    "\t\tИерарх = Мд <> Неопределено И Метаданные.Справочники.Содержит(Мд) И Мд.Иерархический;",
    "\t\tЭлО.ВидСравнения = ?(Иерарх, ВидСравненияКомпоновкиДанных.ВИерархии, ВидСравненияКомпоновкиДанных.Равно);",
    "\t\tЭлО.ПравоеЗначение = ЗначП; ЭлО.Использование = Истина;",
    "\tКонецЦикла;",
    '\tР = Р + "|not_found=" + СтрЗаменить(НеНайдены, "|", "/");',
    'Шаг = "compose";',
    "\tМакет = Новый КомпоновщикМакетаКомпоновкиДанных;",
    "\tМакет = Макет.Выполнить(Схема, Настройки);",
    "\tПроцессор = Новый ПроцессорКомпоновкиДанных;",
    "\tПроцессор.Инициализировать(Макет, , , Истина);",
    "\tТД = Новый ТабличныйДокумент;",
    "\tВывод = Новый ПроцессорВыводаРезультатаКомпоновкиДанныхВТабличныйДокумент;",
    "\tВывод.УстановитьДокумент(ТД);",
    "\tВывод.Вывести(Процессор);",
    'Шаг = "save";',
    `\tТД.Записать(${literal(`${request.outBase}.mxl`)});`,
    "\tТД.ОриентацияСтраницы = ОриентацияСтраницы.Ландшафт; ТД.АвтоМасштаб = Истина;",
    `\tТД.Записать(${literal(`${request.outBase}.pdf`)}, ТипФайлаТабличногоДокумента.PDF);`,
    // The dump: one line of column widths (as in the last row -- the header block
    // above the table has its own), then every row, cells split by tabs.
    '\tШир = "";',
    "\tДля К = 1 По ТД.ШиринаТаблицы Цикл Шир = Шир + Символы.Таб + Формат(ТД.Область(ТД.ВысотаТаблицы, К).ШиринаКолонки, \"ЧДЦ=2; ЧРД=.; ЧГ=0; ЧН=0\"); КонецЦикла;",
    '\tТ = "widths" + Шир + Символы.ПС;',
    "\tДля Н = 1 По Мин(ТД.ВысотаТаблицы, 2000) Цикл",
    '\t\tС = "";',
    "\t\tДля К = 1 По ТД.ШиринаТаблицы Цикл",
    '\t\t\tС = С + Символы.Таб + СтрЗаменить(СтрЗаменить(ТД.Область(Н, К).Текст, Символы.Таб, " "), Символы.ПС, " ");',
    "\t\tКонецЦикла;",
    '\t\tТ = Т + "row" + С + Символы.ПС;',
    "\tКонецЦикла;",
    "\tТекстДок = Новый ТекстовыйДокумент;",
    "\tТекстДок.УстановитьТекст(Т);",
    `\tТекстДок.Записать(${literal(`${request.outBase}.txt`)}, КодировкаТекста.UTF8);`,
    '\tР = Р + "|rows=" + Формат(ТД.ВысотаТаблицы, "ЧН=0; ЧГ=0") + "|ok=1";',
    "Исключение",
    '\tР = Р + "|failed=" + Шаг + ": " + СтрЗаменить(СтрЗаменить(ОписаниеОшибки(), "|", "/"), Символы.ПС, " ");',
    "КонецПопытки;",
    "Результат = Р;",
  ].join("\n")
}

export interface ReportRun {
  readonly connectionString: string
  readonly emptyOnOpen: readonly string[]
  readonly notFound: readonly string[]
  readonly rows?: number
  readonly failed?: string
}

export function parseReportRun(text: string): ReportRun | null {
  const line = findMarkedLine(text, MARKER)
  if (!line) return null
  const fields = new Map(
    line
      .split("|")
      .slice(1)
      .map((part) => {
        const at = part.indexOf("=")
        return at > 0 ? ([part.slice(0, at), part.slice(at + 1)] as const) : ([part, ""] as const)
      }),
  )
  const list = (key: string) => (fields.get(key) ?? "").split(";").map((item) => item.trim()).filter(Boolean)
  const rows = fields.get("rows")
  return {
    connectionString: fields.get("СтрокаСоединения") ?? "",
    emptyOnOpen: list("empty_on_open"),
    notFound: list("not_found"),
    ...(rows ? { rows: Number(rows) } : {}),
    ...(fields.get("failed") ? { failed: fields.get("failed") } : {}),
  }
}

export interface ColumnReport {
  readonly title: string
  readonly width: number
  readonly widest: number
  readonly numeric: boolean
  readonly filled: number
  readonly rows: number
}

const NUMBER = /^-?[\d\s ]+([.,]\d+)?$/

/**
 * Columns of the rendered report, from the text dump.
 *
 * The header row is the first row where at least half of the columns hold text
 * and none holds a number or a «name: value» pair; data rows are everything after it. A column is
 * numeric when most of its filled data cells are numbers.
 */
export function analyseDump(dump: string): { readonly columns: readonly ColumnReport[]; readonly dataRows: number } {
  const lines = dump.split(/\r?\n/)
  const widths = (lines.find((line) => line.startsWith("widths")) ?? "").split("\t").slice(1).map(Number)
  const rows = lines.filter((line) => line.startsWith("row")).map((line) => line.split("\t").slice(1).map((cell) => cell.trim()))
  // «Параметры:», «Отбор:» and their values come first and look like text rows too.
  const header = rows.findIndex(
    (cells) =>
      cells.filter(Boolean).length >= Math.max(2, cells.length / 2) &&
      !cells.some((cell) => NUMBER.test(cell) || cell.includes(":")),
  )
  if (header < 0) return { columns: [], dataRows: 0 }
  // Group headers may take two rows; a header cell continues into the row below when that row is still all text.
  const secondHeader = rows[header + 1]?.every((cell) => !NUMBER.test(cell)) && rows[header + 1]?.some(Boolean)
  const data = rows.slice(header + (secondHeader ? 2 : 1)).filter((cells) => cells.some(Boolean))
  const columns = rows[header]!.map((title, index) => {
    const cells = data.map((cells) => cells[index] ?? "")
    const filled = cells.filter(Boolean)
    const numbers = filled.filter((cell) => NUMBER.test(cell))
    return {
      title: [title, secondHeader ? rows[header + 1]![index] : ""].filter(Boolean).join(" / "),
      width: widths[index] ?? 0,
      widest: Math.max(0, ...cells.map((cell) => cell.length)),
      numeric: filled.length > 0 && numbers.length * 2 >= filled.length,
      filled: filled.length,
      rows: data.length,
    }
  })
  return { columns: columns.filter((column) => column.title), dataRows: data.length }
}

export function describeReportRun(
  request: ReportRunRequest,
  run: ReportRun,
  dump: string | null,
): { readonly passed: boolean; readonly text: string } {
  if (run.failed) {
    // debrief17.md §17.3: a required parameter left empty stops the composition, as it will for the user.
    const unset = /Не установлено значение параметра/i.test(run.failed)
    return {
      passed: false,
      text:
        `Отчёт ${request.path} не сформирован — шаг ${run.failed}` +
        (unset
          ? "\nЭто обязательный параметр без значения: пользователь выберет его сам, а для прогона передай его в params."
          : ""),
    }
  }
  const analysis = dump ? analyseDump(dump) : { columns: [], dataRows: 0 }
  // Only numeric columns: a grouping field is empty on the detail rows by design,
  // and counting it read as a defect (debrief17.md §17.1).
  const empty = analysis.columns.filter((column) => column.numeric && column.rows > 0 && column.filled < column.rows)
  // Units of ШиринаКолонки are close to characters of the default font; a number wider than its column prints as «###».
  const narrow = analysis.columns.filter((column) => column.width > 0 && column.widest > column.width)
  const lines = [
    `Отчёт сформирован с вариантом по умолчанию: строк в документе ${run.rows ?? "?"}, строк данных ${analysis.dataRows}.`,
    `Файлы: ${request.outBase}.pdf (посмотри глазами — прочитай его), ${request.outBase}.mxl, текст ячеек — ${request.outBase}.txt.`,
    ...(run.notFound.length ? ["", `Не применено: ${run.notFound.join("; ")}.`] : []),
    ...(run.emptyOnOpen.length
      ? [
          "",
          `Пусто при первом открытии (в варианте нет значения): ${run.emptyOnOpen.join(", ")}. Так отчёт увидит ` +
            "пользователь: обязательный параметр без значения ему придётся искать, необязательный — отчёт " +
            "сформируется без него.",
        ]
      : []),
    ...(empty.length
      ? [
          "",
          "Пустые ячейки в числовых колонках (строки всех уровней группировки):",
          ...empty.map((column) => `- «${column.title}»: пусто в ${column.rows - column.filled} из ${column.rows}`),
          "Пустая денежная колонка в большей части строк — почти всегда не данные, а условие соединения. Найди строку, " +
            "где пусто, и проверь запросом, почему для неё не нашлось значения.",
        ]
      : []),
    ...(narrow.length
      ? [
          "",
          "Текст шире колонки (число в узкой колонке печатается как «###», текст обрезается):",
          ...narrow.map((column) => `- «${column.title}»: ширина ${column.width}, самый длинный текст ${column.widest}`),
          "Минимальная ширина задаётся в оформлении поля схемы (параметр МинимальнаяШирина).",
        ]
      : []),
  ]
  return { passed: !empty.length && !narrow.length && !run.notFound.length, text: lines.join("\n") }
}

export type ReportRunOutcome =
  | { readonly ok: true; readonly text: string; readonly passed: boolean }
  | { readonly ok: false; readonly reason: "other-infobase" | "unreadable" | "failed"; readonly detail?: string }

export async function runReport(
  request: ReportRunRequest,
  profile: { kind: "file" | "server"; filePath?: string; serverCluster?: string; serverDatabase?: string },
  readDump: (path: string) => string | null,
  options: ToolkitCallOptions = {},
): Promise<ReportRunOutcome> {
  const text = await callToolkitTool("execute_code", { code: reportRunCode(request) }, { timeoutMs: 300_000, ...options }).catch(
    (error: unknown) => new Error(String(error)),
  )
  if (text instanceof Error) return { ok: false, reason: "failed", detail: text.message }
  const run = parseReportRun(text)
  if (!run) return { ok: false, reason: "unreadable", detail: text.slice(0, 300) }
  if (!sameInfobase(run.connectionString, profile)) return { ok: false, reason: "other-infobase", detail: run.connectionString }
  return { ok: true, ...describeReportRun(request, run, run.failed ? null : readDump(`${request.outBase}.txt`)) }
}
