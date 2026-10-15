// Does a data composition schema work -- before it goes into a load?
//
// 2026-09-26, debrief14.md §14.5. A report's schema was fixed through four
// rounds of load → update → run, each a configurator launch plus a toolkit
// restart, each ending in one runtime error: an XDTO exception naming only the
// file (a `cfg:` type in a schema that didn't declare the prefix), bad
// virtual-table parameters, a parameter the layout couldn't find, an
// expression the processor couldn't parse. The running base can find all of
// them from the file itself, in seconds, one step at a time:
//
//   read     `СериализаторXDTO.ПрочитатьXML(…, Тип("СхемаКомпоновкиДанных"))`,
//            the idiom the standard configurations use for a schema file;
//   sources  `Новый ИсточникДоступныхНастроекКомпоновкиДанных` -- the queries;
//   layout   `КомпоновщикМакетаКомпоновкиДанных.Выполнить` -- parameters and
//            settings fields;
//   init     `ПроцессорКомпоновкиДанных.Инициализировать` -- expressions; this
//            step runs the queries, read only.
//
// It stops at the first failure and says which step it was.

import { sameInfobase } from "../profiles/configuration"
import { callToolkitTool, findMarkedLine, type ToolkitCallOptions } from "./toolkit-client"

const MARKER = "1ccoder-dcs"
const STEPS = ["read", "sources", "layout", "init"] as const
type Step = (typeof STEPS)[number]

