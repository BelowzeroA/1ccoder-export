// The infobase user's «Защита от опасных действий», switched off before the toolkit opens.
//
// 2026-10-13, debrief18.md. With the flag on, the platform asks «Разрешить
// открывать данный файл?» every time an external processing opens from a file:
// the toolkit itself, and every .epf the agent builds and checks. A new toolkit
// session follows every configurator run, so the question came back on every
// iteration. 1c_close_dialog could not answer it, the user clicked it by hand 5
// times, and it cost the session about 1 h 25 min.
//
// It has to happen before the toolkit starts, and without a client window: the
// toolkit opening is itself the first question. An external (COM) connection
// has no UI, so it raises no dialog. Two things make that work on a stock machine:
// - The 1C installer registers the connector class but, at least on 8.3.27 and
//   8.5.1, not its type library. Every call then fails with
//   TYPE_E_LIBNOTREGISTERED, from PowerShell and from cscript alike. The type
//   library is embedded in comcntr.dll and can be registered per user
//   (RegisterTypeLibForUser), with no elevation.
// - PowerShell's property adapter returns null on the objects 1C hands back, so
//   every member is reached through IDispatch (InvokeMember).
// The user is looked up with FindByName: CurrentUser() returns the session's
// copy, which still read the old value after a successful Write.
//
// Checked on a scratch base with 8.5.1.1529 (on→on, off→off). About 12-16 s per call,
// almost all of it in Connect, so the supervisor runs it once per profile.

import { execFile } from "node:child_process"
import { dirname, join } from "node:path"

export type ProtectionState =
  /** Already off; nothing was changed. */
  | "off"
  /** It was on and this call switched it off. */
  | "turned-off"
  /** The base has no users, so there is no flag to read. */
  | "no-users"
  /** The profile's user isn't in the base's user list. */
  | "no-user"
  /** On, and the profile's user lacks the Administration right to change it. */
  | "no-rights"
  /** The COM connector isn't registered, or the connection failed. */
  | "error"

export interface ProtectionOutcome {
  readonly state: ProtectionState
  readonly detail?: string
}

/** Whether the toolkit can be expected to open without the platform's question. */
export function protectionCleared(outcome: ProtectionOutcome): boolean {
  return outcome.state === "off" || outcome.state === "turned-off" || outcome.state === "no-users"
}

export type ProtectionCheck = (input: {
  readonly profile: {
    readonly kind: "file" | "server"
    readonly filePath?: string
    readonly serverCluster?: string
    readonly serverDatabase?: string
    readonly userName: string
    readonly platformPath: string
  }
  readonly password: string
}) => Promise<ProtectionOutcome>

/**
 * The connector's ProgID for the platform the profile runs. The class is
 * registered machine-wide per major version, so the build may differ from the
 * profile's; for a file base of the same major that does not matter.
 */
export function connectorProgId(platformPath: string): string {
  return /[\\/]8\.5\./.test(platformPath) ? "V85.COMConnector" : "V83.COMConnector"
}

