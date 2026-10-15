// Did the infobase plugin actually register its tools?
//
// 2026-09-23, debrief8.md §E7 and failures_to_tools.md T7. The plugin is loaded
// by the sidecar, and when the sidecar rejects it the failure is written to
// `~/.local/share/opencode/log/opencode.log` and nowhere else:
//
//   ERROR failed to load plugin … error="Plugin export is not a function"
//
// A session then runs with no `1c_profile_info`, no `1c_toolkit_start`, no
// guarded DESIGNER operations -- and, because the guards live in the plugin's
// `tool.execute.before` hook, no permission gate, no bulk-write refusal and no
// support guard either. Nothing says so. On 2026-09-23 an agent spent six hours
// in that state: it proved the relay healthy by hand, pulled its session id out
// of SQLite, borrowed its parent's binding, wrote its own MCP client, and
// reached the live base by a path nothing instruments. Every step read as
// competent engineering.
//
// The point of this file is that the absence stops being silent. It does not
// try to repair anything: a plugin that failed to load needs a new sidecar, and
// that is the user's call.

/** One `1c_*` tool per capability we would lose; missing any of them is the signal. */
export const EXPECTED_PLUGIN_TOOLS = [
  "1c_profile_info",
  "1c_toolkit_start",
  "1c_mxl_info",
  "1c_mxl_edit",
  "1c_compare_with_sample",
  "1c_dump_object",
  "1c_print_capabilities",
  "1c_write_code",
  "1c_check_epf",
  "1c_check_dcs",
  "1c_processes",
  "1c_close_dialog",
  "1c_session_writes",
  "1c_check_config",
  "1c_dump_config",
  "1c_dump_config_to_files",
  "1c_dump_epf_to_files",
  "1c_load_epf_from_files",
  "1c_load_config",
  "1c_load_config_from_files",
  "1c_delete_extension",
  "1c_new_extension",
  "1c_new_external",
  "1c_run_report",
  "1c_update_db",
  "1c_run_epf",
] as const

export interface RegistrationVerdict {
  /** False when the sidecar could not be asked at all -- unknown, not broken. */
  readonly checked: boolean
  readonly registered: readonly string[]
  readonly missing: readonly string[]
  /** True when every expected tool is present. */
  readonly ok: boolean
}

export interface RegistrationDeps {
  /** GET a sidecar path, already authenticated. Returns the body, or null. */
  readonly get: (path: string) => Promise<string | null>
}

/**
 * Asks the sidecar which tools it registered.
 *
 * `/experimental/tool/ids` lists built-in and dynamically registered tools
 * alike, which is exactly the question: the plugin's tools are dynamic, so
 * their absence from that list is the fact we want and the only one that
 * distinguishes "rejected" from "fine".
 */
export async function checkPluginRegistration(deps: RegistrationDeps): Promise<RegistrationVerdict> {
  const body = await deps.get("/experimental/tool/ids").catch(() => null)
  if (body === null) {
    return { checked: false, registered: [], missing: [], ok: false }
  }

  // Tolerant of shape: the endpoint may return an array of ids or objects with
  // an id field. A substring test over the raw body would be simpler and would
  // also match ids mentioned in prose, so parse when we can.
  let ids: string[] = []
  try {
    const parsed: unknown = JSON.parse(body)
    const walk = (value: unknown): void => {
      if (typeof value === "string") ids.push(value)
      else if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === "object") {
        const id = (value as Record<string, unknown>).id
        if (typeof id === "string") ids.push(id)
        else Object.values(value as Record<string, unknown>).forEach(walk)
      }
    }
    walk(parsed)
  } catch {
    return { checked: false, registered: [], missing: [], ok: false }
  }

  const present = new Set(ids)
  const registered = EXPECTED_PLUGIN_TOOLS.filter((name) => present.has(name))
  const missing = EXPECTED_PLUGIN_TOOLS.filter((name) => !present.has(name))
  return { checked: true, registered, missing, ok: missing.length === 0 }
}

/**
 * How long the sidecar is given to finish loading plugins after it first
 * answers its health check, and how often it is asked meanwhile.
 *
 * 2026-10-05, SERVER_ST: the sidecar answers /health before its bootstrap is
 * done, and that bootstrap took ~10 s there. A single check with a 5 s timeout
 * landed inside it and reported a plugin that loaded moments later as missing
 * (or as unverifiable). A verdict is only final once the tools are there or
 * this long has passed.
 */
export const REGISTRATION_WAIT_MS = 90_000
export const REGISTRATION_POLL_MS = 2_000

export interface RegistrationWaitDeps extends RegistrationDeps {
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

/** Asks until every expected tool is there or REGISTRATION_WAIT_MS runs out; the last answer stands. */
export async function waitForPluginRegistration(deps: RegistrationWaitDeps): Promise<RegistrationVerdict> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + REGISTRATION_WAIT_MS
  for (;;) {
    const verdict = await checkPluginRegistration(deps)
    if (verdict.ok || now() + REGISTRATION_POLL_MS > deadline) return verdict
    await sleep(REGISTRATION_POLL_MS)
  }
}

/**
 * What the user is shown, and what is injected into the agent's prompt.
 *
 * Both audiences need the same three things: that the tools are gone, that the
 * guards went with them, and that the shell is not a substitute. The agent's
 * copy says the last part outright, because the 09-23 session's own reasoning
 * was that hand-rolling the channel was the responsible thing to do.
 */
export function registrationNotice(verdict: RegistrationVerdict): string | null {
  if (verdict.ok || !verdict.checked) return null
  return [
    "⚠ Инструменты работы с информационной базой не зарегистрированы: плагин 1CCoder не загрузился.",
    `Нет: ${verdict.missing.join(", ")}.`,
    "",
    "Вместе с ними не работают и защиты, которые живут в плагине: подтверждение записи в базу,",
    "отказ от массовой записи без отбора, защита объектов на поддержке и проверка путей.",
    "",
    "**Не обходи это.** Не пиши свой MCP-клиент, не ходи в релей напрямую и не запускай 1cv8.exe",
    "через оболочку: так ты получишь доступ к базе без единой проверки. Скажи пользователю, что",
    "приложение нужно перезапустить, и дождись этого.",
  ].join("\n")
}

/**
 * The last verdict, so the UI and the agent prompt can both read it.
 *
 * Module-level and deliberately simple: this is one boolean-ish fact per app
 * run, set once just after the sidecar comes up, read by whoever needs it.
 * Defaults to "unchecked", which is silent -- nothing is claimed before the
 * check has run.
 */
let lastVerdict: RegistrationVerdict = { checked: false, registered: [], missing: [], ok: false }

export function setPluginRegistration(verdict: RegistrationVerdict): void {
  lastVerdict = verdict
}

export function pluginRegistration(): RegistrationVerdict {
  return lastVerdict
}

/** The notice for the current verdict, or null when there is nothing to say. */
export function pluginRegistrationNotice(): string | null {
  return registrationNotice(lastVerdict)
}
