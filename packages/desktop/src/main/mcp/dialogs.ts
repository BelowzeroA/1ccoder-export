// What a 1C dialog says, read from outside the platform.
//
// 2026-09-27, tasks/task8. A toolkit launch on a base whose user lacked the
// right to open external processings sat for the whole start timeout: the 1C
// window was up, `/health` never answered, and the supervisor could only report
// "timeout". The reason was on screen the entire time -- a modal «Текущему
// пользователю запрещен запуск внешних обработок» -- and it took the observer
// EnumWindows + UI Automation by hand to read it. The main window's title
// looked perfectly normal, so `processes.ts`, which only knows
// MainWindowTitle, could not have told either.
//
// The same blindness hits every modal that blocks the client: an .epf's own
// form, the platform's file error for a missing /Execute target, a БСП startup
// question. The toolkit's own screenshot tool cannot help -- it runs inside the
// session the dialog is blocking.
//
// Read-only: nothing here clicks, closes or focuses anything. Windows refuses
// foreground changes from background processes anyway, and answering a dialog
// is the user's decision.

import { execFile } from "node:child_process"

export interface PlatformDialog {
  readonly pid: number
  readonly title: string
  /** The window's static and edit texts, in tree order, deduplicated. */
  readonly texts: readonly string[]
  readonly buttons: readonly string[]
  /**
   * Whether the window it belongs to is disabled -- the platform's modal
   * state. A modal owned window blocks the whole client session, and with it
   * the MCP Toolkit living inside that session.
   */
  readonly modal: boolean
}

/**
 * The probe, for the given process ids and every 1cv8* process descended from
 * them (the launcher may hand over to a child). No ids: every 1cv8* process.
 *
 * Only visible OWNED windows of real size are read: a 1C dialog is owned by the
 * main frame, while the frame itself (a huge UI Automation tree) and the 10-px
 * shadow windows around every 1C window are not dialogs.
 */
export function dialogScript(pids: readonly number[]): string {
  return [
    ...windowsPrelude(pids),
    "$UIA = [System.Windows.Automation.ControlType]",
    "$result = foreach ($w in [OneCWindows]::Visible($set)) {",
    "  $h = [IntPtr]$w[0]; $r = New-Object OneCWindows+RECT; [void][OneCWindows]::GetWindowRect($h, [ref]$r)",
    "  if (($r.R - $r.L) -lt 80 -or ($r.B - $r.T) -lt 40) { continue }",
    "  $owner = [OneCWindows]::GetWindow($h, 4)",
    "  if ($owner -eq [IntPtr]::Zero) { continue }",
    "  $texts = New-Object System.Collections.Generic.List[string]",
    "  $buttons = New-Object System.Collections.Generic.List[string]",
    "  try {",
    "    $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)",
    "    foreach ($x in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {",
    '      $name = "$($x.Current.Name)".Trim(); if (-not $name) { continue }',
    "      $type = $x.Current.ControlType",
    "      if ($type -eq $UIA::Button) { if (-not $buttons.Contains($name)) { $buttons.Add($name) } }",
    "      elseif ($type -eq $UIA::Text -or $type -eq $UIA::Edit -or $type -eq $UIA::Document) {",
    "        if (-not $texts.Contains($name) -and $texts.Count -lt 20) { $texts.Add($name) } }",
    "    }",
    "  } catch {}",
    "  [pscustomobject]@{ pid = $w[1]; title = [OneCWindows]::Title($h); ownerEnabled = [OneCWindows]::IsWindowEnabled($owner);",
    "    texts = @($texts); buttons = @($buttons) }",
    "}",
    "@($result) | ConvertTo-Json -Compress -Depth 4",
  ].join("\n")
}

/**
 * Presses one button, by its name, in a dialog of the given process (or a 1cv8*
 * child of it). UI Automation's Invoke when the button offers it -- no mouse,
 * no focus, so it works on a window in the background. For «Закрыть» / «Close»
 * without Invoke, the dialog window is sent WM_CLOSE, which is what its own
 * close button does. Nothing else is ever sent.
 *
 * Prints {pressed, how, title, error} as JSON.
 */
