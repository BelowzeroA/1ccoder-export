// Which 1C processes are open on the session's infobase, and closing ours.
//
// 2026-09-25, failures_to_tools.md T5 (debrief3.md §4.1, debrief4.md §3). A
// processing launched with /Execute can leave a window -- its own modal form,
// or the platform's error dialog for a missing file -- that blocks the 1C
// client, and with it the MCP Toolkit that lives inside a client session. The
// executor notices the toolkit going silent and says so, but the agent could
// only tell the user "close the 1C window" without saying which one, and every
// time it was the observer who enumerated Win32_Process by hand to find it.
//
// Listing is read-only. Closing is limited to processes this app started:
// the user's own 1C sessions may hold unsaved work, and nothing here can know.

import { execFile } from "node:child_process"

import {
  describeDialog,
  nodeDialogPress,
  nodeDialogProbe,
  type DialogPress,
  type DialogProbe,
  type PlatformDialog,
} from "./dialogs"

export interface PlatformProcess {
  readonly pid: number
  readonly parentPid: number
  readonly commandLine: string
  readonly startedAt?: string
  readonly windowTitle?: string
}

/**
 * One PowerShell call: the process table plus each window title, as JSON.
 * Passed as -EncodedCommand so no quoting layer can touch it, with UTF-8 output
 * so Cyrillic paths and titles survive.
 */
export const LIST_SCRIPT = [
  "$OutputEncoding = New-Object System.Text.UTF8Encoding $false",
  "try { [Console]::OutputEncoding = $OutputEncoding } catch {}",
  "@(Get-CimInstance Win32_Process -Filter \"Name like '1cv8%'\" | ForEach-Object {",
  "  $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue",
  "  [pscustomobject]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; cmd = $_.CommandLine;",
  "    started = if ($_.CreationDate) { $_.CreationDate.ToString('s') } else { '' };",
  "    title = if ($p) { $p.MainWindowTitle } else { '' } }",
  "}) | ConvertTo-Json -Compress",
].join("\n")

export interface ProcessDeps {
  /** Runs the listing script and returns its stdout. */
  readonly list: () => Promise<string>
  readonly kill: (pid: number) => void
  /** This process's pid: the parent of every 1C the app launched. */
  readonly selfPid: number
  /**
   * Reads the dialogs these processes show. Optional: a window title is all
   * the listing had before, and a test need not start PowerShell.
   */
  readonly dialogs?: DialogProbe
  /** Presses a named button in a dialog of a process (1c_close_dialog). Optional for the same reason. */
  readonly press?: DialogPress
}

export function nodeProcessDeps(): ProcessDeps {
  return {
    list: () =>
      new Promise((resolve, reject) => {
        execFile(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(LIST_SCRIPT, "utf16le").toString("base64")],
          { windowsHide: true, timeout: 30_000, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        )
      }),
    kill: (pid) => process.kill(pid),
    selfPid: process.pid,
    dialogs: nodeDialogProbe,
    press: nodeDialogPress,
  }
}

export function parseProcessList(json: string): readonly PlatformProcess[] {
  const trimmed = json.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed) as unknown
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .map((row) => ({
      pid: Number(row.pid),
      parentPid: Number(row.parent),
      commandLine: typeof row.cmd === "string" ? row.cmd : "",
      ...(typeof row.started === "string" && row.started ? { startedAt: row.started } : {}),
      ...(typeof row.title === "string" && row.title ? { windowTitle: row.title } : {}),
    }))
    .filter((row) => Number.isFinite(row.pid))
}

function normalise(value: string): string {
  return value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()
}