/** A BSL string literal: quotes are doubled, nothing else is special. */
function literal(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

export function dcsCheckCode(path: string): string {
  return [
    `Р = "${MARKER}|СтрокаСоединения=" + СтрЗаменить(СтрокаСоединенияИнформационнойБазы(), "|", "/");`,
    'Шаг = "read";',
    "Попытка",
    "\tЧтение = Новый ЧтениеXML;",
    `\tЧтение.ОткрытьФайл(${literal(path)});`,
    '\tСхема = СериализаторXDTO.ПрочитатьXML(Чтение, Тип("СхемаКомпоновкиДанных"));',
    "\tЧтение.Закрыть();",
    '\tР = Р + "|read=ok";',
    '\tШаг = "sources";',
    "\tИсточник = Новый ИсточникДоступныхНастроекКомпоновкиДанных(Схема);",
    '\tР = Р + "|sources=ok";',
    '\tШаг = "layout";',
    // debrief17.md §17.3 item 1: a parameter the user must choose is required and
    // empty by design, and composing the default settings stops on it. It gets a
    // value of its own type for the check, and the result says which.
    "\tКН = Новый КомпоновщикНастроекКомпоновкиДанных;",
    "\tКН.Инициализировать(Источник);",
    "\tКН.ЗагрузитьНастройки(Схема.НастройкиПоУмолчанию);",
    "\tНастройки = КН.Настройки;",
    '\tПодставлены = "";',
    "\tДля Каждого ПарСх Из Схема.Параметры Цикл",
    "\t\tЕсли Не ПарСх.ЗапрещатьНезаполненныеЗначения ИЛИ ЗначениеЗаполнено(ПарСх.Выражение) Тогда Продолжить; КонецЕсли;",
    "\t\tЭл = Настройки.ПараметрыДанных.НайтиЗначениеПараметра(Новый ПараметрКомпоновкиДанных(ПарСх.Имя));",
    "\t\tЕсли Эл = Неопределено ИЛИ ЗначениеЗаполнено(Эл.Значение) Тогда Продолжить; КонецЕсли;",
    "\t\tЗначП = Неопределено;",
    '\t\tЕсли ПарСх.ТипЗначения.СодержитТип(Тип("СтандартныйПериод")) Тогда',
    "\t\t\tЗначП = Новый СтандартныйПериод(ВариантСтандартногоПериода.ЭтотГод);",
    '\t\tИначеЕсли ПарСх.ТипЗначения.СодержитТип(Тип("Дата")) Тогда',
    "\t\t\tЗначП = ТекущаяДата();",
    '\t\tИначеЕсли ПарСх.ТипЗначения.СодержитТип(Тип("Число")) Тогда',
    "\t\t\tЗначП = 1;",
    '\t\tИначеЕсли ПарСх.ТипЗначения.СодержитТип(Тип("Строка")) Тогда',
    '\t\t\tЗначП = "1";',
    '\t\tИначеЕсли ПарСх.ТипЗначения.СодержитТип(Тип("Булево")) Тогда',
    "\t\t\tЗначП = Истина;",
    "\t\tИначе",
    "\t\t\tДля Каждого ТипЗн Из ПарСх.ТипЗначения.Типы() Цикл",
    "\t\t\t\tМд = Метаданные.НайтиПоТипу(ТипЗн);",
    "\t\t\t\tЕсли Мд <> Неопределено И Метаданные.Справочники.Содержит(Мд) Тогда",
    "\t\t\t\t\tВыборка = Справочники[Мд.Имя].Выбрать();",
    "\t\t\t\t\tЕсли Выборка.Следующий() Тогда ЗначП = Выборка.Ссылка; КонецЕсли;",
    "\t\t\t\tИначеЕсли Мд <> Неопределено И Метаданные.Перечисления.Содержит(Мд) И Мд.ЗначенияПеречисления.Количество() > 0 Тогда",
    "\t\t\t\t\tЗначП = Перечисления[Мд.Имя][Мд.ЗначенияПеречисления[0].Имя];",
    "\t\t\t\tКонецЕсли;",
    "\t\t\t\tЕсли ЗначП <> Неопределено Тогда Прервать; КонецЕсли;",
    "\t\t\tКонецЦикла;",
    "\t\tКонецЕсли;",
    "\t\tЕсли ЗначП <> Неопределено Тогда",
    "\t\t\tЭл.Значение = ЗначП; Эл.Использование = Истина;",
    '\t\t\tПодставлены = Подставлены + ПарСх.Имя + ";";',
    "\t\tКонецЕсли;",
    "\tКонецЦикла;",
    '\tР = Р + "|placeholders=" + Подставлены;',
    "\tКомпоновщик = Новый КомпоновщикМакетаКомпоновкиДанных;",
    "\tМакет = Компоновщик.Выполнить(Схема, Настройки, , ,",
    '\t\tТип("ГенераторМакетаКомпоновкиДанныхДляКоллекцииЗначений"));',
    '\tР = Р + "|layout=ok";',
    '\tШаг = "init";',
    "\tПроцессор = Новый ПроцессорКомпоновкиДанных;",
    "\tПроцессор.Инициализировать(Макет);",
    '\tР = Р + "|init=ok";',
    "Исключение",
    '\tР = Р + "|" + Шаг + "=" + СтрЗаменить(СтрЗаменить(ОписаниеОшибки(), "|", "/"), Символы.ПС, " ");',
    "КонецПопытки;",
    "Результат = Р;",
  ].join("\n")
}

export interface DcsCheck {
  readonly connectionString: string
  /** Required parameters with no value in the variant, given a value of their type for the check. */
  readonly placeholders: readonly string[]
  /** The steps that passed, in order. */
  readonly passed: readonly Step[]
  /** The step that failed and its error, when one did. */
  readonly failed?: { readonly step: Step; readonly error: string }
}

export function parseDcsCheck(text: string): DcsCheck | null {
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
  const passed = STEPS.filter((step) => fields.get(step) === "ok")
  const failedStep = STEPS.find((step) => fields.has(step) && fields.get(step) !== "ok")
  return {
    connectionString: fields.get("СтрокаСоединения") ?? "",
    placeholders: (fields.get("placeholders") ?? "").split(";").map((name) => name.trim()).filter(Boolean),
    passed,
    ...(failedStep ? { failed: { step: failedStep, error: fields.get(failedStep) ?? "" } } : {}),
  }
}

const STEP_NAMES: Record<Step, string> = {
  read: "чтение схемы из XML",
  sources: "запросы наборов данных",
  layout: "компоновка макета (параметры, поля настроек)",
  init: "инициализация (выражения; запросы выполняются)",
}

// What each failure usually means, as mechanism: the facts to look up, not a guess at the fix.
const STEP_HINTS: Record<Step, string> = {
  read:
    "Схема не читается как XML схемы компоновки. Сверь названный элемент с той же конструкцией в схемах " +
    "выгрузки базы. Тип с префиксом пространства имён (например, `cfg:`) читается, только если префикс " +
    "объявлен в корне схемы.",
  sources:
    "Ошибка в тексте запроса набора данных. Имена таблиц, полей и параметры виртуальных таблиц — в " +
    "1c_get_metadata. Объекты самого расширения запрос найдёт, только когда расширение загружено и применено " +
    "(1c_update_db с extension).",
  layout:
    "Запрос читается, но макет не собирается: параметр или поле из настроек не найдено в схеме. Параметр, " +
    "который должен быть доступен всегда, объявляется с использованием «Всегда».",
  init:
    "Ошибка в выражении схемы (вычисляемое поле, ресурс, параметр) или при выполнении запроса. Функции, " +
    "доступные в выражениях компоновки, — в 1c_get_bsl_syntax_help.",
}

export function describeDcsCheck(path: string, check: DcsCheck): { readonly passed: boolean; readonly text: string } {
  const placeholders = check.placeholders.length
    ? ` Обязательные параметры без значения в варианте (${check.placeholders.join(", ")}) проверены с подставленным ` +
      "значением своего типа: при открытии отчёта их выберет пользователь, так и задумано."
    : ""
  if (!check.failed && check.passed.length === STEPS.length) {
    return {
      passed: true,
      text:
        `Схема ${path} прошла проверку в базе: читается, запросы и параметры корректны, процессор ` +
        `инициализируется (запросы выполнены, только чтение).${placeholders} Вывод отчёта на форму это не проверяет.`,
    }
  }
  if (!check.failed) return { passed: false, text: `Проверка схемы ${path} оборвалась после шагов: ${check.passed.join(", ") || "нет"}.` }
  return {
    passed: false,
    text: [
      `Схема ${path} не прошла шаг «${STEP_NAMES[check.failed.step]}»:`,
      check.failed.error,
      "",
      STEP_HINTS[check.failed.step],
    ].join("\n"),
  }
}

export type DcsCheckOutcome =
  | { readonly ok: true; readonly text: string; readonly passed: boolean }
  | { readonly ok: false; readonly reason: "other-infobase" | "unreadable" | "failed"; readonly detail?: string }

export async function checkDcs(
  request: { readonly path: string },
  profile: { kind: "file" | "server"; filePath?: string; serverCluster?: string; serverDatabase?: string },
  options: ToolkitCallOptions = {},
): Promise<DcsCheckOutcome> {
  const text = await callToolkitTool("execute_code", { code: dcsCheckCode(request.path) }, { timeoutMs: 120_000, ...options }).catch(
    (error: unknown) => new Error(String(error)),
  )
  if (text instanceof Error) return { ok: false, reason: "failed", detail: text.message }
  const check = parseDcsCheck(text)
  if (!check) return { ok: false, reason: "unreadable", detail: text.slice(0, 300) }
  if (!sameInfobase(check.connectionString, profile)) return { ok: false, reason: "other-infobase", detail: check.connectionString }
  return { ok: true, ...describeDcsCheck(request.path, check) }
}
