// Making the shell tell the truth about Cyrillic, by construction.
//
// 2026-09-23, debrief9.md §9.7 and failures_to_tools.md T2. This is the most
// repeated failure in the series -- five debriefs, at least eleven separate
// encounters -- and `1ccoder-shell` is the most violated skill in the set. The
// reason prose cannot fix it is on the record: on 2026-09-23 the agent was
// bitten three times in one hour, and then reasoned *carefully* from a corrupted
// view to a false conclusion about the product:
//
//   1.12 MB of query output was truncated to a file. The agent inspected it
//   three ways -- ReadAllText as UTF-8, a raw byte dump, a cp1251 re-decode --
//   printing each through Write-Host, and got "?" every time. It concluded that
//   large outputs lose Cyrillic before being written, and re-ran the whole
//   inspection in small pieces to work around it.
//
//   The file was intact: 1 121 469 bytes, zero 0x3F, 409 406 Cyrillic UTF-8
//   lead bytes. The "?" was PowerShell's console encoding, every time.
//
// So the cost is not the wasted turns. It is that a sound chain of reasoning
// over a corrupted view produces a false belief about the system, and nothing
// distinguishes that from a true one. A rule cannot help here: the rule was
// loaded, and had already fired three times that hour.
//
// Scope is deliberately narrow. The encoding preamble needs no judgement, so it
// is applied always. The one refusal below is for a command shape that has a
// measured cost and an exact replacement. The broader "never use Get-Content or
// Select-String" from T2 is NOT implemented: the preamble removes the harm those
// caused, and refusing them outright would block legitimate pipelines, which is
// how guards come to be worked around.

import { existsSync } from "node:fs"
import { join } from "node:path"

/**
 * Environment for every shell the sidecar spawns.
 *
 * Python is here because the same corruption reaches it by a different route:
 * its default stdout encoding on Windows is the ANSI codepage, so printing a
 * Cyrillic string raises UnicodeEncodeError or mangles it. PYTHONUTF8 covers
 * file I/O as well, which is where the same bug produced a cp1252 crash while
 * reading a session transcript.
 */
export const SHELL_ENV: Readonly<Record<string, string>> = {
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
}

/**
 * Prepended to every PowerShell command.
 *
 * `UTF8Encoding $false` rather than `[Text.Encoding]::UTF8`: the latter carries
 * a BOM, and `$OutputEncoding` governs what PowerShell sends to native
 * executables, so a BOM there lands in the first argument of every `curl` or
 * `1cv8` invocation.
 *
 * `[Console]::OutputEncoding` is assigned inside try/catch because it throws
 * when no console is attached, which is exactly the non-interactive case the
 * sidecar runs in. `$OutputEncoding` is a plain variable and always assignable,
 * so the useful half survives a failure of the other.
 */
export const ENCODING_PREAMBLE =
  "$OutputEncoding=New-Object System.Text.UTF8Encoding $false; " +
  "try{[Console]::OutputEncoding=$OutputEncoding}catch{}; "

/** Already prepared, by us or by the agent copying the idiom. */
function hasEncodingSetup(command: string): boolean {
  return /OutputEncoding/.test(command)
}

/**
 * The command to actually run.
 *
 * Returns the input unchanged when there is nothing to do, so the caller can
 * leave `output.args.command` alone and keep the transcript honest.
 */
export function withEncoding(command: string, platform: string = process.platform): string {
  if (platform !== "win32") return command
  if (!command.trim() || hasEncodingSetup(command)) return command
  return ENCODING_PREAMBLE + command
}

/**
 * A recursive PowerShell content search.
 *
 * 2026-09-23, debrief9.md §9.9b. `Get-ChildItem -Recurse | Select-String` over
 * the configuration dump hit the 120 s bash timeout and returned one garbled
 * path. The native `grep` answers the same question in about a second, and the
 * agent used it correctly a dozen times in the same session -- it reached for
 * PowerShell only because it wanted the whole tree and `grep` without a path
 * searches the working directory rather than the dump.
 *
 * Matched as two facts in one command rather than by either alone: a recursive
 * listing is fine, and a `Select-String` is fine; piping the first into the
 * second over a 96 000-file tree is the thing that cost the time.
 */
const RECURSIVE_CONTENT_SEARCH = /Get-ChildItem[^|]*-Recurse[^|]*\|[^|]*Select-String/i

/**
 * The platform, launched in a mode that opens the infobase.
 *
 * 2026-09-25, failures_to_tools.md G1. Every configurator operation the agent
 * has ever run by hand now has a guarded tool, and the hand-rolled route kept
 * being taken anyway -- in debrief7 §4 while the agent assured itself it
 * "would not touch the toolkit". A hand-rolled DESIGNER run takes none of
 * `needsExclusiveInfobase()`'s precautions, so the exclusivity guard only
 * exists on the path the agent chooses to use. Prose (D10) asked; this refuses.
 *
 * The mode has to be a standalone argument, so a `grep DESIGNER` over a log
 * directory under `...\1cv8\` is not mistaken for a launch.
 */
