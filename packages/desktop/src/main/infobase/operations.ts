// The 1C operations the agent may ask for, and which of them write.
//
// The read/write split is the whole point of this file. Phase 5 decided that
// writes to a bound infobase stay ask-first even in AutoMode, on the grounds
// that for many users an infobase is live business data and an unwanted write
// there is far harder to undo than a bad file edit. That decision is only worth
// anything if "is this a write?" is answered in one place, declaratively, where
// it can be read and tested -- rather than being remembered at each call site.
//
// Reads are still gated by the ordinary permission system; they simply do not
// assert `infobase_write`.

export type OperationId =
  | "check"
  | "dump_config"
  | "dump_config_to_files"
  | "dump_epf_to_files"
  | "load_epf_from_files"
  | "load_config"
  | "load_config_from_files"
  | "update_db"
  | "delete_extension"
  | "execute"

export interface OperationDefinition {
  readonly id: OperationId
  /** ENTERPRISE runs code in the base; DESIGNER is the configurator. */
  readonly mode: "DESIGNER" | "ENTERPRISE"
  /** True when this changes the infobase, as opposed to reading from it. */
  readonly writes: boolean
  readonly summary: string
  /** Builds the platform arguments after the connection and credentials. */
  readonly args: (input: {
    path?: string
    secondPath?: string
    update?: boolean
    extension?: string
    listFile?: string
  }) => string[]
  /**
   * How long this operation may run, when the default is wrong for it.
   *
   * Per operation rather than one global value: a full configuration unpack has
   * been measured at 17.5 minutes against the 10-minute default, and raising the
   * default instead would make a wrong password on `/CheckConfig` hang for as
   * long as the slowest dump. debrief3.md §9.1.
   */
  readonly timeoutMs?: number
}

/**
 * `-Extension <Имя>`, which scopes a configurator command to one extension.
 *
 * 2026-09-25. Added because its absence made a guarded tool unable to do the job
 * and the shell refusal sent the agent to it anyway. The session had composed the
 * right command by itself --
 *
 *   DESIGNER /DumpConfigToFiles <dir> -Extension EF_00_00927613_4
 *
 * -- was refused by the shell guard, pointed at `1c_dump_config_to_files`, which
 * could only dump the MAIN configuration, and fell back to dumping all 97 000
 * files of it "to see what appears": ~18 minutes and 6.6 GB for an answer that
 * provably is not there, because an extension's modules are not part of the
 * configuration dump. `failures_to_tools.md` G1 anticipated exactly this and
 * asked for it not to happen: a guard must not block work that has no
 * alternative.
 *
 * Unquoted, like the verified command line: an extension name is an identifier,
 * so it has no spaces, and the modifier follows its command.
 */
function extensionArg(extension: string | undefined): readonly string[] {
  const name = extension?.trim()
  return name ? ["-Extension", name] : []
}

