// Keeping the agent's artefacts out of the system temp directory.
//
// 2026-09-25, failures_to_tools.md T6 (debrief3.md §4.2, debrief10 "stale
// artefacts"). The profile prompt says everything the agent makes belongs in
// the working directory, and gives the reasons: the user will not find it in
// %TEMP%, cleanup erases it, and the next session re-does the work or -- worse
// -- reads a stale leftover from an earlier one as if it were current. The rule
// was stated and broken: a full configuration unpack landed in %TEMP%, a
// toolkit source unpack there went stale and was later read as the truth about
// a newer toolkit, and an extracted document was picked up by a later session
// instead of being extracted again.
//
// Deliberately narrow. Refusing everything outside the working directory would
// also refuse a location the user named, and a guard that blocks legitimate
// requests is a guard that gets routed around. The temp directory is the one
// location nobody asks for on purpose.

import { tmpdir } from "node:os"

function normalise(path: string): string {
  return path.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()
}

/** The directories that count as the system temp on this machine. */
export function tempDirectories(env: Readonly<Record<string, string | undefined>> = process.env): readonly string[] {
  return [tmpdir(), env.TEMP, env.TMP]
    .filter((dir): dir is string => typeof dir === "string" && dir.trim().length > 0)
    .map(normalise)
}

export function insideTemp(path: string, temps: readonly string[] = tempDirectories()): boolean {
  const target = normalise(path)
  return temps.some((temp) => target === temp || target.startsWith(`${temp}\\`))
}

// 2026-09-25, debrief13.md: the narrow rule above was not enough. With the
// working directory in hand from 1c_profile_info, a session still put an
// extension dump in a new folder beside the configuration dump and a .cf beside
// the infobase itself -- following where the existing dump lived. The `1c_*`
// operations write through the relay, so opencode's own external_directory
// prompt never sees them; only this plugin can hold the line. Scope: what an
// operation CREATES. Reading stays unrestricted -- an existing dump or a file
// the user names is read where it is.

/** Whether `path` is `directory` itself or anywhere below it. */
export function insideDirectory(path: string, directory: string): boolean {
  const target = normalise(path)
  const root = normalise(directory)
  return root.length > 0 && (target === root || target.startsWith(`${root}\\`))
}

/** Absolute on Windows or POSIX; a relative path is left to the caller's resolution. */
export function isAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path.trim()) || /^[\\/]/.test(path.trim())
}

const ARG = String.raw`("[^"]*"|'[^']*'|[^\s"']+)`
// `v8pack pack <dir> <out>` and `v8pack unpack <file> <dir>`: the second argument is written.
const V8PACK_WRITE = new RegExp(String.raw`v8pack(?:\.cmd|-cli\.mjs)?["']?\s+(?:pack|unpack)\s+${ARG}\s+${ARG}`, "i")

/**
 * What a `v8pack` shell command writes, or undefined. The shell is where the
 * patched container of debrief13.md landed beside the infobase: opencode's
 * own directory prompt sees only paths it can recognise in a command.
 */