const PLATFORM_EXECUTABLE = /1cv8c?(?:\.exe)?/i
const PLATFORM_MODE = /(?:^|[\s"'`(,])(DESIGNER|ENTERPRISE)(?=[\s"'`),]|$)/i

/** Batch switches with a guarded counterpart, most specific first. */
const GUARDED_SWITCHES: readonly (readonly [RegExp, string])[] = [
  [/\/DumpConfigToFiles/i, "1c_dump_config_to_files"],
  [/\/DumpCfg/i, "1c_dump_config"],
  [/\/LoadConfigFromFiles/i, "1c_load_config_from_files"],
  [/\/LoadCfg/i, "1c_load_config"],
  [/\/DeleteCfg/i, "1c_delete_extension"],
  [/\/UpdateDBCfg/i, "1c_update_db"],
  [/\/Check(?:Config|Modules)/i, "1c_check_config"],
  [/\/DumpExternalDataProcessorOrReportToFiles/i, "1c_dump_epf_to_files"],
  [/\/LoadExternalDataProcessorOrReportFromFiles/i, "1c_load_epf_from_files"],
  [/MCP_Toolkit/i, "1c_toolkit_start"],
  [/\/Execute/i, "1c_run_epf"],
]

function platformLaunchRefusal(command: string): string | null {
  if (!PLATFORM_EXECUTABLE.test(command)) return null
  const mode = PLATFORM_MODE.exec(command)?.[1]?.toUpperCase()
  if (!mode) return null
  const replacement = GUARDED_SWITCHES.find(([pattern]) => pattern.test(command))?.[1]
  const hasExtensionScope = /-Extension\b/i.test(command)
  return [
    // 2026-09-25. The first line used to be «Отклонено: запуск платформы 1С
    // (DESIGNER) из оболочки», which says neither who refused nor why, and the
    // session read it as a property of the environment: «Оболочка блокирует
    // прямой запуск конфигуратора» -- told to the user as fact. The shell blocked
    // nothing; the command never ran, because this hook refused the tool call. An
    // agent that believes the environment is restricted looks for a way around
    // it; one that knows a tool is doing the routing uses the tool.
    `Отклонено: это 1CCoder не пропускает запуск платформы (${mode}) через оболочку — команда не выполнялась.`,
    "",
    "Запуск из оболочки обходит всё, что делают инструменты 1c_*: конфигуратор не может работать",
    "с базой, которую держит сеанс MCP Toolkit, и инструмент сначала закрывает тулкит, передаёт",
    "учётные данные профиля, читает журнал /Out именно этого запуска и не даёт поднять тулкит,",
    "пока операция идёт. Команда из оболочки ничего из этого не делает.",
    "",
    replacement
      ? `Для этой операции есть инструмент: \`${replacement}\`.` +
        // 2026-09-25. Without this line the redirect was wrong for an
        // extension-scoped command: the agent had `-Extension <Имя>` in its own
        // command, was sent to a tool it believed could only touch the main
        // configuration, and dumped 97 000 files of it instead.
        (hasExtensionScope
          ? " Команда ограничена расширением — передай его имя параметром `extension`, тогда инструмент сделает" +
            " ровно то же самое (`-Extension`) со всеми проверками."
          : "")
      : "Для этой операции инструмента нет. Покажи пользователю команду и попроси запустить её самого — " +
        "с закрытым окном MCP Toolkit.",
    "",
    "Если инструмент сообщил об ошибке, это не повод идти в оболочку: сначала проверь, не появился ли",
    "результат (каталог выгрузки, собранный файл) — сообщение об ошибке связи не означает, что",
    "операция не выполнилась.",
  ].join("\n")
}

// debrief15.md §15.5: `rg` in a shell command on a machine without it -- the
// command fails («The term 'rg' is not recognized») and a step is lost. The
// shell skill says so, but only an agent that loaded the skill knows.
const RG_COMMAND = /(?:^|[;|&\n(])\s*(?:&\s*)?rg(?:\.exe)?(?=\s|$)/i

/** Whether an executable is on PATH. Checked once per name. */
const onPathCache = new Map<string, boolean>()
export function onPath(name: string, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const cached = onPathCache.get(name)
  if (cached !== undefined) return cached
  const dirs = (env.PATH ?? env.Path ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean)
  const names = process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name]
  const found = dirs.some((dir) => names.some((file) => existsSync(join(dir, file))))
  onPathCache.set(name, found)
  return found
}

export function shellRefusal(command: string, rgAvailable: () => boolean = () => onPath("rg")): string | null {
  const launch = platformLaunchRefusal(command)
  if (launch) return launch
  if (RG_COMMAND.test(command) && !rgAvailable()) {
    return [
      "Отклонено: `rg` на этой машине не установлен — команда упала бы с «rg is not recognized».",
      "",
      "Тот же поиск делает инструмент `grep` (он сам на ripgrep), с `path` и `include`:",
      "",
      "    grep(pattern: \"<что ищешь>\", path: \"<каталог>\", include: \"*.bsl\")",
    ].join("\n")
  }
  if (!RECURSIVE_CONTENT_SEARCH.test(command)) return null
  return [
    "Отклонено: рекурсивный поиск по содержимому через PowerShell.",
    "",
    "`Get-ChildItem -Recurse | Select-String` по дереву выгрузки конфигурации упирается в таймаут",
    "(десятки тысяч файлов — дольше лимита команды) и возвращает искажённые пути. Инструмент",
    "`grep` отвечает на тот же вопрос за секунды.",
    "",
    "Укажи `path` — без него `grep` ищет в рабочем каталоге, а не в выгрузке:",
    "",
    "    grep(pattern: \"<что ищешь>\", path: \"<каталог выгрузки>\\\\cfg\")",
  ].join("\n")
}

/** The shell command a tool call is about to run, or undefined when it is not one. */
export function commandFrom(toolName: string, args: unknown): string | undefined {
  if (toolName.toLowerCase() !== "bash") return undefined
  if (typeof args !== "object" || args === null) return undefined
  const command = (args as Record<string, unknown>).command
  return typeof command === "string" && command.trim() ? command : undefined
}