export const OPERATIONS: Readonly<Record<OperationId, OperationDefinition>> = {
  check: {
    id: "check",
    mode: "DESIGNER",
    writes: false,
    summary: "Проверка конфигурации",
    args: () => ["/CheckConfig", "-ConfigLogIntegrity"],
  },
  dump_config: {
    id: "dump_config",
    mode: "DESIGNER",
    writes: false,
    summary: "Выгрузка конфигурации в файл",
    args: ({ path, extension }) => ["/DumpCfg", `"${path ?? ""}"`, ...extensionArg(extension)],
    // Measured at 912 seconds on a large configuration.
    timeoutMs: 20 * 60 * 1000,
  },
  // 2026-09-21, debrief6.md §8.1. `dump_config` produces a .cf, which is a
  // sealed container: it cannot be read, searched or diffed. Every session that
  // has ever asked for it wanted the XML instead -- 09-15, 09-19 and 09-21 all
  // reached for /DumpCfg, discovered the .cf was useless to them, and then drove
  // the configurator by hand through `bash` to get /DumpConfigToFiles. That
  // hand-rolled route is outside `needsExclusiveInfobase`, so it takes none of
  // the toolkit precautions that exist because a DESIGNER run against a base the
  // toolkit held once truncated `RuntimeCacheStorage`. On 09-21 it was safe only
  // by accident: `dump_config` had already closed the toolkit.
  //
  // The XML dump is also what broke that session's three-hour loop -- it is the
  // only way to read a макет's real structure -- and it is the input format the
  // whole cc-1c-skills catalogue expects. Offering only the unreadable form was
  // the gap; this closes it.
  dump_config_to_files: {
    id: "dump_config_to_files",
    mode: "DESIGNER",
    writes: false,
    summary: "Выгрузка конфигурации в файлы (XML)",
    // `-update` writes only what differs from the ConfigDumpInfo.xml already in
    // the directory, and falls back to a full dump by itself when the versions
    // do not match -- so it is safe whenever a previous dump is there.
    // `-listFile` dumps only the objects named in it, one per line. 2026-09-27,
    // checked on a scratch base: `Configuration` alone gives the root files in
    // seconds (no Languages/, no ConfigDumpInfo.xml); a name that doesn't exist
    // fails the whole run; a second listed dump into the same folder adds to it.
    args: ({ path, update, extension, listFile }) => [
      "/DumpConfigToFiles",
      `"${path ?? ""}"`,
      ...extensionArg(extension),
      ...(update ? ["-update"] : []),
      ...(listFile ? ["-listFile", `"${listFile}"`] : []),
    ],
    // A full unpack measured 17 m 33 s (debrief3.md §9.1); room above that.
    timeoutMs: 45 * 60 * 1000,
  },
  // 2026-09-23, debrief7.md §8.7 / D12. Editing a form's LAYOUT -- adding a
  // command, a button, renaming the processing -- cannot be done with v8pack,
  // which rewrites module strings and copies everything else byte for byte. The
  // only route is the configurator's XML round-trip, and it had no guarded
  // operation, so the agent drove `1cv8.exe DESIGNER` through `bash`. One such
  // launch killed a toolkit the user had started by hand, because a hand-rolled
  // call takes none of `needsExclusiveInfobase()`'s precautions.
  //
  // Same class of gap as C2: the guarded path existed for reading a
  // CONFIGURATION and not for an external processing.
  //
  // Two conventions that cost ~70 minutes to establish and are easy to get
  // wrong, so they are encoded here rather than left to the caller:
  //   dump writes, INSIDE the `path` given, the root descriptor
  //   `<ИмяОбработки>.xml` beside the folder `<ИмяОбработки>/` (debrief15.md
  //   §15.5: "beside `<dir>`" was read as beside `path` itself);
  //   load takes the XML root FIRST and updates an EXISTING container, so the
  //   target .epf must already be a valid one (an empty stub fails).
  dump_epf_to_files: {
    id: "dump_epf_to_files",
    mode: "DESIGNER",
    writes: false,
    summary: "Выгрузка внешней обработки в файлы (XML)",
    args: ({ path, secondPath }) => [
      "/DumpExternalDataProcessorOrReportToFiles",
      `"${path ?? ""}"`,
      `"${secondPath ?? ""}"`,
    ],
  },
  load_epf_from_files: {
    id: "load_epf_from_files",
    mode: "DESIGNER",
    writes: false,
    summary: "Сборка внешней обработки из файлов (XML)",
    args: ({ path, secondPath }) => [
      "/LoadExternalDataProcessorOrReportFromFiles",
      `"${path ?? ""}"`,
      `"${secondPath ?? ""}"`,
    ],
  },
  load_config: {
    id: "load_config",
    mode: "DESIGNER",
    writes: true,
    summary: "Загрузка конфигурации из файла",
    args: ({ path, extension }) => ["/LoadCfg", `"${path ?? ""}"`, ...extensionArg(extension)],
    // The inverse of /DumpCfg, so at least as slow.
    timeoutMs: 20 * 60 * 1000,
  },
  // 2026-09-26, debrief14.md §14.3. The route for building an extension from
  // XML. Without it the only door left was forging a container by hand, and an
  // agent spent its session reverse-engineering a 1.5 GB .cf. Verified on a
  // scratch base: it creates a missing extension, a reload replaces it
  // (deletions included), and errors name the file and node.
  load_config_from_files: {
    id: "load_config_from_files",
    mode: "DESIGNER",
    writes: true,
    summary: "Загрузка расширения из файлов XML",
    args: ({ path, extension }) => ["/LoadConfigFromFiles", `"${path ?? ""}"`, ...extensionArg(extension)],
    timeoutMs: 20 * 60 * 1000,
  },
  // The way back after a load that failed: a failed /LoadConfigFromFiles
  // still leaves an empty extension of that name behind (verified).
  delete_extension: {
    id: "delete_extension",
    mode: "DESIGNER",
    writes: true,
    summary: "Удаление расширения из базы",
    args: ({ extension }) => ["/DeleteCfg", ...extensionArg(extension)],
    timeoutMs: 20 * 60 * 1000,
  },
  update_db: {
    id: "update_db",
    mode: "DESIGNER",
    writes: true,
    summary: "Обновление конфигурации базы данных",
    args: ({ extension }) => ["/UpdateDBCfg", ...extensionArg(extension)],
    // Restructuring a large base's tables can take far longer than any read,
    // and killing it midway is worse than waiting.
    timeoutMs: 45 * 60 * 1000,
  },
  execute: {
    id: "execute",
    mode: "ENTERPRISE",
    writes: true,
    summary: "Выполнение внешней обработки в базе",
    args: ({ path }) => ["/Execute", `"${path ?? ""}"`],
  },
}