/** Whether a command line opens this profile's infobase. */
export function opensInfobase(
  commandLine: string,
  profile: { kind: "file" | "server"; filePath?: string; serverCluster?: string; serverDatabase?: string },
): boolean {
  const line = normalise(commandLine)
  const needle =
    profile.kind === "file"
      ? profile.filePath && normalise(profile.filePath)
      : profile.serverDatabase && `\\${normalise(profile.serverDatabase)}`
  if (!needle) return false
  // Followed by the end of the value, so a base named `buh` does not claim the
  // processes of `buh2` beside it.
  return [...line.matchAll(new RegExp(escapeRegExp(needle), "g"))].some((match) =>
    /^(?:["';\s\\]|$)/.test(line.slice(match.index + needle.length)),
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export type ProcessRole = "toolkit" | "operation" | "user"

export function roleOf(process: PlatformProcess, selfPid: number): ProcessRole {
  if (process.parentPid !== selfPid) return "user"
  return /MCP_Toolkit/i.test(process.commandLine) ? "toolkit" : "operation"
}

function mode(commandLine: string): string {
  return /\bDESIGNER\b/i.test(commandLine) ? "конфигуратор" : "предприятие"
}

function target(commandLine: string): string {
  const execute = /\/Execute\s*"?([^"]+?)"?(?:\s+\/|$)/i.exec(commandLine)?.[1]
  if (execute) return execute.split(/[\\/]/).at(-1) ?? execute
  const switchName = /\/(Dump\w+|Load\w+|UpdateDBCfg|CheckConfig)/i.exec(commandLine)?.[1]
  return switchName ? `/${switchName}` : ""
}

export function describeProcesses(
  processes: readonly PlatformProcess[],
  selfPid: number,
  dialogs: readonly PlatformDialog[] = [],
): string {
  if (!processes.length) return "Процессов 1С на базе этого профиля нет."
  // The main window's title says nothing about a modal on top of it, and a
  // modal is what stops the client -- and the toolkit inside it -- answering.
  const shown = dialogs.filter((dialog) => processes.some((process) => process.pid === dialog.pid))
  const dialogSection = shown.length
    ? [
        "",
        "Открытые окна-диалоги (текст прочитан с экрана):",
        "",
        shown.map(describeDialog).join("\n\n"),
        "",
        // debrief15.md §15.2: the user's call is that the agent closes such windows itself.
        "Окно поверх сеанса 1С блокирует его целиком, включая MCP Toolkit, если он в этом сеансе. Закрой " +
          "его сам: 1c_close_dialog с PID и названием кнопки — для окна, которое ничего не решает, «Закрыть». " +
          "Перезапуск процесса не поможет: окно, показанное при старте, появится снова; не меняй и настройки " +
          "базы, чтобы его скрыть. Пользователю передай только окно, которое закрытием не снять: нет прав, " +
          "нужен вход, или вопрос о данных («сохранить?», «удалить?»). Закрытое окно назови в отчёте.",
      ]
    : []
  const roles: Record<ProcessRole, string> = {
    toolkit: "MCP Toolkit (запущен приложением)",
    operation: "запущен приложением",
    user: "открыт пользователем",
  }
  return [
    "| PID | Кто | Режим | Что запущено | Окно | С |",
    "|---|---|---|---|---|---|",
    ...processes.map(
      (process) =>
        `| ${process.pid} | ${roles[roleOf(process, selfPid)]} | ${mode(process.commandLine)} | ${target(process.commandLine) || "—"} | ${process.windowTitle ?? "—"} | ${process.startedAt ?? "—"} |`,
    ),
    ...dialogSection,
    "",
    "Закрыть можно только процесс, запущенный приложением: 1c_processes с `close: <PID>`. Окна,",
    "открытые пользователем, не трогай — там может быть несохранённая работа; попроси закрыть их самого.",
  ].join("\n")
}

export type CloseOutcome =
  | { readonly ok: true; readonly role: ProcessRole }
  | { readonly ok: false; readonly reason: "not-found" | "not-ours"; readonly detail?: string }

/** Which process may be closed, decided before anything is killed. */
export function closable(processes: readonly PlatformProcess[], pid: number, selfPid: number): CloseOutcome {
  const found = processes.find((process) => process.pid === pid)
  if (!found) return { ok: false, reason: "not-found" }
  const role = roleOf(found, selfPid)
  if (role === "user") return { ok: false, reason: "not-ours", detail: found.windowTitle }
  return { ok: true, role }
}

// 1c_close_dialog. 2026-09-27, debrief15.md §15.2: a startup window
// («Интернет-поддержка пользователей») blocked the toolkit's 1C session at every
// start. The agent could read it but not close it, so it closed the whole
// process, restarted, met the window again, and at last set out to change the
// base's settings to suppress it. The user's call: the agent closes such windows
// itself. Pressing «Закрыть» was checked live on that window: UI Automation has
// no Invoke for it, WM_CLOSE closes it, and the toolkit answered again.

export type CloseDialogOutcome =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false
      readonly reason: "not-found" | "not-ours" | "no-button" | "failed" | "still-open"
      readonly detail?: string
    }

/**
 * Presses `button` in a dialog of `pid`, one of `processes` (the session's base),
 * and only in a process the app started: the user's own windows may hold
 * unsaved work. Then reads the process's windows again, so the answer says
 * whether the session is free.
 */
export async function closeDialog(
  processes: readonly PlatformProcess[],
  pid: number,
  button: string,
  deps: Pick<ProcessDeps, "selfPid" | "dialogs" | "press">,
  settleMs = 2_000,
): Promise<CloseDialogOutcome> {
  const verdict = closable(processes, pid, deps.selfPid)
  if (!verdict.ok) return verdict
  if (!deps.dialogs || !deps.press) return { ok: false, reason: "failed", detail: "окна прочитать нельзя" }
  const wanted = button.trim().toLowerCase()
  const shown = await deps.dialogs([pid])
  const dialog = shown.find((candidate) => candidate.buttons.some((name) => name.toLowerCase() === wanted))
  if (!dialog) {
    return {
      ok: false,
      reason: "no-button",
      detail: shown.length ? shown.map(describeDialog).join("\n\n") : "На этом процессе окон-диалогов нет.",
    }
  }
  const pressed = await deps.press(pid, button.trim())
  if (!pressed.pressed) return { ok: false, reason: "failed", detail: pressed.error }
  await new Promise((resolve) => setTimeout(resolve, settleMs))
  const left = (await deps.dialogs([pid])).filter((candidate) => candidate.buttons.length > 0)

  // 2026-10-13, debrief18.md §18.1: a security question that came back after
  // every press was reported «Нажата кнопка «Да»» 20+ times, with the same
  // window listed under «остались окна», and the agent kept pressing. The same
  // window after the press means the press did not answer it; the count says
  // when to stop.
  const key = `${pid}|${dialogSignature(dialog)}`
  const still = left.some((candidate) => dialogSignature(candidate) === dialogSignature(dialog))
  const repeats = still ? (seen.get(key) ?? 0) + 1 : 0
  if (still) seen.set(key, repeats)
  else seen.delete(key)
  if (still) {
    return {
      ok: false,
      reason: "still-open",
      detail: [
        `Кнопка «${button.trim()}» нажата, но окно осталось или появилось снова — нажатие на него не ответило:`,
        describeDialog(dialog),
        "",
        repeats >= 2
          ? "Это окно возвращается уже не в первый раз. Больше не нажимай: перескажи окно пользователю и попроси " +
            "ответить на него самому, а если оно спрашивает разрешение — выяснить, какая настройка его вызывает."
          : "Можно нажать ещё раз; если окно останется и тогда — перескажи его пользователю.",
      ].join("\n"),
    }
  }
  return {
    ok: true,
    text: [
      `Нажата кнопка «${button.trim()}» в окне:`,
      describeDialog(dialog),
      "",
      left.length
        ? `На процессе остались окна:\n${left.map(describeDialog).join("\n\n")}`
        : "Других окон на процессе нет — сеанс свободен.",
      "Назови это окно и нажатую кнопку в итоговом отчёте.",
    ].join("\n"),
  }
}

/** Presses of a window that stayed, per process and window, for this app run. */
const seen = new Map<string, number>()

function dialogSignature(dialog: PlatformDialog): string {
  return `${dialog.title}|${dialog.texts.join(" ")}`
}
