// What the plugin adds around the MCP Toolkit's own tools.
//
// 2026-09-25, failures_to_tools.md G5 and G8. The toolkit's tools
// (`1c_execute_query`, `1c_execute_code`, `1c_get_metadata`, …) are served by
// the toolkit and reached by opencode's MCP client directly, so the app has
// never been able to change what they say. Two things follow from the hooks
// opencode does give a plugin:
//
//   before a call -- a refused port is a fact the app can check in a
//   millisecond, and saying "the toolkit is not running" beats the bare
//   `fetch failed` the call would otherwise produce (a transport failure
//   throws, so no after-hook ever sees it);
//
//   after a call -- the result is the one place the agent reliably reads, so
//   that is where to put the reference it should consult. Every rule the
//   debriefs found firing did so because evidence was in front of the agent;
//   none fired from memory (debrief7.md §6.12).

/** One of the toolkit's tools, as opposed to one of the plugin's own. */
export function isToolkitTool(name: string, pluginTools: readonly string[]): boolean {
  return name.startsWith("1c_") && !pluginTools.includes(name)
}

export interface ToolkitGate {
  /** A configurator operation holds the base right now. */
  readonly designerBusy: boolean
  /** One probe of the port: "free" means a refused connection, nothing listens. */
  readonly port: "up" | "busy" | "free"
  /** The supervisor's own word for its state. */
  readonly state: string
  /** How the last toolkit ended, when nobody stopped it. */
  readonly exit?: ToolkitExitInfo
  /**
   * The profile whose base this session folder's 1c_* tools reach right now,
   * when it is not the session's own. Two sessions in one folder share one MCP
   * client (mcp/ipc.ts linkToolkit), so the other one's link wins.
   */
  readonly linkedTo?: string
}

/** mcp/supervisor.ts ToolkitExit, as it arrives over the relay. */
export interface ToolkitExitInfo {
  readonly code: number | null
  readonly signal: string | null
  readonly lifetimeMs: number
}

/**
 * A toolkit's own exit, for the agent: that it ended by itself, and after how long.
 *
 * debrief15.md §15.15: without this the agent read a dead toolkit as a start
 * that never happened and went looking for other ways to launch 1C. The
 * lifetime is what makes a pattern visible.
 */
export function describeExit(exit: ToolkitExitInfo): string {
  const seconds = Math.round(exit.lifetimeMs / 1000)
  const lifetime = seconds >= 60 ? `${Math.floor(seconds / 60)} мин ${seconds % 60} с` : `${seconds} с`
  return [
    `Процесс 1С с тулкитом завершился сам через ${lifetime} после запуска (код ${exit.code ?? exit.signal}): ` +
      "его не закрывали ни ты, ни приложение.",
    "Если тулкит раз за разом живёт одно и то же время — это поведение базы, а не твоих вызовов: " +
      "скажи об этом пользователю, а работу с базой укладывай в этот срок после 1c_toolkit_start.",
  ].join("\n")
}

/**
 * What `1c_write_code` adds when the tool it sends the agent to is not there.
 *
 * 2026-09-28, debrief15.md §15.14 item 6 and §15.18. `1c_execute_code` is one of
 * the toolkit's own tools, so with the toolkit down it is not in the agent's
 * list at all -- and `1c_write_code`, always there, kept answering «выполняй
 * через `1c_execute_code`». Three times in one run the agent called
 * `1c_write_code` again and again (up to eight calls), once explaining it to
 * itself as «мой вызов уходит в ворота записи».
 */
export function executeCodeUnavailable(gate: ToolkitGate | undefined): string | null {
  if (!gate) return null
  if (gate.designerBusy) {
    return (
      "`1c_execute_code` сейчас недоступен: идёт операция конфигуратора, и MCP Toolkit на это время закрыт. " +
      "Дождись её результата, затем 1c_toolkit_start."
    )
  }
  if (gate.port !== "free") return null
  return [
    "`1c_execute_code` сейчас нет в твоём списке инструментов: MCP Toolkit не запущен (порт не отвечает), " +
      "а его инструменты существуют, только пока он работает. Повторный вызов 1c_write_code этого не изменит.",
    "Вызови 1c_toolkit_start, дождись, когда 1c_* появятся в списке, и выполни код через `1c_execute_code`.",
    ...(gate.exit ? [describeExit(gate.exit)] : []),
  ].join("\n")
}