export function isOperationId(value: string): value is OperationId {
  return Object.hasOwn(OPERATIONS, value)
}

/**
 * How long the platform may run before it is killed, unless the operation
 * declares its own `timeoutMs`.
 */
export const OPERATION_TIMEOUT_MS = 10 * 60 * 1000

export function operationTimeout(id: OperationId): number {
  return OPERATIONS[id].timeoutMs ?? OPERATION_TIMEOUT_MS
}

/**
 * How long the plugin waits for the relay -- deliberately LONGER than the
 * process timeout, and the ordering is the whole point.
 *
 * 2026-09-20, debrief4.md §3.2. The plugin's fetch had no timeout at all, so
 * it inherited undici's 300-second headersTimeout while the process was
 * allowed 600. Every operation that ran longer than five minutes therefore
 * produced `fetch failed` -- a transport error that says nothing about the
 * operation -- while 1cv8.exe kept running, its temp directory was never
 * cleaned up (the executor's `finally` had not been reached), and the agent,
 * seeing only a failure, retried and spawned another one. That is how a single
 * bad call became three live 1C processes.
 *
 * With the transport deadline outliving the process deadline, the executor's
 * own answer always wins the race: the agent gets `timed-out` plus the
 * platform log, which is actionable, instead of `fetch failed`, which is not.
 */
export const EXEC_REQUEST_TIMEOUT_MS =
  Math.max(...Object.values(OPERATIONS).map((operation) => operation.timeoutMs ?? OPERATION_TIMEOUT_MS)) + 60 * 1000

/**
 * What a path argument has to be, per operation, so that a bad one is refused
 * before the platform is launched.
 *
 * 2026-09-20, debrief4.md §2.2 and §3: across three sessions the agent called
 * the .epf launcher with an empty path, with `C:\nonexistent`, with
 * `C:\nonexistent.epf`, and with a real but unrelated .epf it had itself
 * dismissed four hours earlier. Every one of those launched 1cv8.exe. The two
 * nonexistent paths still raised a MODAL error dialog -- `/DisableStartupMessages`
 * suppresses the log, not the dialog -- which disabled the whole 1C client, and
 * with it the MCP Toolkit that lives inside a client session. The agent had no
 * way to know it had disabled its own toolchain, and each incident cost the
 * timeout (~5 minutes) with the base unusable throughout.
 *
 * `input` paths must already exist; `output` paths are created by the platform,
 * so only their parent directory is checked. Declared here rather than at the
 * call site for the same reason `writes` is: one place, readable and testable.
 */
