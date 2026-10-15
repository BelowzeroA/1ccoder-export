// Moving the toolkit's 1C window out of the user's way.
//
// 2026-10-06, observed on SERVER_ST and reproduced locally. The 1C client that
// hosts the toolkit opens maximized and stays there for the whole session --
// the `windowsHide` the supervisor spawns with is ignored by the platform,
// which shows its own frame. The window IS the server, so it cannot be closed,
// and the two obvious ways of putting it away both break something:
//
// - minimized: the platform stops running the toolkit's handlers. `/health`
//   timed out for over a minute, then answered «Server is busy»; restoring the
//   window brought it back at once.
// - hidden (SW_HIDE): the server keeps answering, but `get_screenshot` fails
//   with «главное окно не найдено», and the agent checks forms and reports by
//   screenshot.
//
// A normal window placed past the right edge of the virtual screen keeps both:
// health, queries and screenshots all worked from there. Its taskbar button
// stays, so the user can still bring it back (Win+Shift+arrow, or maximize
// from the taskbar). Dialogs it raises are not lost with it -- the platform
// clamps them onto the visible screen. And the placement the platform saves on
// a graceful close is clamped back on-screen at the next launch: only the
// un-maximized size survives.
//
// Only the main frame is moved: an unowned, titled V8Window of the process (or
// a 1cv8* child of it), shown if the platform kept it hidden. Owned windows
// follow it or are clamped by the platform; notification popups are untitled.

import { execFile } from "node:child_process"

import { windowsPrelude } from "./dialogs"

/** How far past the right edge of the virtual screen the frame goes. */
const PARK_MARGIN_PX = 50

export function parkScript(pids: readonly number[]): string {
  return [
    ...windowsPrelude(pids),
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -TypeDefinition @'",
    "using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;",
    "public static class OneCPark {",
    "  public delegate bool EnumProc(IntPtr h, IntPtr l);",
    '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);',
    '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
    '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
    // Hidden ones too: started with the hide flag, the platform keeps the frame
    // hidden whenever its saved placement is not maximized.
    "  public static List<long[]> Frames(HashSet<uint> pids) {",
    "    var found = new List<long[]>();",
    "    EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid);",
    "      var c = new StringBuilder(64); GetClassName(h, c, 64);",
    '      if (pids.Contains(pid) && c.ToString().StartsWith("V8Window")) found.Add(new long[] { h.ToInt64(), pid }); return true; }, IntPtr.Zero);',
    "    return found;",
    "  }",
    "}",
    "'@",
    "$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen",
    "$parked = @(foreach ($w in [OneCPark]::Frames($set)) {",
    "  $h = [IntPtr]$w[0]",
    "  if ([OneCWindows]::GetWindow($h, 4) -ne [IntPtr]::Zero) { continue }",
    "  $title = [OneCWindows]::Title($h); if (-not $title) { continue }",
    "  $r = New-Object OneCWindows+RECT; [void][OneCWindows]::GetWindowRect($h, [ref]$r)",
    "  if (($r.R - $r.L) -lt 80 -or ($r.B - $r.T) -lt 40) { continue }",
    // A maximized window snaps back to its monitor; a minimized one stops the
    // toolkit. SW_SHOWNOACTIVATE restores either without taking the focus.
    "  if ([OneCPark]::IsZoomed($h) -or [OneCPark]::IsIconic($h)) { [void][OneCPark]::ShowWindow($h, 4) }",
    // SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
    `  [void][OneCPark]::SetWindowPos($h, [IntPtr]::Zero, $screen.Right + ${PARK_MARGIN_PX}, $screen.Top, 0, 0, 0x15)`,
    // A hidden frame is shown only now, already off-screen. Hidden, the
    // toolkit's screenshot finds no main window -- or captures a notification
    // popup in its place.
    "  if (-not [OneCPark]::IsWindowVisible($h)) { [void][OneCPark]::ShowWindow($h, 4) }",
    "  [pscustomobject]@{ pid = $w[1]; title = $title }",
    "})",
    "ConvertTo-Json -Compress -InputObject $parked",
  ].join("\n")
}

/** Moves the main frame of these 1C processes off-screen; the titles of the windows moved. */
export type WindowPark = (pids: readonly number[]) => Promise<readonly string[]>

/** Runs the move; an empty list on any failure -- a window left in view is a nuisance, not an error. */
export const nodeWindowPark: WindowPark = (pids) =>
  new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(parkScript(pids), "utf16le").toString("base64")],
      { windowsHide: true, timeout: 20_000, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve(error ? [] : parseParked(stdout)),
    )
  })

export function parseParked(json: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(json.trim())
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows
      .map((row) => (row && typeof row === "object" ? (row as { title?: unknown }).title : undefined))
      .filter((title): title is string => typeof title === "string")
  } catch {
    return []
  }
}
