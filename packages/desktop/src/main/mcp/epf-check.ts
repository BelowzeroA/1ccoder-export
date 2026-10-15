// Does an external processing compile -- object module and every form?
//
// 2026-09-25, failures_to_tools.md T1 (debrief1.md P1-6). Building an .epf in
// batch mode compiles nothing: a processing whose form module cannot compile
// builds with exit code 0. Creating it through `ВнешниеОбработки.Создать`
// compiles the object module only; a form module is compiled when the form is
// created. So "it builds and it runs" says nothing about the forms, and the
// working recipe -- attach on the server, get the form on the client -- sat in
// a skill as prose the agent had to reassemble each time.
//
// Two toolkit calls, because a form can only be created in client context:
//
//   server: attach under a fresh name (attachments are cached per session, so
//           reusing a name checks the previous build), create the object --
//           which compiles its module -- and list the forms;
//   client: `ПолучитьФорму` for each, which compiles the form module without
//           showing a window. A compile error arrives as the exception text,
//           with module, line and column.

import { sameInfobase } from "../profiles/configuration"
import { callToolkitTool, findMarkedLine, type ToolkitCallOptions } from "./toolkit-client"

const SERVER_MARKER = "1ccoder-epf"
const CLIENT_MARKER = "1ccoder-epf-forms"