/**
 * Why a toolkit call cannot work right now, or null to let it through.
 *
 * Only certainties refuse. A busy port lets the call go ahead: the toolkit may
 * be finishing another request, and its own answer is better evidence than a
 * guess made from outside.
 */
export function gateRefusal(gate: ToolkitGate): string | null {
  // First: a call into the wrong base is the one outcome worse than no call.
  if (gate.linkedTo) {
    return [
      `Отклонено: инструменты 1c_* в этом рабочем каталоге сейчас подключены к базе другого профиля («${gate.linkedTo}»).`,
      "Так бывает, когда в одном каталоге открыты сеансы с разными профилями: подключение у каталога одно.",
      "Вызов ушёл бы не в твою базу. Скажи об этом пользователю: у каждого профиля должен быть свой рабочий каталог,",
      "или сеанс другого профиля нужно закрыть. Повтор этого вызова ничего не изменит.",
    ].join("\n")
  }
  if (gate.designerBusy) {
    return [
      "Сейчас идёт операция конфигуратора: она держит базу монопольно, и MCP Toolkit на это время закрыт.",
      "Дождись её результата. Потом, если инструменты 1c_* ещё нужны, вызови 1c_toolkit_start.",
      "Операцию конфигуратора и вызов 1c_* в одном шаге не совмещай.",
    ].join("\n")
  }
  if (gate.port !== "free") return null
  return [
    `MCP Toolkit не запущен (порт не отвечает; состояние: ${gate.state}). Этот вызов вернул бы «fetch failed»,`,
    "и это была бы не сетевая ошибка и не ошибка твоего кода.",
    "Подними тулкит через 1c_toolkit_start. Инструменты 1c_* снова заработают, когда появятся в списке.",
    ...(gate.exit ? [describeExit(gate.exit)] : []),
  ].join("\n")
}

/** The text of a tool result, whichever shape it came in. */
export function resultText(result: unknown): string {
  if (!result || typeof result !== "object") return ""
  const record = result as { output?: unknown; content?: unknown }
  if (typeof record.output === "string") return record.output
  if (!Array.isArray(record.content)) return ""
  return record.content
    .map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
    .join("\n")
}

/** Adds a paragraph to a tool result in place, whichever shape it came in. */
export function appendToResult(result: unknown, text: string): void {
  if (!result || typeof result !== "object") return
  const record = result as { output?: unknown; content?: unknown }
  if (typeof record.output === "string") {
    record.output = `${record.output}\n\n${text}`
    return
  }
  if (Array.isArray(record.content)) record.content.push({ type: "text", text })
}

/** The toolkit reports a failed call inside a successful MCP reply. */
export function isFailure(result: unknown): boolean {
  if (result && typeof result === "object" && (result as { isError?: unknown }).isError === true) return true
  return /"success"\s*:\s*false/.test(resultText(result))
}

// The toolkit returns its error inside JSON, so the quotes arrive escaped.
const QUERY_FIELD = /Поле не найдено\s*\\?"([^"\\]+)\\?"/i
const OBJECT_FIELD = /Поле объекта не обнаружено\s*\(([^)]+)\)/i
const METHOD = /Метод объекта не обнаружен\s*\(([^)]+)\)/i

/** `Документ.Имя` for each alias in a query: «ИЗ Документ.Имя КАК Т». */
function aliases(query: string): ReadonlyMap<string, string> {
  const found = [...query.matchAll(/([А-Яа-яЁёA-Za-z]+\.[0-9А-Яа-яЁёA-Za-z_.]+)\s+(?:КАК|AS)\s+([0-9А-Яа-яЁёA-Za-z_]+)/gi)]
  return new Map(found.map((match) => [match[2]!.toLowerCase(), match[1]!]))
}

/**
 * A pointer to the reference that answers a name error, or null.
 *
 * The agent guesses attribute and property names and then adjusts the guess,
 * and it consults the reference readily once one is in front of it. So the
 * error that names a missing field is the moment to name the lookup.
 */