export function v8packOutput(command: string): string | undefined {
  const match = V8PACK_WRITE.exec(command)
  return match?.[2]?.replace(/^["']|["']$/g, "")
}

/** The refusal for an operation that would create its result outside the working directory. */
export function outsideWorkingRefusal(path: string, workingDirectory: string): string {
  const leaf = path.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? ""
  return [
    `Отклонено: ${path} — вне рабочего каталога профиля (${workingDirectory}). Операция не выполнялась.`,
    "",
    "Всё, что ты создаёшь (выгрузки, .cf/.cfe, собранные и распакованные контейнеры), кладётся в",
    "рабочий каталог — там пользователь это найдёт, и следующий сеанс тоже. Рядом с базой или рядом с",
    "существующей выгрузкой — не место для новых файлов, даже если туда можно писать.",
    `Повтори с путём внутри рабочего каталога, например: ${workingDirectory}\\${leaf || "<имя>"}`,
    "",
    "Читать можно откуда угодно: существующую выгрузку или файл, названный пользователем, открывай",
    "там, где они лежат. Если пользователь сам просил положить результат в другое место — сделай",
    "его в рабочем каталоге и предложи скопировать.",
  ].join("\n")
}

// Shell writes into temp. 2026-09-27, debrief14.md §14.2/§14.4: the write
// tool's temp guard held, and every task5 run still put its intermediate files
// in %TEMP% from the shell -- the specification's text, an unpacked .docx,
// extracted XML. Reading from temp stays allowed; only a write whose TARGET is
// there is refused.

/** How a shell command names the temp directory, apart from its literal path. */
const TEMP_NAMES = [
  String.raw`\$env:(?:TEMP|TMP)\b`,
  String.raw`%(?:TEMP|TMP)%`,
  String.raw`\[(?:System\.)?IO\.Path\]::GetTempPath\(\)`,
  String.raw`\$env:LOCALAPPDATA[\\/]+Temp\b`,
  String.raw`\$TMPDIR\b`,
  String.raw`/tmp/`,
]

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * The target of a shell write that lands in temp, as written in the command,
 * or null. Heuristic, and built to miss rather than to refuse a read: it looks
 * for a write construct whose target is a temp reference.
 */
export function shellTempWrite(command: string, temps: readonly string[] = tempDirectories()): string | null {
  // Followed by a separator, a quote or the end: `…\Temporary` is not temp.
  const literal = temps.map(
    (temp) => escapeRegExp(temp).replace(/\\\\/g, String.raw`[\\/]+`) + String.raw`(?=[\\/"'\s;|)]|$)`,
  )
  const direct = [...TEMP_NAMES, ...literal].join("|")
  // A variable assigned a temp path is a temp reference wherever it is used.
  const variables = [...command.matchAll(new RegExp(String.raw`\$(\w+)\s*=\s*[^;\n]*?(?:${direct})`, "gi"))].map(
    (match) => String.raw`\$${match[1]}\b`,
  )
  const temp = `(?:${[direct, ...variables].join("|")})`
  const quote = String.raw`["']?`
  const writes = [
    // > file, >> file
    String.raw`(?<![-=<])>{1,2}\s*${quote}(${temp}[^"'\s;|]*)`,
    // cmdlets that write to their path
    String.raw`\b(?:Out-File|Set-Content|Add-Content|Export-Csv|Export-Clixml|Tee-Object|New-Item|mkdir)\b[^|;\n]*?(?:\s|-\w+\s+)${quote}(${temp}[^"'\s;|]*)`,
    // copy or move with a destination in temp: the second path, or -Destination
    String.raw`\b(?:Copy-Item|Move-Item|copy|cp|move|mv)\b\s+(?:-\w+\s+)*${quote}[^"'\s]+${quote}\s+(?:-Destination\s+)?${quote}(${temp}[^"'\s;|]*)`,
    String.raw`-Destination(?:Path)?\s+${quote}(${temp}[^"'\s;|]*)`,
    String.raw`-OutFile\s+${quote}(${temp}[^"'\s;|]*)`,
    // .NET: the path is the first argument of WriteAll*, the second of ExtractTo*
    String.raw`WriteAll(?:Text|Lines|Bytes)\s*\(\s*${quote}(${temp}[^"',)]*)`,
    String.raw`ExtractTo(?:File|Directory)\s*\([^,]+,\s*${quote}(${temp}[^"',)]*)`,
  ]
  for (const pattern of writes) {
    const match = new RegExp(pattern, "i").exec(command)
    if (match?.[1]) return match[1]
  }
  return null
}

/** The refusal for a shell command that writes into temp. */
export function shellTempRefusal(target: string): string {
  return [
    `Отклонено: команда пишет в системный временный каталог (${target}).`,
    "",
    "Промежуточные файлы (извлечённый текст, распакованные архивы, скрипты, копии для правки) клади в",
    "рабочий каталог профиля — его показывает 1c_profile_info; читать из временного каталога можно.",
    "Во временном каталоге пользователь результат не найдёт, очистка его сотрёт, а следующий сеанс",
    "либо сделает работу заново, либо прочитает старый остаток как актуальный.",
  ].join("\n")
}

/** The refusal for a file or directory the agent was about to create in temp. */
export function tempRefusal(path: string): string {
  return [
    `Отклонено: ${path} — это системный временный каталог.`,
    "",
    "Всё, что ты создаёшь для задачи (выгрузки, распакованные обработки, извлечённый текст,",
    "промежуточные файлы), клади в рабочий каталог профиля — его показывает 1c_profile_info.",
    "Во временном каталоге пользователь результат не найдёт, очистка его сотрёт, а следующий",
    "сеанс либо сделает работу заново, либо прочитает старый остаток как актуальный.",
  ].join("\n")
}