export interface PathSpec {
  /**
   * `input` must already exist; `output` is a file the platform creates, so
   * only its parent is checked; `directory` is a folder the platform fills,
   * which may or may not exist yet -- see `checkPath`.
   */
  readonly kind: "input" | "output" | "directory" | "source"
  /** Lower-case, with the dot. Empty means any extension is acceptable. */
  readonly extensions: readonly string[]
}

const PATH_SPECS: Readonly<Partial<Record<OperationId, PathSpec>>> = {
  // `.cfe` too, as for load_config below: an extension is naturally saved as one
  // (2026-09-25, debrief13.md -- the agent's first try was refused for the name).
  dump_config: { kind: "output", extensions: [".cf", ".cfe"] },
  dump_config_to_files: { kind: "directory", extensions: [] },
  // For both .epf operations `path` is the side the platform reads or fills
  // first, and `secondPath` is checked by `secondPathSpec`.
  dump_epf_to_files: { kind: "directory", extensions: [] },
  load_epf_from_files: { kind: "input", extensions: [".xml"] },
  // `.cfe` as well as `.cf`: an extension is loaded by the same command, with
  // `-Extension <Имя>` added (2026-09-25). Rejecting the extension container here
  // made the guarded route unusable for extension work.
  load_config: { kind: "input", extensions: [".cf", ".cfe"] },
  // A dump-shaped tree: the directory holding Configuration.xml.
  load_config_from_files: { kind: "source", extensions: [] },
  execute: { kind: "input", extensions: [".epf", ".erf"] },
}

export function pathSpec(id: OperationId): PathSpec | undefined {
  return PATH_SPECS[id]
}

/**
 * The second path argument, for the two operations that take one.
 *
 * `dump_epf_to_files` reads an existing .epf and fills a directory;
 * `load_epf_from_files` reads an XML root and writes the .epf or .erf.
 *
 * 2026-09-29, debrief16.md §16.3: the load was believed to only UPDATE an
 * existing container, so a missing target was refused and agents copied some
 * other task's .epf in as a "blank". On a scratch base (8.5.1) the load
 * creates a missing target from the XML alone, for a processor and a report
 * alike; only the directory has to exist.
 */
const SECOND_PATH_SPECS: Readonly<Partial<Record<OperationId, PathSpec>>> = {
  dump_epf_to_files: { kind: "input", extensions: [".epf", ".erf"] },
  load_epf_from_files: { kind: "input", extensions: [".epf", ".erf"] },
}

export function secondPathSpec(id: OperationId): PathSpec | undefined {
  return SECOND_PATH_SPECS[id]
}

/**
 * The paths an operation creates or rewrites, as opposed to reads. For
 * `load_epf_from_files` that is the .epf or .erf it writes.
 */
export function createdPaths(id: OperationId, args: { path?: string; epfPath?: string }): string[] {
  const created: (string | undefined)[] = []
  const kind = PATH_SPECS[id]?.kind
  if (kind === "output" || kind === "directory") created.push(args.path)
  if (id === "load_epf_from_files") created.push(args.epfPath)
  // The XML tree an extension is loaded from is the agent's own work, and the
  // binding pass rewrites Form.xml in it before the load.
  if (id === "load_config_from_files") created.push(args.path)
  return created.filter((path): path is string => typeof path === "string" && path.trim().length > 0).map((p) => p.trim())
}

/** Whether this operation needs a second path, so a missing one is named rather than launched. */
export function requiresSecondPath(id: OperationId): boolean {
  return Object.hasOwn(SECOND_PATH_SPECS, id)
}