/** The connection string the COM connector takes (not the command line's /F or /S). */
export function comConnectionString(input: Parameters<ProtectionCheck>[0]): string {
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
  const target =
    input.profile.kind === "file"
      ? `File=${quote(input.profile.filePath ?? "")}`
      : `Srvr=${quote(input.profile.serverCluster ?? "")};Ref=${quote(input.profile.serverDatabase ?? "")}`
  return `${target};Usr=${quote(input.profile.userName)};Pwd=${quote(input.password)}`
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`

/**
 * Registers the connector's type library for the current user when the
 * connector class names one that isn't registered. A separate process from the
 * connection on purpose: with the library loaded in the same process
 * (LoadTypeLibEx), the Connect that follows fails with TYPE_E_LIBNOTREGISTERED
 * even though the registration succeeded. Checked on 8.5.1.1529.
 */
export function typeLibScript(platformPath: string): string {
  return [
    `$progId = ${literal(connectorProgId(platformPath))}`,
    `$dll = ${literal(join(dirname(platformPath), "comcntr.dll"))}`,
    "try {",
    "  $clsid = (Get-ItemProperty -LiteralPath \"Registry::HKEY_CLASSES_ROOT\\$progId\\CLSID\").'(default)'",
    "  $typeLib = (Get-ItemProperty -LiteralPath \"Registry::HKEY_CLASSES_ROOT\\CLSID\\$clsid\\TypeLib\").'(default)'",
    "  if (Test-Path -LiteralPath \"Registry::HKEY_CLASSES_ROOT\\TypeLib\\$typeLib\") { exit 0 }",
    "} catch { exit 0 }",
    "if (-not (Test-Path -LiteralPath $dll)) { exit 0 }",
    "Add-Type -Namespace OneCCoder -Name TypeLib -MemberDefinition @'",
    '[DllImport("oleaut32.dll", CharSet = CharSet.Unicode)] public static extern int LoadTypeLibEx(string file, int kind, out IntPtr lib);',
    '[DllImport("oleaut32.dll", CharSet = CharSet.Unicode)] public static extern int RegisterTypeLibForUser(IntPtr lib, string path, string help);',
    "'@",
    "$lib = [IntPtr]::Zero",
    "if ([OneCCoder.TypeLib]::LoadTypeLibEx($dll, 2, [ref]$lib) -eq 0) { [void][OneCCoder.TypeLib]::RegisterTypeLibForUser($lib, $dll, $null) }",
  ].join("\n")
}

export function protectionScript(input: Parameters<ProtectionCheck>[0]): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$OutputEncoding = New-Object System.Text.UTF8Encoding $false",
    "try { [Console]::OutputEncoding = $OutputEncoding } catch {}",
    "function Done($state, $detail) { [pscustomobject]@{ state = $state; detail = \"$detail\" } | ConvertTo-Json -Compress; exit 0 }",
    "function Call($o, $m, $a = @()) { [System.__ComObject].InvokeMember($m, [Reflection.BindingFlags]::InvokeMethod, $null, $o, $a) }",
    "function Get($o, $p) { [System.__ComObject].InvokeMember($p, [Reflection.BindingFlags]::GetProperty, $null, $o, $null) }",
    "function Put($o, $p, $v) { [void][System.__ComObject].InvokeMember($p, [Reflection.BindingFlags]::SetProperty, $null, $o, @($v)) }",
    "try {",
    `  $connector = New-Object -ComObject ${literal(connectorProgId(input.profile.platformPath))}`,
    `  $ib = Call $connector 'Connect' @(${literal(comConnectionString(input))})`,
    "} catch { Done 'error' $(if ($_.Exception.InnerException) { $_.Exception.InnerException.Message } else { $_.Exception.Message }) }",
    "try {",
    "  $users = Get $ib 'InfoBaseUsers'",
    // The array arrives as a .NET Object[], not a 1C Массив.
  "  if (@(Call $users 'GetUsers').Count -eq 0) { Done 'no-users' '' }",
    `  $name = ${literal(input.profile.userName)}`,
    "  $user = Call $users 'FindByName' @($name)",
    "  if ($null -eq $user) { Done 'no-user' $name }",
    "  if (-not (Get (Get $user 'UnsafeOperationProtection') 'UnsafeOperationWarnings')) { Done 'off' '' }",
    "  if (-not (Call $ib 'AccessRight' @('Administration', (Get $ib 'Metadata')))) { Done 'no-rights' $name }",
    "  $off = Call $ib 'NewObject' @('UnsafeOperationProtectionDescription')",
    "  Put $off 'UnsafeOperationWarnings' $false",
    "  Put $user 'UnsafeOperationProtection' $off",
    "  [void](Call $user 'Write')",
    "  $again = Call $users 'FindByName' @($name)",
    "  if (Get (Get $again 'UnsafeOperationProtection') 'UnsafeOperationWarnings') { Done 'error' 'записано, но флажок остался' }",
    "  Done 'turned-off' $name",
    "} catch { Done 'error' $(if ($_.Exception.InnerException) { $_.Exception.InnerException.Message } else { $_.Exception.Message }) }",
  ].join("\n")
}

export function parseProtection(stdout: string): ProtectionOutcome {
  const line = stdout.trim().split(/\r?\n/).pop() ?? ""
  try {
    const parsed = JSON.parse(line) as { state?: unknown; detail?: unknown }
    const states: readonly ProtectionState[] = ["off", "turned-off", "no-users", "no-user", "no-rights", "error"]
    const state = states.find((candidate) => candidate === parsed.state)
    if (!state) return { state: "error", detail: line }
    return typeof parsed.detail === "string" && parsed.detail ? { state, detail: parsed.detail } : { state }
  } catch {
    return { state: "error", detail: line || "нет ответа" }
  }
}

/**
 * What to tell the agent, next to the platform's question, when the flag could
 * not be cleared. The user has to untick it once; after that the question
 * doesn't come back for this base.
 */
export function describeProtection(outcome: ProtectionOutcome, userName: string): string | undefined {
  const state = outcome.state
  if (state === "off" || state === "turned-off" || state === "no-users") return undefined
  const where =
    `в 1С откройте карточку пользователя «${userName}» (Конфигуратор → Администрирование → Пользователи, ` +
    "или в программе: Администрирование → Настройки пользователей и прав → Пользователи) и снимите флажок " +
    "«Защита от опасных действий»"
  const why: Record<typeof state, string> = {
    "no-user": `пользователь «${userName}» не найден в списке пользователей базы`,
    "no-rights": `у пользователя «${userName}» нет права «Администрирование», чтобы снять его самому`,
    error: `не удалось подключиться к базе без окна${outcome.detail ? ` (${outcome.detail})` : ""}`,
  }
  return (
    `У пользователя базы включена «Защита от опасных действий» — из-за неё 1С спрашивает «Разрешить открывать ` +
    `данный файл?» при каждом открытии обработки. Снять её приложение не смогло: ${why[state]}. ` +
    `Попроси пользователя один раз: ${where}. После этого вопрос не появится.`
  )
}

const powershell = (script: string, timeout: number) =>
  new Promise<{ readonly stdout: string; readonly error?: string }>((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, timeout, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve({ stdout, error: error?.message }),
    )
  })

export const nodeProtectionCheck: ProtectionCheck = async (input) => {
  await powershell(typeLibScript(input.profile.platformPath), 30_000)
  const result = await powershell(protectionScript(input), 90_000)
  if (result.stdout.trim()) return parseProtection(result.stdout)
  return { state: "error", detail: result.error ?? "нет ответа" }
}