export function pressScript(pid: number, button: string): string {
  const name = button.replace(/'/g, "''")
  return [
    ...windowsPrelude([pid]),
    `$Button = '${name}'`,
    '$code = @"',
    "using System; using System.Runtime.InteropServices;",
    'public static class OneCPost { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }',
    '"@',
    "Add-Type -TypeDefinition $code",
    "$UIA = [System.Windows.Automation.ControlType]",
    "$out = [pscustomobject]@{ pressed = $false; how = ''; title = ''; error = 'кнопка не найдена' }",
    "foreach ($w in [OneCWindows]::Visible($set)) {",
    "  $h = [IntPtr]$w[0]; $r = New-Object OneCWindows+RECT; [void][OneCWindows]::GetWindowRect($h, [ref]$r)",
    "  if (($r.R - $r.L) -lt 80 -or ($r.B - $r.T) -lt 40) { continue }",
    "  if ([OneCWindows]::GetWindow($h, 4) -eq [IntPtr]::Zero) { continue }",
    "  try { $root = [System.Windows.Automation.AutomationElement]::FromHandle($h) } catch { continue }",
    "  $found = $null",
    "  foreach ($x in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {",
    '    if ($x.Current.ControlType -eq $UIA::Button -and "$($x.Current.Name)".Trim() -ieq $Button) { $found = $x; break }',
    "  }",
    "  if (-not $found) { continue }",
    "  $out.title = [OneCWindows]::Title($h)",
    "  try {",
    "    $pattern = $found.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)",
    "    $pattern.Invoke(); $out.pressed = $true; $out.how = 'invoke'; $out.error = ''",
    "  } catch {",
    "    if ($Button -ieq 'Закрыть' -or $Button -ieq 'Close') {",
    "      [void][OneCPost]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); $out.pressed = $true; $out.how = 'wm_close'; $out.error = ''",
    "    } else { $out.error = \"$($_.Exception.Message)\" }",
    "  }",
    "  break",
    "}",
    "$out | ConvertTo-Json -Compress",
  ].join("\n")
}

/** The window enumeration both scripts share: the process ids, their 1cv8* children, and a way to list their windows. */
export function windowsPrelude(pids: readonly number[]): string[] {
  const ids = pids.filter((pid) => Number.isInteger(pid) && pid > 0).join(",")
  return [
    `$Pids = '${ids}'`,
    "$OutputEncoding = New-Object System.Text.UTF8Encoding $false",
    "try { [Console]::OutputEncoding = $OutputEncoding } catch {}",
    "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes",
    "Add-Type -TypeDefinition @'",
    "using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;",
    "public static class OneCWindows {",
    "  public delegate bool EnumProc(IntPtr h, IntPtr l);",
    '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);',
    '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
    "  public struct RECT { public int L, T, R, B; }",
    "  public static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }",
    "  public static List<long[]> Visible(HashSet<uint> pids) {",
    "    var found = new List<long[]>();",
    "    EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid);",
    "      if (pids.Contains(pid) && IsWindowVisible(h)) found.Add(new long[] { h.ToInt64(), pid }); return true; }, IntPtr.Zero);",
    "    return found;",
    "  }",
    "}",
    "'@",
    `$all = @(Get-CimInstance Win32_Process -Filter "Name like '1cv8%'")`,
    "$set = New-Object 'System.Collections.Generic.HashSet[uint32]'",
    "$roots = @($Pids -split ',' | Where-Object { $_ })",
    "if ($roots.Count) { $roots | ForEach-Object { [void]$set.Add([uint32]$_) } } else { $all | ForEach-Object { [void]$set.Add([uint32]$_.ProcessId) } }",
    "do { $grew = $false; foreach ($p in $all) { if ($set.Contains([uint32]$p.ParentProcessId) -and $set.Add([uint32]$p.ProcessId)) { $grew = $true } } } while ($grew)",
  ]
}

export type DialogProbe = (pids: readonly number[]) => Promise<readonly PlatformDialog[]>

/** Runs the probe; an empty list on any failure -- this is a diagnosis, never a reason to fail. */
export const nodeDialogProbe: DialogProbe = (pids) =>
  new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(dialogScript(pids), "utf16le").toString("base64")],
      { windowsHide: true, timeout: 20_000, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve(error ? [] : parseDialogs(stdout)),
    )
  })

export interface PressResult {
  readonly pressed: boolean
  /** "invoke" (UI Automation) or "wm_close" (the window's own close). */
  readonly how: string
  readonly title: string
  readonly error: string
}

export type DialogPress = (pid: number, button: string) => Promise<PressResult>

/** Runs the press; a failure comes back as `pressed: false` with the reason. */
export const nodeDialogPress: DialogPress = (pid, button) =>
  new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(pressScript(pid, button), "utf16le").toString("base64")],
      { windowsHide: true, timeout: 20_000, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve(error ? { pressed: false, how: "", title: "", error: String(error.message) } : parsePress(stdout)),
    )
  })

export function parsePress(json: string): PressResult {
  try {
    const row = JSON.parse(json.trim()) as Record<string, unknown>
    return {
      pressed: row.pressed === true,
      how: typeof row.how === "string" ? row.how : "",
      title: typeof row.title === "string" ? row.title : "",
      error: typeof row.error === "string" ? row.error : "",
    }
  } catch {
    return { pressed: false, how: "", title: "", error: `ответ не распознан: ${json.slice(0, 200)}` }
  }
}

/** Window texts are capped: a dialog that carries a whole report is still one dialog. */
const TEXT_LIMIT = 1_500

export function parseDialogs(json: string): readonly PlatformDialog[] {
  const trimmed = json.trim()
  if (!trimmed) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const strings = (value: unknown): string[] =>
    (Array.isArray(value) ? value : typeof value === "string" ? [value] : [])
      .filter((item): item is string => typeof item === "string" && item.trim() !== "")
      .map((item) => (item.length > TEXT_LIMIT ? `${item.slice(0, TEXT_LIMIT)}…` : item))
  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .map((row) => ({
      pid: Number(row.pid),
      title: typeof row.title === "string" ? row.title : "",
      texts: strings(row.texts),
      buttons: strings(row.buttons),
      modal: row.ownerEnabled === false,
    }))
    .filter((dialog) => Number.isFinite(dialog.pid) && (dialog.texts.length > 0 || dialog.buttons.length > 0))
}

/**
 * A dialog that is holding the session: modal, and asking for an answer. The
 * splash screen and the platform's non-modal popups are neither.
 */
export function isBlocking(dialog: PlatformDialog): boolean {
  return dialog.modal && dialog.buttons.length > 0
}

/** One dialog as the agent and the log see it: the message itself, then the buttons. */
export function describeDialog(dialog: PlatformDialog): string {
  const head = `Окно «${dialog.title || "без заголовка"}» (PID ${dialog.pid})${dialog.modal ? ", модальное" : ""}:`
  const body = dialog.texts.map((text) => text.replace(/\s*\n\s*/g, " ").trim()).join(" / ")
  const buttons = dialog.buttons.length ? `\nКнопки: ${dialog.buttons.join(", ")}` : ""
  return `${head}\n${body || "(текста нет)"}${buttons}`
}

export function describeDialogs(dialogs: readonly PlatformDialog[]): string {
  return dialogs.map(describeDialog).join("\n\n")
}