/** `checkPath` for the second argument; same rules, different spec table. */
export function checkSecondPath(
  id: OperationId,
  path: string | undefined,
  probe: PathProbe,
): string | null {
  const spec = SECOND_PATH_SPECS[id]
  if (!spec) return null
  const trimmed = (path ?? "").trim()
  if (!trimmed) return "Для этой операции нужен второй путь — файл обработки или отчёта (.epf, .erf)."
  const lower = trimmed.toLowerCase()
  if (!spec.extensions.some((ext) => lower.endsWith(ext))) {
    return `Ожидается файл ${spec.extensions.join(" или ")}, получено: ${trimmed}`
  }
  if (id === "load_epf_from_files") {
    return probe.isDirectory(parentDirectory(trimmed)) ? null : `Нет каталога для собранного файла: ${parentDirectory(trimmed)}`
  }
  if (!probe.isFile(trimmed)) return `Файла обработки нет: ${trimmed}`
  return null
}

/** Filesystem questions `checkPath` needs answered. Injected so it stays pure. */
export interface PathProbe {
  readonly isFile: (path: string) => boolean
  readonly isDirectory: (path: string) => boolean
}

function parentDirectory(path: string): string {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  return at <= 0 ? path : path.slice(0, at)
}

/**
 * Returns a reason to refuse, or null when the path is acceptable.
 *
 * The message is what the agent is shown, so it names the actual problem and,
 * where a wrong tool is the likely cause, names the right one -- an agent that
 * reached the .epf launcher meaning to run BSL needs to be told that, not just
 * told "no".
 */
export function checkPath(id: OperationId, path: string | undefined, probe: PathProbe): string | null {
  const spec = PATH_SPECS[id]
  if (!spec) return null

  const trimmed = (path ?? "").trim()
  if (!trimmed) {
    return id === "execute"
      ? "Путь к обработке не указан. Этот инструмент запускает готовый файл .epf; " +
          "код 1С выполняется инструментом 1c_execute_code."
      : "Для этой операции нужен путь к файлу."
  }

  const lower = trimmed.toLowerCase()
  if (spec.extensions.length && !spec.extensions.some((ext) => lower.endsWith(ext))) {
    const wanted = spec.extensions.join(" или ")
    return id === "execute"
      ? `Это не файл обработки (${wanted}): ${trimmed}. ` +
          "Если нужно выполнить код 1С, это инструмент 1c_execute_code."
      : `Ожидается файл ${wanted}, получено: ${trimmed}`
  }

  if (spec.kind === "source") {
    if (!probe.isDirectory(trimmed)) return `Каталога нет: ${trimmed}`
    if (!probe.isFile(`${trimmed.replace(/[\\/]+$/, "")}/Configuration.xml`)) {
      return (
        `В каталоге нет Configuration.xml: ${trimmed}. Нужен корень выгрузки расширения — ` +
        "тот каталог, где лежит Configuration.xml (заготовку создаёт 1c_new_extension)."
      )
    }
    return null
  }

  if (spec.kind === "input") {
    if (!probe.isFile(trimmed)) {
      return id === "execute"
        ? `Файла обработки нет: ${trimmed}. Запускать можно только .epf, который уже собран — ` +
            "проверь путь вместо повторного вызова."
        : `Файла нет: ${trimmed}`
    }
    return null
  }

  // A dump target may not exist yet -- the executor creates it -- but it must
  // not be an existing FILE, and its parent has to be real. Refusing a path
  // whose parent is a typo here is the difference between one clear message and
  // a ten-minute configurator run that ends in an opaque platform error.
  if (spec.kind === "directory") {
    if (probe.isDirectory(trimmed)) return null
    if (probe.isFile(trimmed)) return `Это файл, а нужен каталог: ${trimmed}`
    const above = parentDirectory(trimmed)
    // 2026-09-25, debrief13.md: «создать его негде» named no way forward; the
    // agent created the parent itself, outside the working directory.
    if (!probe.isDirectory(above)) {
      return (
        `Нет родительского каталога: ${above}. Выгрузка создаёт только последний уровень пути — ` +
        "создай родителя в рабочем каталоге профиля или укажи путь прямо в нём."
      )
    }
    return null
  }

  const parent = parentDirectory(trimmed)
  // 2026-09-26, debrief14.md §14.2: the bare message was followed by a manual
  // mkdir and a retry; say so up front.
  if (!probe.isDirectory(parent)) {
    return `Каталога для записи нет: ${parent}. Создай его в рабочем каталоге профиля или укажи файл прямо в нём.`
  }
  return null
}