/** A BSL string literal: quotes are doubled, nothing else is special. */
function literal(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/** One line of error text that fits between the markers' separators. */
const FLATTEN = 'СтрЗаменить(СтрЗаменить(ОписаниеОшибки(), "|", "/"), Символы.ПС, " ")'

export function serverCheckCode(path: string, attachName: string): string {
  return [
    `Р = "${SERVER_MARKER}|СтрокаСоединения=" + СтрЗаменить(СтрокаСоединенияИнформационнойБазы(), "|", "/");`,
    "Попытка",
    `\tАдрес = ПоместитьВоВременноеХранилище(Новый ДвоичныеДанные(${literal(path)}));`,
    // 2026-10-13, debrief18.md §18.1: without the fourth argument a user with
    // «Защита от опасных действий» on gets «Разрешить открывать данный файл?» on
    // every check, and the call hangs until someone answers. The signature is
    // the one БСП uses (ДополнительныеОтчетыИОбработки, ОписаниеЗащитыБезПредупреждений).
    "\tЗащита = Новый ОписаниеЗащитыОтОпасныхДействий;",
    "\tЗащита.ПредупреждатьОбОпасныхДействиях = Ложь;",
    `\tИмя = ВнешниеОбработки.Подключить(Адрес, ${literal(attachName)}, Ложь, Защита);`,
    '\tР = Р + "|attached=" + Имя;',
    "Исключение",
    `\tР = Р + "|attach=" + ${FLATTEN};`,
    "\tИмя = Неопределено;",
    "КонецПопытки;",
    "Если Имя <> Неопределено Тогда",
    "\tПопытка",
    "\t\tМ = ВнешниеОбработки.Создать(Имя, Ложь).Метаданные();",
    '\t\tФормы = "";',
    "\t\tДля Каждого Ф Из М.Формы Цикл",
    '\t\t\tФормы = Формы + ?(Формы = "", "", ",") + Ф.Имя;',
    "\t\tКонецЦикла;",
    '\t\tР = Р + "|name=" + М.Имя + "|object=ok|forms=" + Формы;',
    "\tИсключение",
    `\t\tР = Р + "|object=" + ${FLATTEN};`,
    "\tКонецПопытки;",
    "КонецЕсли;",
    "Результат = Р;",
  ].join("\n")
}

export function clientCheckCode(attachName: string, forms: readonly string[]): string {
  return [
    `Р = "${CLIENT_MARKER}";`,
    `Для Каждого ИмяФормы Из СтрРазделить(${literal(forms.join(","))}, ",", Ложь) Цикл`,
    "\tПопытка",
    `\t\tФорма = ПолучитьФорму("ВнешняяОбработка." + ${literal(attachName)} + ".Форма." + ИмяФормы, , , Новый УникальныйИдентификатор);`,
    '\t\tР = Р + "|" + ИмяФормы + "=ok";',
    "\tИсключение",
    `\t\tР = Р + "|" + ИмяФормы + "=" + ${FLATTEN};`,
    "\tКонецПопытки;",
    "КонецЦикла;",
    "Результат = Р;",
  ].join("\n")
}

function fields(line: string): Map<string, string> {
  return new Map(
    line
      .split("|")
      .slice(1)
      .map((part) => {
        const at = part.indexOf("=")
        return at > 0 ? ([part.slice(0, at), part.slice(at + 1)] as const) : ([part, ""] as const)
      }),
  )
}

export interface ServerCheck {
  readonly connectionString: string
  readonly attachError?: string
  readonly name?: string
  /** "ok", or the compile/runtime error of the object module. */
  readonly object?: string
  readonly forms: readonly string[]
}

export function parseServerCheck(text: string): ServerCheck | null {
  const line = findMarkedLine(text, SERVER_MARKER)
  if (!line) return null
  const found = fields(line)
  const forms = found.get("forms")
  return {
    connectionString: found.get("СтрокаСоединения") ?? "",
    ...(found.has("attach") ? { attachError: found.get("attach") } : {}),
    ...(found.get("name") ? { name: found.get("name") } : {}),
    ...(found.has("object") ? { object: found.get("object") } : {}),
    forms: forms ? forms.split(",").filter(Boolean) : [],
  }
}

/** Form name → "ok" or its error text. */
export function parseClientCheck(text: string): ReadonlyMap<string, string> | null {
  const line = findMarkedLine(text, CLIENT_MARKER)
  return line ? fields(line) : null
}

export type EpfCheckOutcome =
  | { readonly ok: true; readonly text: string; readonly passed: boolean }
  | { readonly ok: false; readonly reason: "other-infobase" | "unreadable" | "failed"; readonly detail?: string }

export async function checkEpf(
  request: { readonly path: string; readonly expectName?: string },
  profile: { kind: "file" | "server"; filePath?: string; serverCluster?: string; serverDatabase?: string },
  options: ToolkitCallOptions & { readonly now?: () => number } = {},
): Promise<EpfCheckOutcome> {
  const attachName = `Проверка${(options.now ?? Date.now)()}`
  const call = { timeoutMs: 60_000, ...options }

  const serverText = await callToolkitTool("execute_code", { code: serverCheckCode(request.path, attachName) }, call).catch(
    (error: unknown) => new Error(timeoutText(error, call.timeoutMs, "серверная часть: подключение и модуль объекта")),
  )
  if (serverText instanceof Error) return { ok: false, reason: "failed", detail: serverText.message }
  const server = parseServerCheck(serverText)
  if (!server) return { ok: false, reason: "unreadable", detail: serverText.slice(0, 300) }
  if (!sameInfobase(server.connectionString, profile)) {
    return { ok: false, reason: "other-infobase", detail: server.connectionString }
  }

  if (server.attachError) {
    return { ok: true, passed: false, text: `Обработка не подключилась:\n${server.attachError}` }
  }

  // The client half only when there is something to create: without a working
  // object module the platform will not get as far as the forms.
  const forms =
    server.object === "ok" && server.forms.length
      ? await callToolkitTool("execute_code_client", { code: clientCheckCode(attachName, server.forms) }, call)
          .then((text) => parseClientCheck(text) ?? new Error(clientFailure(text)))
          .catch((error: unknown) => new Error(clientFailure(timeoutText(error, call.timeoutMs, "клиентская часть: формы"))))
      : null

  return describeCheck(server, forms, request.expectName)
}

/**
 * A timed-out call names its step and the likely cause. 2026-10-13,
 * debrief18.md §18.1: the bare «AbortError: This operation was aborted» came
 * back twice while the session sat on a platform dialog, and the agent retried
 * blind.
 */
function timeoutText(error: unknown, timeoutMs: number, step: string): string {
  const text = String(error)
  if (!/AbortError|aborted|timed? ?out/i.test(text)) return text
  return (
    `тулкит не ответил за ${Math.round(timeoutMs / 1000)} с (${step}). Чаще всего сеанс 1С держит окно, ` +
    "которое ждёт ответа: посмотри 1c_processes, прежде чем повторять."
  )
}

/**
 * Why the form half did not run, said so the agent stops rather than retries.
 *
 * 2026-09-25, observed live: «Формы проверить не удалось: ответ не распознан:
 * {"success": false, "error": "Неизвестный инструмент: execute_code_client"}».
 * That reads like a transient parsing problem and is not one -- a form module
 * compiles only when a form is created, creating a form needs CLIENT context,
 * and this toolkit build serves server-side execution only. No retry and no
 * rephrasing will change it, so the message has to name the limit and the way
 * round it.
 */
function clientFailure(detail: string): string {
  if (/execute_code_client|Неизвестный инструмент/i.test(detail)) {
    return [
      "в этой сборке MCP Toolkit нет выполнения кода на клиенте, а модуль формы компилируется",
      "только при создании формы, и создать её можно лишь в клиентском контексте. Пробовать снова",
      "или иначе формулировать код бесполезно. Проверить модуль формы сейчас можно только одним",
      "способом: открыть форму в сеансе 1С и посмотреть, не появилась ли ошибка компиляции.",
    ].join(" ")
  }
  return `ответ не распознан: ${detail.slice(0, 300)}`
}

function describeCheck(
  server: ServerCheck,
  forms: ReadonlyMap<string, string> | Error | null,
  expectName: string | undefined,
): EpfCheckOutcome {
  // 2026-09-25, observed live. `expect_name` used to be compared against
  // `server.name`, and that comparison could never pass: the probe attaches the
  // file under a generated `Проверка<timestamp>` name, and for an attached
  // external processing the platform reports the ATTACH name from
  // `Метаданные().Имя` -- not the name stored in the file. So every call that
  // passed `expect_name` was told «ОЖИДАЛОСЬ «X». Это другая обработка — скорее
  // всего, заготовка, из которой собирали», about its own correct build. A check
  // that accuses the artefact of being the wrong file is worse than no check: it
  // sends the agent to re-examine a build that was never broken.
  //
  // The name inside the container is readable without the platform (`v8pack
  // info`), which is where this belongs; until it is wired, the comparison is not
  // made rather than made wrongly.
  const attachedName = server.name
  const wrongName = false
  const formRows =
    forms instanceof Map
      ? server.forms.map((form) => `| Форма «${form}» | ${forms.get(form) === "ok" ? "компилируется" : (forms.get(form) ?? "не проверена")} |`)
      : server.forms.map((form) => `| Форма «${form}» | не проверена |`)
  // Three outcomes, not two. 2026-09-26, debrief13.md §13.12: forms that could
  // not be checked made `passed` false, and false printed «Есть ошибки» under a
  // table that showed none -- a failure the tool invented.
  const formResult = (form: string) => (forms instanceof Map ? forms.get(form) : undefined)
  const objectFailed = typeof server.object === "string" && server.object !== "ok"
  const formsFailed = server.forms.some((form) => formResult(form) !== undefined && formResult(form) !== "ok")
  const failed = objectFailed || formsFailed || wrongName
  const unchecked = [
    ...(server.object === "ok" || objectFailed ? [] : ["модуль объекта"]),
    ...server.forms.filter((form) => formResult(form) === undefined).map((form) => `форма «${form}»`),
  ]
  const passed = !failed && unchecked.length === 0
  return {
    ok: true,
    passed,
    text: [
      `Подключена под именем: ${attachedName ?? "не получено"} (имя подключения, а не имя из файла).`,
      ...(expectName !== undefined
        ? [
            `Имя внутри файла этой проверкой не читается — платформа возвращает имя подключения. ` +
              `Чтобы убедиться, что собралось «${expectName}», посмотри имя в контейнере: v8pack info.`,
          ]
        : []),
      "",
      "| Что | Результат |",
      "|---|---|",
      `| Модуль объекта | ${server.object === "ok" ? "компилируется" : (server.object ?? "не проверен")} |`,
      ...formRows,
      ...(server.forms.length ? [] : ["| Формы | их нет |"]),
      "",
      ...(forms instanceof Error
        ? [`Формы проверить не удалось: ${forms.message}`, "Пока форма ни разу не создавалась, про её модуль ничего не известно."]
        : []),
      failed
        ? "Есть ошибки — в тексте выше модуль, строка и позиция."
        : passed
          ? "Всё компилируется. Формы создавались без показа окна; ПриСозданииНаСервере при этом выполнялся."
          : `Ошибок в проверенном нет, но проверено не всё: ${unchecked.join(", ")}. ` +
            "Про непроверенное ничего не известно — ни что там ошибка, ни что её нет.",
    ].join("\n"),
  }
}