export function referenceHint(result: unknown, args: unknown): string | null {
  const text = resultText(result)
  const query = typeof (args as { query?: unknown })?.query === "string" ? (args as { query: string }).query : ""

  const field = QUERY_FIELD.exec(text)?.[1]
  if (field) {
    const [alias] = field.split(".")
    const table = alias ? aliases(query).get(alias.toLowerCase()) : undefined
    return [
      `Поля «${field}» нет${table ? ` в ${table}` : ""}. Не подбирай имя наугад: состав реквизитов и табличных частей`,
      `${table ? `объекта ${table}` : "объекта"} возвращает 1c_get_metadata — вызови его и возьми имя оттуда.`,
    ].join("\n")
  }

  const member = OBJECT_FIELD.exec(text)?.[1] ?? METHOD.exec(text)?.[1]
  if (member) {
    return [
      `У объекта нет «${member}». Если это объект платформы (ТабличныйДокумент, Запрос, ОбластьЯчеек…) —`,
      "его свойства и методы возвращает 1c_get_bsl_syntax_help; если объект конфигурации — 1c_get_metadata.",
      "Посмотри там, прежде чем пробовать другое имя.",
    ].join("\n")
  }
  return null
}

/**
 * Counts identical failures, per session.
 *
 * "Identical" means same tool, same arguments, and the same first line of the
 * error. The second one is the signal: the agent has changed nothing that
 * matters, and the next change of a number will not help either.
 */
export class RepeatedFailures {
  private readonly seen = new Map<string, number>()

  /**
   * Records a failure and returns how many times this exact one has happened.
   *
   * Keyed on the error itself. 2026-09-26, debrief14.md §14.5: keyed on the
   * result's first line, which for the toolkit's JSON answers is always `{`, so
   * one check re-run after each fix got «второй раз» for four different errors.
   */
  record(sessionID: string, tool: string, args: unknown, result: unknown): number {
    const key = [sessionID, tool, JSON.stringify(args ?? null), errorOf(resultText(result))].join("\u0000")
    const count = (this.seen.get(key) ?? 0) + 1
    this.seen.set(key, count)
    return count
  }
}

/** The error a result reports: the toolkit's JSON `error` field, else the whole text. */
function errorOf(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text)
    const error = parsed && typeof parsed === "object" ? (parsed as { error?: unknown }).error : undefined
    if (typeof error === "string") return error.trim()
  } catch {
    // Not JSON: the text is the error.
  }
  return text.trim()
}

export const REPEATED_FAILURE_NOTICE = [
  "Та же ошибка на тот же вызов — второй раз. Ещё одна правка числа или имени её не снимет:",
  "добери факты. Имена полей — 1c_get_metadata; свойства и методы платформы — 1c_get_bsl_syntax_help;",
  "устройство конфигурации — её выгрузка (1c_dump_config_to_files). Если все источники молчат — спроси пользователя.",
].join("\n")

// 2026-09-29, debrief16.md §16.1. MCP_Toolkit.epf masks fragments of its own
// replies that look like requisites -- an 8-letter brand in a product name, a
// word inside an XML namespace -- as `[SWIFT-00002]`. The agent read a token as
// data and put it into a query, which then matched nothing. The app cannot
// switch the masking off (it is the toolkit's), so it says what a token is.
// debrief17.md §17.3: the masking is the toolkit's privacy layer, with its own
// way back for the user (`submit_for_deanonymization`); the first version of
// this note advised reading values through a file, around it. That is gone.
const MASK_TOKEN = /\[[A-Z]{2,}-\d{3,}\]/g

/** A note for a toolkit result that holds masking tokens, or null. */
export function maskedNote(result: unknown): string | null {
  const tokens = [...new Set(resultText(result).match(MASK_TOKEN) ?? [])]
  if (!tokens.length) return null
  return (
    `В ответе тулкита есть маскированные фрагменты (${tokens.slice(0, 5).join(", ")}${tokens.length > 5 ? ", …" : ""}): ` +
    "тулкит сам заменяет токенами то, что похоже на персональные данные и реквизиты. Это не данные. Не подставляй " +
    "токен в запрос или код и не делай по нему выводов о значении — отбирай по ссылке, коду или части текста без " +
    "токена. Обходить маскирование не нужно: если токен попадёт в итоговый ответ пользователю, оставь его как есть " +
    "и перед ответом вызови 1c_submit_for_deanonymization с полным текстом — пользователь увидит настоящие значения."
  )
}

/** A refusal for a query or code that carries a masking token back into the base, or null. */
export function maskedTokenRefusal(args: unknown): string | null {
  const record = (args ?? {}) as { query?: unknown; code?: unknown }
  const text = [record.query, record.code].filter((value): value is string => typeof value === "string").join("\n")
  const token = text.match(MASK_TOKEN)?.[0]
  if (!token) return null
  return (
    `Отклонено: в тексте ${token} — токен, которым тулкит маскирует свой ответ, а не значение из базы. ` +
    "С ним запрос ничего не найдёт. Возьми ссылку, код или часть текста без токена."
  )
}