/** Operations that need a path argument; asking for one without it is a mistake worth naming. */
const NEEDS_PATH: ReadonlySet<OperationId> = new Set([
  "dump_config",
  "dump_config_to_files",
  "load_config",
  "load_config_from_files",
  "execute",
])

export function requiresPath(id: OperationId): boolean {
  return NEEDS_PATH.has(id)
}

export function writesToInfobase(id: OperationId): boolean {
  return OPERATIONS[id].writes
}

/**
 * Whether this operation must not share the infobase with a live client session.
 *
 * Every DESIGNER run does. The configurator opens the base at a level the
 * thick client does not expect to share, and on 2026-09-16 a batch DESIGNER
 * launch against a base the MCP Toolkit already held truncated
 * `RuntimeCacheStorage` to 20 bytes, killed the toolkit, and cost 26 minutes:
 * three `1c_execute` calls that failed with EMPTY error strings (686s of
 * retries on no information at all), a process hunt, a port probe, a cache
 * cleanup, and a 444s toolkit restart. The agent worked out its own cause
 * correctly -- after the damage.
 *
 * Derived from `mode` rather than stored per operation, because the hazard is
 * a property of the configurator and not of any one command: a new DESIGNER
 * operation added later inherits the guard instead of having to remember it.
 * ENTERPRISE is deliberately excluded -- the toolkit is itself an ENTERPRISE
 * session, so treating those as exclusive would forbid the normal workflow.
 */
export function needsExclusiveInfobase(id: OperationId): boolean {
  return OPERATIONS[id].mode === "DESIGNER"
}

/**
 * The full argument list for one platform run.
 *
 * Quoting follows the same rule the verification check established: 1C wants
 * the quotes around the VALUE, not around the whole argument, and the caller
 * runs the process with windowsVerbatimArguments so Node does not add its own.
 */
export function buildArgs(input: {
  id: OperationId
  connection: string
  userName: string
  password: string
  outPath: string
  path?: string
  secondPath?: string
  update?: boolean
  /** Scopes the command to one extension (`-Extension <Имя>`). */
  extension?: string
  /** A file listing the objects to dump (`-listFile`). */
  listFile?: string
}): string[] {
  const definition = OPERATIONS[input.id]
  return [
    definition.mode,
    input.connection,
    `/N"${input.userName}"`,
    // An empty /P makes the platform raise the login dialog even when the user
    // has no password -- emit /P only when there is one.
    ...(input.password ? [`/P"${input.password}"`] : []),
    ...definition.args({
      path: input.path,
      secondPath: input.secondPath,
      update: input.update,
      extension: input.extension,
      listFile: input.listFile,
    }),
    "/DisableStartupDialogs",
    "/DisableStartupMessages",
    `/Out"${input.outPath}"`,
  ]
}

/** The connection argument for a profile, in the form the platform takes. */
export function connectionArg(profile: {
  kind: "file" | "server"
  filePath?: string
  serverCluster?: string
  serverDatabase?: string
}): string {
  return profile.kind === "file"
    ? `/F"${profile.filePath ?? ""}"`
    : `/S"${profile.serverCluster ?? ""}\\${profile.serverDatabase ?? ""}"`
}
