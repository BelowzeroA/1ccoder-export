// The opencode plugin that gives the agent its 1C tools.
//
// It runs inside the sidecar, which is where opencode's permission system
// lives -- and that is the point. Phase 5 defined `infobase_write` and
// classified it always-ask, but nothing asserted it, so the class was inert.
// Here it becomes real: every operation that writes to the bound infobase
// calls ctx.ask() first, which routes into exactly the same prompt machinery
// as the other always-ask classes, in AutoMode as well as manual.
//
// The plugin holds no credentials. It posts to the desktop's loopback relay,
// which resolves the session's profile, decrypts the password and runs the
// platform. Two locks on the same door: the permission is asserted here, and
// the executor refuses a write that does not carry the grant.
//
// The relay's port is ephemeral, so it is passed in as a plugin option --
// `plugin: [["<path>", { baseUrl }]]` in opencode.json.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

import {
  checkPath,
  checkSecondPath,
  createdPaths,
  EXEC_REQUEST_TIMEOUT_MS,
  OPERATIONS,
  pathSpec,
  requiresSecondPath,
  secondPathSpec,
  needsExclusiveInfobase,
  writesToInfobase,
  type OperationId,
  type PathProbe,
} from "./operations"
import { bslFrom, bulkRefusal, inspectBulkWrite, writeTarget } from "./bulk"
import {
  approvalKey,
  consumeApproval,
  hasApproval,
  hasNearMissApproval,
  inspectBaseWrite,
  inspectOverwrite,
  missingFacts,
  overwriteRefusal,
  recordApproval,
  writeAskText,
  writeRefusal,
  writeTargets,
} from "./writes"
import { bindFormEvents, describeBindings, describeFormBindings, inspectFormBindings } from "./form-bindings"
import { describeMxlTemplate, parseMxlTemplate } from "./mxl"
import { editMxlCells, type MxlEdit, type MxlStyle } from "./mxl-edit"
import { commandFrom, shellRefusal, SHELL_ENV, withEncoding } from "./shell"
import { decideSupport, supportRefusal, type SupportProbe } from "./support"
import {
  insideDirectory,
  insideTemp,
  isAbsolutePath,
  outsideWorkingRefusal,
  shellTempRefusal,
  shellTempWrite,
  tempRefusal,
  v8packOutput,
} from "./containment"
import { describeExistingDump, dumpNearby, existingDump, type DumpProbe } from "./dumps"
import { dumpWriteRefusal, insideDump } from "./dump-dirs"
import {
  announcedStep,
  awaitsHuman,
  classifyError,
  EMPTY_ANSWER,
  endedEmpty,
  exhaustedText,
  RESUME_LIMIT,
  RESUME_WINDOW_MS,
  ResumeBudget,
  resumeText,
  userSpokeAfterFailure,
  type MessageLike,
  type SessionErrorLike,
} from "./auto-resume"
import { routeAgent } from "./agent-routing"
import { checkComparison, registrationRefusal, type SampleCheck, type SampleField } from "./sample-check"
import { describeDumpObject } from "./dump-object"
import {
  commandModuleFinding,
  commandModuleRefusal,
  commandModuleWarning,
  droppedParts,
  formTagRefusal,
  formTagWarning,
  partialLoadNote,
  prefixRefusal,
  undeclaredPrefixes,
  unknownFormTags,
  type CommandModuleFindings,
  type FormFileFindings,
  type PrefixFindings,
} from "./load-check"
import { baseFactsFromDump, extensionSkeleton, isMetadataName, type ExtensionPurpose } from "./extension-skeleton"
import { EXTERNAL_EXTENSIONS, externalKind, externalSkeleton, SCHEMA_TEMPLATE, type ExternalKind } from "./external-skeleton"
import { compareIdentity, describeIdentity, fingerprint, type EpfFingerprint } from "./epf-identity"
import { describeJournal, journalDirectory, journalLine, journalPath, readJournal, type WriteStarted } from "./journal"
import { provenanceRefusal } from "./provenance"
import { markUnansweredQuestion, type TransformMessage } from "./questions"
import { EXPECTED_PLUGIN_TOOLS } from "./registration"
import {
  appendToResult,
  describeExit,
  executeCodeUnavailable,
  gateRefusal,
  isFailure,
  isToolkitTool,
  maskedNote,
  maskedTokenRefusal,
  referenceHint,
  RepeatedFailures,
  REPEATED_FAILURE_NOTICE,
  resultText,
  type ToolkitExitInfo,
  type ToolkitGate,
} from "./toolkit-calls"
import { describeConfiguration, type InfobaseConfiguration } from "../profiles/configuration"
import { packFor, packHint, type ConfigurationPack } from "../skills/packs"

/**
 * Errors that mean a toolkit request was never sent: the MCP client had no
 * transport, or nothing listened on the port. A timeout or a reset mid-call is
 * not here -- the write may have happened, so its approval stays spent.
 */
const NEVER_SENT = /Not connected|is not connected|ECONNREFUSED/i

/** Operations that load source into the base; their output is read for skipped parts. */
const LOADS: ReadonlySet<string> = new Set(["load_config", "load_config_from_files", "load_epf_from_files"])

/**
 * The files named `Ext/<name>` under a load's source, with their text: the
 * directory of a configuration or extension, or the root file of a processing
 * (whose objects are in the directory of the same name). Paths are relative,
 * with forward slashes, for the messages.
 */
function sourceFiles(path: string | undefined, name: string): { file: string; text: string }[] {
  if (!path) return []
  const root = /\.xml$/i.test(path) ? path.replace(/\.xml$/i, "") : path
  let entries: string[]
  try {
    entries = readdirSync(root, { recursive: true, encoding: "utf8" })
  } catch {
    return []
  }
  const suffix = `ext/${name}`.toLowerCase()
  return entries
    .map((entry) => entry.replace(/\\/g, "/"))
    .filter((entry) => entry.toLowerCase() === suffix || entry.toLowerCase().endsWith(`/${suffix}`))
    .flatMap((entry) => {
      try {
        return [{ file: entry, text: readFileSync(join(root, entry), "utf8") }]
      } catch {
        return []
      }
    })
}

/** Every XML file of a load's source, a processing's root descriptor included -- see load-check.ts. */
function prefixFindings(path: string | undefined): PrefixFindings[] {
  if (!path) return []
  const isRootFile = /\.xml$/i.test(path)
  const root = isRootFile ? path.replace(/\.xml$/i, "") : path
  let entries: string[]
  try {
    entries = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((entry) => /\.xml$/i.test(entry))
  } catch {
    entries = []
  }
  const files = [
    ...(isRootFile ? [{ file: path.split(/[\\/]/).at(-1) ?? path, full: path }] : []),
    ...entries.map((entry) => ({ file: entry.replace(/\\/g, "/"), full: join(root, entry) })),
  ]
  return files.flatMap((source) => {
    try {
      const prefixes = undeclaredPrefixes(readFileSync(source.full, "utf8"))
      return prefixes.length > 0 ? [{ file: source.file, prefixes }] : []
    } catch {
      return []
    }
  })
}

/** Every form under a load's source, common forms included -- see load-check.ts. */
function formTagFindings(path: string | undefined): FormFileFindings[] {
  return sourceFiles(path, "Form.xml").flatMap((source) => {
    const findings = unknownFormTags(source.text)
    return findings.length > 0 ? [{ file: source.file, findings }] : []
  })
}

/** Every command module under a load's source, common and object commands alike. */
function commandModuleFindings(path: string | undefined): CommandModuleFindings[] {
  return sourceFiles(path, "CommandModule.bsl").flatMap((source) => {
    const finding = commandModuleFinding(source.text)
    return finding ? [{ file: source.file, finding }] : []
  })
}

/** statSync throws on a missing path; both questions answer "no" in that case. */
const diskProbe: PathProbe = {
  isFile: (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
}

/** `diskProbe` plus the two reads the support decoder needs. */
const supportProbe: SupportProbe = {
  ...diskProbe,
  readText: (path) => {
    try {
      return readFileSync(path, "utf8")
    } catch {
      return null
    }
  },
  readBytes: (path) => {
    try {
      return readFileSync(path)
    } catch {
      return null
    }
  },
}

const dumpProbe: DumpProbe = {
  readText: supportProbe.readText,
  isFile: diskProbe.isFile,
  mtimeMs: (path) => {
    try {
      return statSync(path).mtimeMs
    } catch {
      return null
    }
  },
  list: (path) => {
    try {
      return readdirSync(path)
    } catch {
      return null
    }
  },
}

/** The bundled templates, installed beside this file: a build must not equal one of them. */
function templateFingerprints(): readonly { label: string; fingerprint: EpfFingerprint }[] {
  try {
    const dir = fileURLToPath(new URL("./templates/", import.meta.url))
    return readdirSync(dir)
      .filter((name) => /\.(epf|erf)$/i.test(name))
      .map((name) => ({ label: `шаблон ${name}`, fingerprint: fingerprint(readFileSync(`${dir}${name}`)) }))
  } catch {
    return []
  }
}

/**
 * Operations that can be scoped to one extension.
 *
 * 2026-09-25. An extension's modules are not in the main configuration dump, so
 * without this an agent looking for code inside an extension has no guarded way
 * to reach it -- and the shell guard refuses the hand-rolled command that would.
 */
const EXTENSION_SCOPED: ReadonlySet<OperationId> = new Set([
  "dump_config",
  "dump_config_to_files",
  "load_config",
  "load_config_from_files",
  "update_db",
  "delete_extension",
])

/**
 * Operations that only exist for an extension. Loading the MAIN configuration
 * from files, or deleting it, is not something to offer an agent at all.
 */
const EXTENSION_ONLY: ReadonlySet<OperationId> = new Set(["load_config_from_files", "delete_extension"])

const REQUEST_TIMED_OUT = "1ccoder-relay-timeout"

/**
 * POST JSON to the relay over `node:http`, with ONE deadline: our own.
 *
 * 2026-09-21, debrief7.md §4 and D1. This used to be `fetch` carrying
 * `AbortSignal.timeout(EXEC_REQUEST_TIMEOUT_MS)`, with a comment claiming the
 * signal covered undici's 300-second `headersTimeout`. It does not. A signal
 * adds an abort LATER; it cannot raise a deadline that fires EARLIER, and
 * undici's applies to the wait for response headers, which is exactly the phase
 * a long DESIGNER operation spends.
 *
 * The consequence was worse than a hang. `dump_config_to_files` completed —
 * 6.8 GB of XML written — and reported failure at the 300-second mark, so the
 * agent fell back to driving Designer by hand through `bash`: the unguarded
 * route that operation exists to replace, taken while it reassured itself the
 * route was safe. A safety tool that lies about failing is worse than its own
 * absence.
 *
 * `node:http` has no client-side header deadline, so the only clock is
 * `timeoutMs` here, and it is deliberately longer than the platform's own
 * (see EXEC_REQUEST_TIMEOUT_MS) so the executor's answer always wins the race.
 */
function postJson(url: string, payload: unknown, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), "utf8")
    const target = new URL(url)
    const request = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": body.byteLength },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        )
        response.on("error", reject)
      },
    )
    // setTimeout here is the socket's idle timer, not a response deadline: a
    // silent socket for this long is the only failure we invent ourselves.
    request.setTimeout(timeoutMs, () => request.destroy(new Error(REQUEST_TIMED_OUT)))
    request.on("error", reject)
    request.end(body)
  })
}

interface ExecResponse {
  ok: boolean
  reason?: string
  detail?: string
  exitCode?: number | null
  output?: string
  summary?: string
  /** The toolkit was holding the base and had to be closed for this run. */
  toolkitStopped?: boolean
  /** The toolkit answered before this run and stopped answering after it. */
  toolkitBlocked?: boolean
  /** With toolkitBlocked: the modal windows now holding the base's sessions, read from the screen. */
  blockingDialogs?: string
  /** The toolkit was closed for this run and handed back because nothing launched. */
  toolkitRestored?: boolean
}

const REFUSALS: Record<string, string> = {
  "no-profile":
    "У этого сеанса нет профиля разработчика, поэтому информационной базы нет. " +
    "Чтобы работать с базой, начните сеанс с профилем.",
  "profile-missing": "Профиль, к которому был привязан сеанс, больше не существует.",
  "not-permitted": "Пользователь не разрешил запись в информационную базу.",
  "unknown-operation": "Неизвестная операция.",
  "path-required": "Для этой операции нужен путь к файлу.",
  "path-rejected": "Указанный путь использовать нельзя.",
  "launch-failed": "Не удалось запустить платформу 1С.",
  "timed-out": "Операция не завершилась за отведённое время и была прервана.",
}

/**
 * Said whenever the toolkit was closed to free the base.
 *
 * It has to be in the tool's own output, not merely logged: the agent's next
 * `1c_*` query tool would otherwise fail against a port that stopped answering
 * for a reason nothing in the conversation explains. That is the shape of the
 * 2026-09-16 loss -- three retries against a dead toolkit returning empty
 * error strings, 686 seconds spent on no information at all.
 */
const TOOLKIT_STOPPED_NOTICE =
  "MCP Toolkit был закрыт: конфигуратор не может работать с базой, которую держит сеанс 1С:Предприятия. " +
  "Инструменты 1c_* к базе сейчас недоступны — если они снова нужны, вызови 1c_toolkit_start " +
  "(запуск занимает до нескольких минут, так что сначала выполни все операции конфигуратора)."

/**
 * The self-block. 2026-09-20, debrief4.md §3.1.
 *
 * An .epf that opens a modal form -- or a missing one, which raises the
 * platform's own error dialog -- disables the whole 1C client, and the MCP
 * Toolkit lives inside a client session. The agent's own call therefore takes
 * away the tools it needs, and without this notice nothing says so: the 1c_*
 * tools just stop answering, which reads like a network problem. Retrying is
 * the worst available response and the one that was actually chosen, three
 * times, so the text says outright not to.
 */
const TOOLKIT_BLOCKED_NOTICE =
  "ВНИМАНИЕ: после этого запуска MCP Toolkit перестал отвечать. Почти наверняка запущенная " +
  "обработка открыла модальное окно: оно блокирует весь сеанс 1С:Предприятия, а тулкит работает " +
  "внутри этого сеанса, поэтому инструменты 1c_execute_code, 1c_execute_query и остальные 1c_* " +
  "сейчас недоступны. Это сделал твой собственный вызов. Не повторяй его и не запускай другую " +
  "обработку — так появится второе такое же окно. Скажи пользователю, что нужно закрыть окно 1С."

// Said only when the platform never started, so the toolkit was closed for
// nothing and has been handed back. Without this the agent would be told the
// toolkit is down when it is on its way up, and would either wait or start a
// second one. debrief5.md §8.2.
const TOOLKIT_RESTORED_NOTICE =
  "MCP Toolkit закрывался под эту операцию, но платформа так и не запустилась — он запускается " +
  "обратно сам. Инструменты 1c_* появятся через несколько десятков секунд; отдельно вызывать " +
  "1c_toolkit_start не нужно."

function describe(response: ExecResponse): string {
  const notice = [
    ...(response.toolkitStopped ? ["", TOOLKIT_STOPPED_NOTICE] : []),
    ...(response.toolkitRestored ? ["", TOOLKIT_RESTORED_NOTICE] : []),
    ...(response.toolkitBlocked ? ["", TOOLKIT_BLOCKED_NOTICE] : []),
    ...(response.toolkitBlocked && response.blockingDialogs
      ? ["", "Окно, которое сейчас держит сеанс (текст прочитан с экрана) — перескажи его пользователю:", "", response.blockingDialogs]
      : []),
  ]
  if (response.ok) {
    const status = response.exitCode === 0 ? "успешно" : `код возврата ${response.exitCode}`
    return [`${response.summary ?? "Операция"}: ${status}`, "", response.output ?? "", ...notice].join("\n").trim()
  }
  const message = REFUSALS[response.reason ?? ""] ?? "Операция не выполнена."
  const body = response.detail ? `${message}\n\n${response.detail}` : message
  return [body, ...notice].join("\n").trim()
}

export const InfobasePlugin: Plugin = async (input, options) => {
  const baseUrl = String(options?.baseUrl ?? "").replace(/\/+$/, "")
  // Whose toolkit to ask about: the session's profile, and this instance's
  // folder, whose one MCP client the 1c_* tools go through (mcp/ipc.ts links).
  const gateRequest = (sessionID: string) => ({ conversationId: `session:${sessionID}`, directory: input.directory })

  async function exec(request: Record<string, unknown>): Promise<ExecResponse> {
    if (!baseUrl) {
      return { ok: false, reason: "launch-failed", detail: "1CCoder relay address was not provided." }
    }
    try {
      const { status, body } = await postJson(`${baseUrl}/1c/exec`, request, EXEC_REQUEST_TIMEOUT_MS)
      if (status !== 200) {
        return { ok: false, reason: "launch-failed", detail: `Relay responded ${status}` }
      }
      return JSON.parse(body) as ExecResponse
    } catch (error) {
      // Say which side gave up. A bare "fetch failed" reads like the operation
      // failed, and the agent retries into a second platform launch.
      const timedOut = error instanceof Error && error.message === REQUEST_TIMED_OUT
      return {
        ok: false,
        reason: "launch-failed",
        detail: timedOut
          ? "Приложение не ответило за отведённое время. 1С могла остаться запущенной — " +
            "не повторяй вызов, сначала скажи пользователю."
          : `Связь с приложением 1CCoder не удалась: ${String(error)}`,
      }
    }
  }

  interface ProfileResponse {
    ok: boolean
    reason?: string
    detail?: string
    name?: string
    platformPath?: string
    kind?: string
    infobase?: string
    workingDirectory?: string
    userName?: string
    hasPassword?: boolean
    toolkit?: { port: number; state: string; alive: boolean; reason?: string; detail?: string; exit?: ToolkitExitInfo }
    configuration?: InfobaseConfiguration
    allowWriteWithoutConfirmation?: boolean
  }

  /** Whether the user allowed this session's base to be written without an ask each time. */
  async function writesWithoutAsking(sessionID: string): Promise<boolean> {
    return (await sessionProfile(sessionID))?.allowWriteWithoutConfirmation === true
  }

  /**
   * The configuration pack of the session's infobase, if its configuration is
   * recorded and has one. Never throws and never waits on the toolkit: it asks
   * the relay with `detect: false`, so only what is already known counts.
   */
  async function sessionPack(sessionID: string): Promise<ConfigurationPack | undefined> {
    return packFor((await sessionProfile(sessionID))?.configuration?.name)
  }

  /** The session's profile as recorded, without waking the toolkit. Never throws. */
  async function sessionProfile(sessionID: string): Promise<ProfileResponse | undefined> {
    const profile = await sessionBinding(sessionID)
    return profile?.ok ? profile : undefined
  }

  /** The relay's answer as is, refusals included: "no-profile" is a fact too. Undefined when it didn't answer. */
  async function sessionBinding(sessionID: string): Promise<ProfileResponse | undefined> {
    return relay<ProfileResponse>("profile", { conversationId: `session:${sessionID}`, detect: false })
  }

  /**
   * The refusal for an operation whose result would land outside the session's
   * working directory, or null. Fails open when the profile or its directory is
   * unknown: no answer from the relay is not evidence the path is wrong.
   */
  async function outsideWorkingDirectory(
    sessionID: string,
    id: OperationId,
    args: { path?: string; epfPath?: string },
  ): Promise<string | null> {
    const created = createdPaths(id, args)
    if (created.length === 0) return null
    const workingDirectory = (await sessionProfile(sessionID))?.workingDirectory
    if (!workingDirectory) return null
    const stray = created.find((path) => isAbsolutePath(path) && !insideDirectory(path, workingDirectory))
    return stray ? outsideWorkingRefusal(stray, workingDirectory) : null
  }

  /** A short JSON request to the relay; undefined on any failure. */
  async function relay<T>(path: string, body: Record<string, unknown>, timeoutMs = 10_000): Promise<T | undefined> {
    if (!baseUrl) return undefined
    try {
      const response = await fetch(`${baseUrl}/1c/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      return response.ok ? ((await response.json()) as T) : undefined
    } catch {
      return undefined
    }
  }

  // When this sidecar first saw each session. `1c_run_epf` accepts without
  // question only a file written since then (provenance.ts).
  const sessionStarted = new Map<string, number>()
  const noteSession = (sessionID: string) => {
    if (!sessionStarted.has(sessionID)) sessionStarted.set(sessionID, Date.now())
  }

  // Approved write requests, by approval key, until their code is sent; then
  // by call id until its result is journalled (journal.ts).
  const approvedRequests = new Map<string, Omit<WriteStarted, "kind" | "callID" | "sessionID" | "at">>()
  const writesInFlight = new Map<string, string>()
  // debrief15.md §15.3: an approval is spent before the call is made. When the
  // call then fails without ever reaching the base, the approval is given back
  // (see the `event` hook). Keyed by callID.
  const spentApprovals = new Map<
    string,
    { sessionID: string; code: string; approved?: Omit<WriteStarted, "kind" | "callID" | "sessionID" | "at"> }
  >()
  const repeated = new RepeatedFailures()
  // Extensions loaded by 1c_load_config and not yet applied by 1c_update_db.
  const unappliedExtensions = new Map<string, Set<string>>()
  // Sessions whose main configuration was updated while extensions were pending.
  const unscopedUpdateDone = new Set<string>()
  // 2026-09-25, debrief13.md §13.8: three times a configurator operation came
  // straight after 1c_toolkit_start, while the toolkit's tools were still
  // appearing, and closed the client just started -- once the stated intent was
  // 1c_execute_code and the call was 1c_check_config. The warning in the start
  // result did not stop it. Sessions whose toolkit is started and not yet used,
  // with when it was started.
  //
  // 2026-09-26, debrief14.md §14.5: the first version refused once and let a
  // repeat through. The repeat turned out to be a reflex, not a decision -- a
  // session spent over half an hour cycling toolkit_start → check_config →
  // check_config (the repeat, closing the toolkit) → toolkit_start. So the
  // refusal now stands for as long as the toolkit is really up and unused. It
  // cannot become a dead end: a toolkit that is not listening, or one started
  // more than TOOLKIT_UNUSED_MS ago, no longer holds anything back.
  const toolkitStartedAt = new Map<string, number>()
  const TOOLKIT_UNUSED_MS = 15 * 60 * 1000
  // 2026-09-28, debrief15.md §15.18: for an external processing, build → toolkit →
  // check or print → edit → build is the work itself, so a start the agent then
  // follows with a build is not a mistake the refusal prevents. The refusal cost a
  // throwaway `1c_execute_code` (the date) before each build -- four in one run --
  // and saved nothing. The guard stays for operations on the configuration.
  const UNGUARDED_BY_UNUSED_TOOLKIT: ReadonlySet<OperationId> = new Set(["load_epf_from_files", "dump_epf_to_files"])
  // This plugin's own tool names; any other `1c_*` tool belongs to the toolkit.
  const ownTools = new Set<string>()
  // Dumps found nearby and already reported to a session; `refresh` past one counts only then.
  const shownDumps = new Map<string, Set<string>>()

  /** Appends to the session's journal; a journal that cannot be written must not fail the write. */
  async function journal(sessionID: string, line: Parameters<typeof journalLine>[0]): Promise<void> {
    const profile = await sessionProfile(sessionID)
    if (!profile?.workingDirectory) return
    try {
      mkdirSync(journalDirectory(profile.workingDirectory), { recursive: true })
      appendFileSync(journalPath(profile.workingDirectory), journalLine(line), "utf8")
    } catch {
      // Nothing to do: the write itself has its own result.
    }
  }

  function describeProfileResponse(profile: ProfileResponse): string {
    if (!profile.ok) return REFUSALS[profile.reason ?? ""] ?? "Профиль сеанса недоступен."

    const toolkit = profile.toolkit
    // `died` is the case worth spelling out: the 1c_* query tools are still in
    // the agent's tool list but are stale registrations pointing at a dead
    // port, and calling one answers `fetch failed` with nothing to explain it.
    // Three times in one session (debrief5.md §8.4) the agent had to infer that
    // for itself. Here the app knows, so it says so.
    const toolkitLine = !toolkit
      ? "неизвестно"
      : toolkit.alive
        ? `работает, порт ${toolkit.port} отвечает`
        : toolkit.state === "died"
          ? toolkit.exit
            ? `УПАЛ — порт ${toolkit.port} больше не отвечает.\n${describeExit(toolkit.exit)}`
            : `УПАЛ — был запущен, но порт ${toolkit.port} больше не отвечает (окно 1С закрыли или процесс завершился)`
          :`не работает (${toolkit.state}${toolkit.reason ? `: ${toolkit.reason}` : ""}), порт ${toolkit.port} молчит` +
            (toolkit.detail ? `\n${toolkit.detail}` : "")

    return [
      `Профиль: ${profile.name}`,
      `Платформа: ${profile.platformPath}`,
      `Информационная база (${profile.kind === "file" ? "файловая" : "серверная"}): ${profile.infobase}`,
      `Пользователь: ${profile.userName}`,
      `Пароль: ${profile.hasPassword ? "сохранён в приложении (тебе не выдаётся)" : "не задан"}`,
      `Рабочий каталог: ${profile.workingDirectory}`,
      `Конфигурация: ${describeConfiguration(profile.configuration)}`,
      `MCP Toolkit: ${toolkitLine}`,
      ...(profile.allowWriteWithoutConfirmation
        ? [
            "Запись в базу: без подтверждения — пользователь разрешил это в профиле. Код с записью " +
              "выполняй прямо в 1c_execute_code, 1c_write_code не нужен. Каждая запись по-прежнему " +
              "попадает в журнал сеанса (1c_session_writes) — объём и охват узнавай до записи и называй в отчёте.",
          ]
        : []),
      "",
      toolkit?.state === "died"
        ? "Инструменты 1c_execute_query, 1c_execute_code и остальные 1c_* сейчас в твоём списке, но " +
          "ведут на мёртвый порт: вызов вернёт «fetch failed», и это не сетевая ошибка и не твой " +
          "код. Подними тулкит через 1c_toolkit_start и повтори."
        : toolkit && !toolkit.alive
          ? "Инструментов запросов к базе сейчас нет. Что с этим делать — в навыке 1ccoder-ib-toolkit-launch."
          : "Запросы к данным базы — через инструменты 1c_execute_query и другие 1c_*.",
    ].join("\n")
  }

  function makeTool(id: OperationId, description: string, needsPath: boolean) {
    const definition = OPERATIONS[id]
    // Outside the path branch: update_db takes no path, and inside it the
    // extension argument was never declared -- so every `extension` an agent
    // sent was dropped by the schema (2026-09-26, debrief13.md §13.11).
    const scoped = EXTENSION_SCOPED.has(id)
    const extensionArgs = {
      extension: tool.schema
        .string()
        .optional()
        .describe(
          "Имя расширения, если команда относится к расширению, а не к основной конфигурации " +
            "(в конфигураторе это -Extension). " +
            (id === "update_db"
              ? "Без него обновляется только основная конфигурация: загруженное расширение " +
                "в базе не применится, хотя ответ будет «успешно»."
              : id === "load_config"
                ? "После загрузки расширения вызови update_db с тем же extension — иначе база " +
                  "продолжит исполнять прежнюю версию."
                : "Модули расширения в выгрузку основной конфигурации не попадают — без этого " +
                  "параметра ты получишь не тот объект."),
        ),
      // 2026-09-26, debrief13.md §13.11: an agent that insisted it was
      // passing the name sent `{}` again and again. The toolkit's own
      // tools call this `extension_name`, and a key the schema does not
      // know is dropped without an error -- so it is accepted too.
      extension_name: tool.schema.string().optional().describe("То же, что extension."),
    }
    return tool({
      description,
      args: needsPath
        ? {
            path: tool.schema
              .string()
              .describe(pathSpec(id)?.kind === "directory" ? "Абсолютный путь к каталогу" : "Абсолютный путь к файлу"),
            ...(requiresSecondPath(id)
              ? {
                  epfPath: tool.schema
                    .string()
                    .describe(
                      id === "load_epf_from_files"
                        ? "Абсолютный путь к собираемому файлу: .epf для обработки, .erf для отчёта"
                        : secondPathSpec(id)?.kind === "input"
                          ? "Абсолютный путь к файлу обработки или отчёта (.epf, .erf)"
                          : "Второй путь",
                    ),
                }
              : {}),
            ...(scoped ? extensionArgs : {}),
            ...(id === "dump_config_to_files"
              ? {
                  refresh: tool.schema
                    .boolean()
                    .optional()
                    .describe(
                      "Только если в каталоге уже есть выгрузка и нужна свежая: без него существующая " +
                        "выгрузка возвращается как есть. С ним выгрузка расширения делается целиком, а основной " +
                        "конфигурации — только объекты со сменившейся версией. Правка контейнера побайтово " +
                        "(v8pack) версию не меняет: чтобы увидеть такую правку в основной конфигурации, " +
                        "выгружай в новый пустой каталог.",
                    ),
                }
              : {}),
            ...(id === "execute"
              ? {
                  user_supplied: tool.schema
                    .boolean()
                    .optional()
                    .describe("Только если пользователь сам назвал этот файл и просил его запустить."),
                }
              : {}),
          }
        : scoped
          ? extensionArgs
          : ({} as Record<string, never>),
      async execute(
        given: {
          path?: string
          epfPath?: string
          refresh?: boolean
          user_supplied?: boolean
          extension?: string
          extension_name?: string
        },
        ctx,
      ) {
        const args = { ...given, extension: given.extension?.trim() || given.extension_name?.trim() || undefined }
        noteSession(ctx.sessionID)
        // What an operation creates goes into the profile's working directory
        // (containment.ts). First, so the refusal names the right place rather
        // than a missing parent of the wrong one.
        if (EXTENSION_ONLY.has(id) && !args.extension) {
          return {
            title: definition.summary,
            output:
              "Отклонено: эта операция только для расширения — укажи его имя в `extension`. " +
              "Конфигуратор не запускался.",
          }
        }
        const outside = await outsideWorkingDirectory(ctx.sessionID, id, args)
        if (outside) {
          return { title: definition.summary, output: outside }
        }
        const startedAt = toolkitStartedAt.get(ctx.sessionID)
        if (needsExclusiveInfobase(id) && !UNGUARDED_BY_UNUSED_TOOLKIT.has(id) && startedAt !== undefined) {
          const gate = Date.now() - startedAt < TOOLKIT_UNUSED_MS ? await relay<ToolkitGate>("toolkit/gate", gateRequest(ctx.sessionID), 5_000) : undefined
          // Nothing listening (or no answer, or too long ago): nothing to protect.
          if (!gate || gate.port === "free") {
            toolkitStartedAt.delete(ctx.sessionID)
          } else {
            return {
              title: definition.summary,
              output:
                "Отклонено: MCP Toolkit запущен в этом сеансе и ещё не использован, а операция конфигуратора " +
                "его закроет — конфигуратор не запускался. Повтор не поможет: пока тулкит работает и не " +
                "использован, отказ повторится.\n" +
                // 2026-09-26, debrief14.md §14.5: the refusal came up to three times
                // in a row while the tools reconnected. The app connects them on its
                // toolkit poll (renderer/profiles/toolkit-link.ts, every 10 s).
                "Его инструменты (1c_execute_code, 1c_execute_query и другие) появляются в списке через 10–20 " +
                "секунд после запуска. Если их ещё нет — подожди (в оболочке `Start-Sleep -Seconds 15`) и " +
                "сделай то, ради чего его запускал. Порядок на будущее: сначала все операции " +
                "конфигуратора (загрузка, обновление, проверка), потом 1c_toolkit_start, потом проверки в базе.",
            }
          }
        }
        // 2026-09-25, debrief13.md §13.8: after one unscoped update and its
        // notice, the agent sent `{}` six more times -- each a configurator run
        // that changed nothing. The first unscoped update may be meant; a repeat
        // while the same extensions are pending is not, and does not start.
        const stillPending = unappliedExtensions.get(ctx.sessionID)
        if (
          id === "update_db" &&
          !args.extension?.trim() &&
          stillPending?.size &&
          unscopedUpdateDone.has(ctx.sessionID)
        ) {
          const calls = [...stillPending].map((name) => `1c_update_db({"extension": "${name}"})`).join("\n")
          return {
            title: definition.summary,
            output:
              "Отклонено: основная конфигурация уже обновлена, повтор без extension ничего не изменит — " +
              `конфигуратор не запускался. Не применены расширения: ${[...stillPending].join(", ")}. ` +
              `Передай имя в аргументе extension:\n${calls}`,
          }
        }
        // Before the permission ask, deliberately: a path that cannot work is
        // not a decision for the user to make, and prompting for one trains
        // them to approve without reading. Before exec() too -- the whole
        // point is that no process starts. See checkPath's note.
        const badPath = checkPath(id, args.path, diskProbe)
        if (badPath) {
          return { title: definition.summary, output: badPath }
        }
        const badSecond = checkSecondPath(id, args.epfPath, diskProbe)
        if (badSecond) {
          return { title: definition.summary, output: badSecond }
        }

        // T6. Whatever an operation creates stays out of the system temp.
        const kind = pathSpec(id)?.kind
        if (args.path && (kind === "output" || kind === "directory") && insideTemp(args.path)) {
          return { title: definition.summary, output: tempRefusal(args.path) }
        }

        // G3. A dump already in the directory is the answer; a second one is
        // minutes of configurator time and happens only when asked for.
        const earlier = id === "dump_config_to_files" && args.path ? existingDump(args.path, dumpProbe) : null
        if (earlier && !args.refresh) {
          return { title: definition.summary, output: describeExistingDump(earlier) }
        }
        // G3, widened (dumps.ts): a dump of the same configuration beside the
        // base or in the working directory. `refresh` counts only once the
        // agent has been shown that dump -- the call that started the whole
        // configuration again carried `refresh: true` into an empty directory.
        if (id === "dump_config_to_files" && !earlier && !args.extension?.trim()) {
          const profile = await sessionProfile(ctx.sessionID)
          const infobase = profile?.infobase?.trim()
          const parents = [
            profile?.workingDirectory ?? "",
            infobase && isAbsolutePath(infobase) ? dirname(infobase.replace(/[\\/]+$/, "")) : "",
          ]
          const nearby = dumpNearby(parents, dumpProbe, profile?.configuration?.name)
          const shown = shownDumps.get(ctx.sessionID) ?? new Set<string>()
          if (nearby && !(args.refresh && shown.has(nearby.root))) {
            shownDumps.set(ctx.sessionID, shown.add(nearby.root))
            return { title: definition.summary, output: describeExistingDump(nearby, Date.now(), true) }
          }
        }

        // G4. The launcher is for the processing just built; anything else has
        // to be declared as the user's, and the declaration goes into the ask.
        if (id === "execute" && args.path) {
          const refusal = provenanceRefusal(args.path.trim(), {
            modifiedMs: dumpProbe.mtimeMs(args.path.trim()),
            sessionStartedMs: sessionStarted.get(ctx.sessionID) ?? Date.now(),
            userSupplied: args.user_supplied === true,
          })
          if (refusal) return { title: definition.summary, output: refusal }
        }

        // debrief14.md §14.5 (load-check.ts): a form element with a misspelt tag
        // is dropped without a word, and the load still says «успешно».
        const formTags =
          id === "load_config_from_files" || id === "load_epf_from_files" ? formTagFindings(args.path) : []
        const tagRefusal = formTagRefusal(formTags)
        if (tagRefusal) return { title: definition.summary, output: tagRefusal }
        // Same file, same reason: a command whose module has no handler loads,
        // shows in its section, and does nothing when clicked.
        const commands = id === "load_config_from_files" ? commandModuleFindings(args.path) : []
        const commandRefusal = commandModuleRefusal(commands)
        if (commandRefusal) return { title: definition.summary, output: commandRefusal }
        // The platform's XDTO error names only the file; an undeclared prefix is found here with its name.
        const prefixes =
          id === "load_config_from_files" || id === "load_epf_from_files" ? prefixRefusal(prefixFindings(args.path)) : null
        if (prefixes) return { title: definition.summary, output: prefixes }

        // 2026-09-29, debrief16.md §16.3: a report root built to `X.epf` landed in
        // `X.epf.erf` -- the platform appends the extension of what the root
        // describes -- while the result said «успешно» and X.epf stayed the old file.
        const rootKind = id === "load_epf_from_files" && args.path ? externalKind(dumpProbe.readText(args.path.trim()) ?? "") : null
        const wanted = rootKind ? EXTERNAL_EXTENSIONS[rootKind] : null
        if (wanted && args.epfPath && !args.epfPath.trim().toLowerCase().endsWith(wanted)) {
          const fixed = args.epfPath.trim().replace(/\.(epf|erf)$/i, wanted)
          return {
            title: definition.summary,
            output:
              `Отклонено: корень ${args.path} описывает ${rootKind === "report" ? "внешний отчёт" : "внешнюю обработку"}, ` +
              `а целевой файл — не ${wanted}. Платформа сама допишет ${wanted} и соберёт в другой файл, а этот ` +
              `останется прежним. Конфигуратор не запускался. Укажи epfPath: "${fixed}" — файла может ещё не быть.`,
          }
        }
        const targetBefore = id === "load_epf_from_files" && args.epfPath ? dumpProbe.mtimeMs(args.epfPath.trim()) : null

        // The profile's standing permission replaces the ask, not the other checks.
        if (writesToInfobase(id) && !(await writesWithoutAsking(ctx.sessionID))) {
          // The gate. Denial throws out of here, so nothing below runs and the
          // relay is never called -- which is the behaviour Phase 5 asked for:
          // an unwanted write to live business data is far harder to undo than
          // a bad file edit, so the user decides, every time.
          await ctx.ask({
            permission: "infobase_write",
            patterns: [id],
            // No "always" pattern is offered on purpose. This class is
            // always-ask; letting it be granted permanently would quietly
            // convert it into one of the classes it was separated from.
            always: [],
            metadata: {
              operation: id,
              summary: definition.summary,
              path: args.path ?? null,
              ...(args.user_supplied
                ? { userSupplied: "обработку назвал пользователь; в этом сеансе она не собиралась" }
                : {}),
            },
          })
        }

        // Before the build reads the source, not after: a report that arrives
        // after the build costs a second DESIGNER launch to act on.
        const bindings =
          id === "load_epf_from_files"
            ? bindFormsBeforeBuild(args.path)
            : id === "load_config_from_files"
              ? bindFormsBeforeBuild(args.path, true)
              : null

        const response = await exec({
          conversationId: `session:${ctx.sessionID}`,
          operation: id,
          path: args.path,
          ...(args.epfPath ? { secondPath: args.epfPath } : {}),
          // 2026-09-25, debrief13.md: `-update` decides by the version stamps in
          // ConfigDumpInfo.xml, and a container edited byte-wise (v8pack) keeps
          // its stamps -- the refresh returned the old module while a clean dump
          // had the new one. An extension dumps in seconds, so it is always
          // dumped whole; the main configuration keeps `-update` for its speed.
          ...(earlier && !args.extension?.trim() ? { update: true } : {}),
          ...(args.extension?.trim() ? { extension: args.extension.trim() } : {}),
          permitted: writesToInfobase(id) ? true : undefined,
        })

        // 2026-09-25, observed live. A built .epf whose form module had a correct
        // `ПриСозданииНаСервере` that `Form.xml` never bound: dead code, a form
        // that opens and does nothing, and no check that could see it -- the
        // procedure compiles and creating the form succeeds precisely BECAUSE
        // nothing is wired. The source files are on disk at exactly this moment,
        // which is the only moment the two can be compared.
        // Both halves of the same question, at the two moments it can be asked.
        //
        // 2026-09-25, observed live: the binder at build time prevents the defect,
        // and prevention is useless to an agent handed a broken .epf -- it
        // inspects the artefact, it does not rebuild it. That session unpacked the
        // container, read the module, checked the descriptor GUIDs and probed the
        // runtime, and never compared Form.xml against Module.bsl. A dump gives
        // exactly that pair, so the diagnosis is reported where the files appear.
        //
        // `ok` says the relay ran the configurator, not that it succeeded: a run
        // that exits 1 comes back `ok: true`. 2026-09-26, debrief14.md §14.5: a
        // rejected extension load was answered «загружено… вызови 1c_update_db»
        // and the empty-extension warning never showed.
        const succeeded = response.ok && response.exitCode === 0
        const dropped = succeeded && LOADS.has(id) ? droppedParts(response.output ?? "") : []
        const partial = dropped.length > 0 ? partialLoadNote(dropped) : null
        const tagWarning = succeeded ? formTagWarning(formTags) : null
        // The platform names only the file. For a composition schema the base
        // itself can say where -- debrief14.md §14.5, four loads to bisect one.
        const xdtoSchema = succeeded ? null : /Исключение XDTO[^\n]*?([^\s"]*Template\.xml)/i.exec(response.output ?? "")?.[1]
        const xdtoHint = xdtoSchema
          ? `Платформа назвала только файл. Если это схема компоновки, 1c_check_dcs с path: "${xdtoSchema}" ` +
            "назовёт шаг и ошибку без новой загрузки."
          : null
        const commandWarning = succeeded ? commandModuleWarning(commands) : null
        const stillWrong =
          (id === "load_epf_from_files" || id === "dump_epf_to_files") && succeeded
            ? formBindingReport(args.path)
            : id === "load_config_from_files" && succeeded
              ? formBindingReport(args.path, true)
              : null
        // 2026-09-26, debrief14.md §14.3.1: a failed load from files still leaves
        // an empty extension of that name in the base (verified on a scratch base).
        // debrief15.md §15.5: the root descriptor was looked for beside `path`.
        // Name the file the platform actually wrote.
        const rootNote =
          id === "dump_epf_to_files" && succeeded && args.path
            ? (() => {
                const roots = (dumpProbe.list(args.path) ?? []).filter(
                  (name) => /\.xml$/i.test(name) && dumpProbe.list(join(args.path!, name.replace(/\.xml$/i, ""))) !== null,
                )
                return roots.length
                  ? `\nКорневой файл выгрузки: ${roots.map((name) => join(args.path!, name)).join(", ")} — его передавай в ` +
                      "1c_load_epf_from_files как `path`."
                  : null
              })()
            : null
        const targetAfter = id === "load_epf_from_files" && succeeded && args.epfPath ? dumpProbe.mtimeMs(args.epfPath.trim()) : null
        const notBuilt =
          id === "load_epf_from_files" && succeeded && args.epfPath && (targetAfter === null || targetAfter === targetBefore)
            ? (() => {
                const target = args.epfPath!.trim()
                const elsewhere = [".erf", ".epf"].map((ext) => target + ext).filter((path) => dumpProbe.mtimeMs(path) !== null)
                return (
                  `
ВНИМАНИЕ: конфигуратор ответил «успешно», но ${target} ${targetAfter === null ? "не появился" : "не изменился"}.` +
                  (elsewhere.length ? ` Платформа записала сборку в ${elsewhere.join(", ")} — переименуй в файл с нужным расширением.` : "")
                )
              })()
            : null
        const built =
          id === "load_epf_from_files" && succeeded && !notBuilt && rootKind
            ? `
Собран ${rootKind === "report" ? "внешний отчёт" : "внешняя обработка"}: ${args.epfPath!.trim()}. ` +
              (rootKind === "report"
                ? "Сформируй его, как сформирует пользователь: 1c_run_report."
                : "Проверь компиляцию модулей и форм: 1c_check_epf.")
            : null
        const leftBehind =
          id === "load_config_from_files" && !succeeded
            ? `\nЗагрузка не прошла, но расширение ${args.extension} могло уже появиться в базе — пустым. ` +
              "Исправь файлы по сообщению выше и загрузи снова (загрузка заменит расширение целиком) или " +
              `удали его: 1c_delete_extension с extension: "${args.extension}".`
            : null
        // 2026-09-25, debrief13.md: the load succeeded, update_db followed
        // without `extension` -- twice, each «успешно» -- and the base kept
        // running the old extension while the agent re-ran the same runtime
        // check. Both ends of the pair say what the other one needs.
        const extensionName = args.extension?.trim()
        const pending = unappliedExtensions.get(ctx.sessionID) ?? new Set<string>()
        const isLoad = id === "load_config" || id === "load_config_from_files"
        if (succeeded && isLoad && extensionName) pending.add(extensionName)
        if (succeeded && (id === "update_db" || id === "delete_extension") && extensionName) pending.delete(extensionName)
        unappliedExtensions.set(ctx.sessionID, pending)
        if (succeeded && id === "update_db" && !extensionName && pending.size > 0)
          unscopedUpdateDone.add(ctx.sessionID)
        if (succeeded && isLoad) unscopedUpdateDone.delete(ctx.sessionID)
        const applyNext =
          isLoad && extensionName && succeeded
            ? `\nРасширение ${extensionName} загружено, но база исполняет прежнюю версию, пока не вызван ` +
              `1c_update_db с extension: "${extensionName}". Проверять — в сеансе, начатом после этого.`
            : id === "update_db" && !extensionName && succeeded && pending.size > 0
              ? `\nОбновлена только основная конфигурация. Загруженные в этом сеансе расширения в базе ` +
                `не применены: ${[...pending].join(", ")}. Для каждого вызови 1c_update_db с его extension.`
              : null
        return {
          title: definition.summary,
          output: [partial, describe(response), notBuilt, built, bindings, stillWrong, tagWarning, commandWarning, rootNote, applyNext, leftBehind, xdtoHint]
            .filter(Boolean)
            .join("\n"),
        }
      },
    })
  }

  interface ToolkitStartResponse {
    ok: boolean
    reason?: string
    detail?: string
    port?: number
    state?: string
  }

  const TOOLKIT_REFUSALS: Record<string, string> = {
    "no-conversation": "Не удалось определить сеанс.",
    "no-profile": REFUSALS["no-profile"]!,
    "profile-missing": REFUSALS["profile-missing"]!,
    "no-toolkit":
      "Файл MCP_Toolkit.epf не найден нигде, даже в поставке приложения: установка повреждена. " +
      "Скажи пользователю переустановить 1CCoder; искать или скачивать файл самому не нужно.",
    "port-taken":
      "Порт уже занят другим экземпляром. Выясни, к какой базе он подключён " +
      "(СтрокаСоединенияИнформационнойБазы), прежде чем что-то делать.",
    "launch-failed": "Не удалось запустить платформу 1С.",
    timeout:
      "Платформа запущена, но порт не ответил за отведённое время. Процесс 1С оставлен работать: повторный " +
      "1c_toolkit_start продолжит ждать его, а не откроет второй.",
    // debrief15.md §15.2: the user's call is that the agent closes such windows
    // itself (1c_close_dialog). What it cannot close -- missing rights, a login,
    // a question about data -- still goes to the user.
    dialog:
      "1С запустилась, но показала окно, и оно блокирует сеанс — поэтому тулкит не открылся. Текст окна " +
      "ниже, прочитан с экрана. Если окно ничего не решает — закрой его сам: 1c_close_dialog с PID и кнопкой " +
      "(обычно «Закрыть»), затем снова 1c_toolkit_start: он продолжит ждать уже запущенный процесс. Если " +
      "закрытием его не снять — нет прав, нужен вход, вопрос о данных, — перескажи окно пользователю и скажи, " +
      "что нужно сделать. Настройки базы, чтобы окно не появлялось, не меняй.",
    // D2. Says what to do, because the agent CAN act on this one: the previous
    // operation's own result arrives when it finishes, and starting the toolkit
    // then is safe. Starting it now would put a thick client on a base the
    // configurator is holding.
    "designer-busy":
      "Сейчас работает операция конфигуратора, она держит базу монопольно — тулкит поднимать нельзя. " +
      "Дождись результата той операции и вызови 1c_toolkit_start снова. " +
      "И не отправляй операцию конфигуратора и вызов 1c_* в одном шаге: первая закрывает базу, " +
      "которая нужна второму.",
  }

  const toolkitStartTool = tool({
    description:
      "Открыть MCP Toolkit для информационной базы этого сеанса. Вызывай, когда задача требует " +
      "данных или кода 1С, а инструментов 1c_execute_query, 1c_execute_code и других 1c_* нет в " +
      "списке: они появляются только вместе с работающим тулкитом. Открывает окно 1С, поэтому " +
      "без необходимости не вызывай. Возврат управления не означает, что инструменты уже готовы.",
    args: {} as Record<string, never>,
    async execute(_args: Record<string, never>, ctx) {
      if (!baseUrl) {
        return { title: "Запуск MCP Toolkit", output: "Адрес сервиса 1CCoder не передан." }
      }
      const response = await fetch(`${baseUrl}/1c/toolkit/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: `session:${ctx.sessionID}` }),
      })
      if (!response.ok) {
        return { title: "Запуск MCP Toolkit", output: `Не удалось запустить: ответ ${response.status}` }
      }
      const result = (await response.json()) as ToolkitStartResponse
      if (!result.ok) {
        const message = TOOLKIT_REFUSALS[result.reason ?? ""] ?? "Не удалось открыть MCP Toolkit."
        return {
          title: "Запуск MCP Toolkit",
          output: result.detail ? `${message}\n\n${result.detail}` : message,
        }
      }
      // The instruction that matters is the prohibition, not the good news.
      // "The tools will appear in a few seconds" reads as an invitation to wait
      // for them inside this turn, and an agent cannot: its tool list is fixed
      // when the step begins. One did try, the call was not parsed, its markup
      // ended up in the reply, and the turn stopped dead.
      toolkitStartedAt.set(ctx.sessionID, Date.now())
      const waiting =
        // debrief16.md §16.3 item 10: twice a call before the tools appeared came
        // back as «unavailable tool» and the turn went on -- the waste is the step.
        "Инструменты 1c_* появятся в твоём списке через 10–20 секунд. **Не вызывай их, пока не увидишь в " +
        "списке** — такой вызов вернёт ошибку и потратит шаг. Продолжай пока другую работу, а если без базы " +
        "продолжать нечем — подожди в оболочке (`Start-Sleep -Seconds 15`). Повторно запускать не надо. " +
        // 2026-09-25, debrief13.md: started, then closed at once by 1c_check_config.
        "Любая операция конфигуратора (проверка, выгрузка, загрузка, обновление БД) снова закроет тулкит. " +
        // 2026-09-29, debrief15.md §15.20: on calc every hidden session exited
        // after about 5 minutes, and runs spent that window reading before the
        // print they had started the toolkit for.
        "Окно работы тулкита может оказаться коротким: платформа иногда сама закрывает такой сеанс через " +
        "несколько минут. Когда инструменты появятся, первым вызовом сделай то, ради чего тулкит поднят " +
        "(печать, проверку), а изучение базы — после."
      return {
        title: "Запуск MCP Toolkit",
        output:
          result.state === "running"
            ? `MCP Toolkit работает, порт ${result.port}. ${waiting}`
            : `1С запускается — это занимает десятки секунд. ${waiting}`,
      }
    },
  })

  const profileInfoTool = tool({
    description:
      "Профиль сеанса: имя, путь к платформе 1С, информационная база, пользователь, рабочий каталог " +
      "и состояние MCP Toolkit. Ничего не запускает и не меняет. Вызывай это вместо поиска платформы " +
      "и базы по файловой системе.",
    args: {} as Record<string, never>,
    async execute(_args: Record<string, never>, ctx) {
      if (!baseUrl) {
        return { title: "Профиль сеанса", output: "Адрес сервиса 1CCoder не передан." }
      }
      const response = await fetch(`${baseUrl}/1c/profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: `session:${ctx.sessionID}` }),
      })
      if (!response.ok) {
        return { title: "Профиль сеанса", output: `Не удалось получить профиль: ответ ${response.status}` }
      }
      return {
        title: "Профиль сеанса",
        output: describeProfileResponse((await response.json()) as ProfileResponse),
      }
    },
  })

  // 2026-09-23, debrief9.md §9.8 / G7. A plugin tool rather than a skill script,
  // because two runs of two show the difference: this agent calls tools and
  // skips prose pointers to them. It answers the one question the live object
  // model cannot -- which rows belong to a vertical merge, and therefore look
  // free while writing into them destroys the cell above.
  /**
   * Handler wiring of every form in an .epf source tree, or null when it is sound.
   *
   * The operation's `path` is the description file (`<dir>/<Name>.xml`), and the
   * platform puts the forms beside it under `<dir>/<Name>/Forms/<Form>/Ext/`.
   * A tree that does not look like that yields nothing rather than an error: the
   * build already succeeded, and a check that cannot read the source must stay
   * quiet rather than invent a problem.
   */
  /**
   * The forms of an .epf source tree, from either shape of path.
   *
   * `load_epf_from_files` names the description file (`<dir>/<Name>.xml`) and
   * `dump_epf_to_files` names the output directory, which then holds that same
   * `<Name>.xml` beside a `<Name>/` folder. Both lead to `<root>/Forms/<Form>/Ext`.
   */
  function subdirectories(target: string): string[] {
    try {
      return readdirSync(target, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(target, entry.name))
    } catch {
      return []
    }
  }

  function formsOf(target: string | undefined, tree = false): readonly { name: string; ext: string }[] {
    if (!target) return []
    // A configuration tree is one level deeper than a processing:
    // `Documents/<Объект>/Forms/<Форма>/Ext`, so each kind directory is walked.
    // A common form is its own object: `CommonForms/<Форма>/Ext`, with the same
    // Form.xml and Form/Module.bsl below it (checked on the БП and КА dumps). debrief14.md §14.7.
    if (tree) {
      return subdirectories(target).flatMap((kind) =>
        /[\\/]CommonForms$/i.test(kind)
          ? subdirectories(kind).map((form) => ({ name: form.split(/[\\/]/).at(-1) ?? form, ext: join(form, "Ext") }))
          : formsOf(kind),
      )
    }
    const roots = /\.xml$/i.test(target)
      ? [target.replace(/\.xml$/i, "")]
      : (() => {
          try {
            return readdirSync(target, { withFileTypes: true })
              .filter((entry) => entry.isDirectory())
              .map((entry) => join(target, entry.name))
          } catch {
            return []
          }
        })()
    return roots.flatMap((root) => {
      try {
        const formsDir = join(root, "Forms")
        if (!statSync(formsDir).isDirectory()) return []
        return readdirSync(formsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => ({ name: entry.name, ext: join(formsDir, entry.name, "Ext") }))
      } catch {
        return []
      }
    })
  }

  /**
   * Binds what can be bound, before the build reads the files.
   *
   * Reporting alone would still cost a rebuild, and a rebuild is a DESIGNER
   * launch that closes the toolkit and needs restarting -- minutes, for one line
   * of XML. Binding first means a single build produces a correct artefact.
   *
   * Writes the agent's own source file, so the result says exactly what changed;
   * a failure here is never allowed to stop the build.
   */
  function bindFormsBeforeBuild(descriptionPath: string | undefined, tree = false): string | null {
    const touched = formsOf(descriptionPath, tree).flatMap((form) => {
      try {
        const xmlPath = join(form.ext, "Form.xml")
        const result = bindFormEvents({
          xml: readFileSync(xmlPath, "utf8"),
          module: readFileSync(join(form.ext, "Form", "Module.bsl"), "utf8"),
        })
        if (!result.bound.length && !result.repaired.length) return []
        writeFileSync(xmlPath, result.xml, "utf8")
        return [{ form: `Forms/${form.name}`, bound: result.bound, repaired: result.repaired }]
      } catch {
        return []
      }
    })
    return describeBindings(touched)
  }

  /** Whatever binding is still wrong after the automatic pass -- items, arity, dangling names. */
  function formBindingReport(descriptionPath: string | undefined, tree = false): string | null {
    return describeFormBindings(
      formsOf(descriptionPath, tree).flatMap((form) => {
        try {
          return [
            {
              form: `Forms/${form.name}`,
              findings: inspectFormBindings({
                xml: readFileSync(join(form.ext, "Form.xml"), "utf8"),
                module: readFileSync(join(form.ext, "Form", "Module.bsl"), "utf8"),
              }),
            },
          ]
        } catch {
          return []
        }
      }),
    )
  }

  /**
   * The root and the default language of the base, dumped into `directory`, for
   * a new extension's facts. Reused when an earlier call left them there.
   * Returns the root, with a note on what it cost, or the reason it failed.
   *
   * Two runs because a listed name that doesn't exist fails the whole dump, and
   * the default language's name is known only from the root's Configuration.xml
   * (checked on a scratch base, 2026-09-27).
   */
  async function selectiveBaseDump(sessionID: string, directory: string): Promise<{ root: string; note?: string } | string> {
    const read = () => dumpProbe.readText(join(directory, "Configuration.xml")) ?? ""
    const language = () => /<DefaultLanguage>Language\.([^<]+)<\/DefaultLanguage>/.exec(read())?.[1]
    const hasLanguage = () => {
      const name = language()
      return name !== undefined && existsSync(join(directory, "Languages", `${name}.xml`))
    }
    if (hasLanguage()) return { root: directory }

    let toolkitStopped = false
    const run = async (objects: string[]) => {
      const response = await exec({
        conversationId: `session:${sessionID}`,
        operation: "dump_config_to_files",
        path: directory,
        objects,
      })
      toolkitStopped ||= response.toolkitStopped === true
      return response.ok && response.exitCode === 0 ? null : describe(response)
    }
    const failed = (await run(["Configuration"])) ?? (language() ? await run([`Language.${language()}`]) : null)
    if (failed) return `Выгрузка основной конфигурации базы не найдена, а выборочная выгрузка корня и языка не удалась:\n${failed}`
    if (!hasLanguage()) return "Выборочная выгрузка прошла, но основного языка конфигурации в ней нет. Укажи выгрузку базы в base_dump."
    return {
      root: directory,
      note:
        `Выгрузки базы не было — корень конфигурации и основной язык выгружены выборочно в ${directory} ` +
        `(два коротких запуска конфигуратора, около полуминуты каждый).${toolkitStopped ? " MCP Toolkit при этом был закрыт." : ""}`,
    }
  }

  // 2026-09-26, debrief14.md §14.3. The starting tree for a new extension. The
  // base-specific values (language uuid, format version, compatibility modes)
  // are read from the base's own dump -- they differ between configurations --
  // and nothing here touches the base.
  const newExtensionTool = tool({
    description:
      "Создать в рабочем каталоге заготовку нового расширения в XML: Configuration.xml и язык, " +
      "согласованные с базой профиля. Дальше в этот каталог добавляются объекты (в формате выгрузки), " +
      "и он загружается 1c_load_config_from_files. Базу не меняет.",
    args: {
      path: tool.schema.string().describe("Каталог заготовки — новый или пустой, в рабочем каталоге профиля"),
      name: tool.schema.string().describe("Имя расширения, например ПланыПродаж"),
      prefix: tool.schema.string().describe("Префикс имён собственных объектов расширения, например пп_"),
      synonym: tool.schema.string().optional().describe("Представление расширения для пользователя"),
      purpose: tool.schema
        .enum(["Customization", "AddOn", "Patch"])
        .optional()
        .describe("Назначение: Customization (адаптация, по умолчанию), AddOn (дополнение), Patch (исправление)"),
      base_dump: tool.schema
        .string()
        .optional()
        .describe("Корень выгрузки основной конфигурации базы; без него ищется рядом с базой и в рабочем каталоге"),
    },
    async execute(
      args: { path: string; name: string; prefix: string; synonym?: string; purpose?: ExtensionPurpose; base_dump?: string },
      ctx,
    ) {
      const title = `Заготовка расширения ${args.name}`
      const refuse = (output: string) => ({ title, output })
      if (!isMetadataName(args.name)) return refuse(`Недопустимое имя расширения: «${args.name}».`)
      if (!isMetadataName(args.prefix)) return refuse(`Недопустимый префикс: «${args.prefix}».`)
      const profile = await sessionProfile(ctx.sessionID)
      const workingDirectory = profile?.workingDirectory
      if (!workingDirectory) return refuse(REFUSALS["no-profile"] ?? "Профиль сеанса не определён.")
      const target = isAbsolutePath(args.path) ? args.path.trim() : join(workingDirectory, args.path.trim())
      if (!insideDirectory(target, workingDirectory)) return refuse(outsideWorkingRefusal(target, workingDirectory))
      if (existsSync(join(target, "Configuration.xml"))) {
        return refuse(`В ${target} уже есть Configuration.xml — заготовка не перезаписывает чужую работу. Выбери новый каталог.`)
      }
      const infobase = profile?.infobase?.trim()
      const dump = args.base_dump?.trim()
        ? { root: args.base_dump.trim() }
        : dumpNearby(
            [workingDirectory, infobase && isAbsolutePath(infobase) ? dirname(infobase.replace(/[\\/]+$/, "")) : ""],
            dumpProbe,
            profile?.configuration?.name,
          )
      // No dump: take the three facts from a selective dump of the root and the
      // default language -- two configurator runs of seconds each, instead of a
      // full dump that runs for many minutes (debrief14.md §14.7). It has no
      // ConfigDumpInfo.xml, so it is never offered as a dump of the base.
      const selective = dump ? null : await selectiveBaseDump(ctx.sessionID, join(workingDirectory, "base_facts"))
      if (typeof selective === "string") return refuse(selective)
      const root = dump?.root ?? selective?.root
      if (!root) return refuse("Не найдена выгрузка основной конфигурации базы. Укажи её в base_dump.")
      const facts = baseFactsFromDump(root, dumpProbe.readText)
      if (typeof facts === "string") return refuse(facts)
      const files = extensionSkeleton(facts, args)
      for (const [relative, content] of Object.entries(files)) {
        mkdirSync(dirname(join(target, relative)), { recursive: true })
        writeFileSync(join(target, relative), content, "utf8")
      }
      return {
        title,
        output: [
          `Заготовка создана: ${target}`,
          `Файлы: ${Object.keys(files).join(", ")}.`,
          ...(selective?.note ? [selective.note] : []),
          `Согласовано с выгрузкой ${root}: версия формата ${facts.formatVersion}, совместимость ` +
            `${facts.compatibilityMode}, язык ${facts.language.name}.`,
          "",
          "Дальше:",
          `1. Добавь объекты в формате выгрузки: файл объекта в каталоге вида (Enums/, Documents/, …) и строку в ` +
            "ChildObjects в Configuration.xml. Как пишется объект того же вида — смотри в выгрузке базы. " +
            `Имена собственных объектов — с префиксом ${args.prefix}.`,
          `2. 1c_load_config_from_files: path — этот каталог, extension: "${args.name}".`,
          `3. 1c_update_db с extension: "${args.name}".`,
          `4. Файл .cfe для передачи: 1c_dump_config с extension: "${args.name}" и путём *.cfe.`,
        ].join("\n"),
      }
    },
  })

  // 2026-09-29, debrief16.md §16.3 item 1 (external-skeleton.ts). Without a
  // starting tree an agent copied another task's .epf and then spent half an
  // hour looking for the report's class id on disk, in the plugin and in the
  // platform's DLLs.
  const newExternalTool = tool({
    description:
      "Создать в рабочем каталоге исходники новой внешней обработки (.epf) или внешнего отчёта (.erf) в XML — " +
      "корневой файл с верными идентификаторами классов, модуль объекта, а для отчёта — основную схему " +
      "компоновки (рабочий пример: набор, ресурс, обязательный параметр, группировка с вложенными детальными " +
      "записями, минимальная ширина колонки). Дальше правишь файлы и собираешь 1c_load_epf_from_files; " +
      "готовый контейнер копировать не нужно. С form: true у обработки сразу есть управляемая форма с командой " +
      "«Выполнить» и модулем — файлы формы с нуля не пиши. Базу не меняет.",
    args: {
      kind: tool.schema.enum(["processor", "report"]).describe("processor — обработка (.epf), report — отчёт (.erf)"),
      name: tool.schema.string().describe("Имя объекта в метаданных, например ВаловаяПрибыль"),
      path: tool.schema.string().describe("Каталог исходников в рабочем каталоге профиля — новый или пустой"),
      synonym: tool.schema.string().optional().describe("Представление для пользователя"),
      // debrief18.md §18.1: without it the agent wrote the form's files by hand.
      form: tool.schema
        .boolean()
        .optional()
        .describe("Только для processor: добавить форму «Форма» с командой «Выполнить» — если обработке нужен интерфейс"),
    },
    async execute(args: { kind: ExternalKind; name: string; path: string; synonym?: string; form?: boolean }, ctx) {
      const title = `Исходники ${args.kind === "report" ? "отчёта" : "обработки"} ${args.name}`
      const refuse = (output: string) => ({ title, output })
      if (!isMetadataName(args.name)) return refuse(`Недопустимое имя: «${args.name}».`)
      const workingDirectory = (await sessionProfile(ctx.sessionID))?.workingDirectory
      if (!workingDirectory) return refuse(REFUSALS["no-profile"] ?? "Профиль сеанса не определён.")
      const target = isAbsolutePath(args.path) ? args.path.trim() : join(workingDirectory, args.path.trim())
      if (!insideDirectory(target, workingDirectory)) return refuse(outsideWorkingRefusal(target, workingDirectory))
      if (existsSync(join(target, `${args.name}.xml`))) {
        return refuse(`В ${target} уже есть ${args.name}.xml — исходники не перезаписываются. Выбери новый каталог.`)
      }
      const files = externalSkeleton(args.kind, {
        name: args.name,
        ...(args.synonym ? { synonym: args.synonym } : {}),
        ...(args.form && args.kind === "processor" ? { form: true } : {}),
      })
      for (const [relative, content] of Object.entries(files)) {
        mkdirSync(dirname(join(target, relative)), { recursive: true })
        writeFileSync(join(target, relative), content, "utf8")
      }
      const root = join(target, `${args.name}.xml`)
      const built = join(target, `${args.name}${EXTERNAL_EXTENSIONS[args.kind]}`)
      const schema = join(target, args.name, "Templates", SCHEMA_TEMPLATE, "Ext", "Template.xml")
      return {
        title,
        output: [
          `Исходники созданы: ${target}`,
          `Файлы: ${Object.keys(files).join(", ")}.`,
          "",
          "Дальше:",
          ...(args.kind === "report"
            ? [
                `1. Замени пример в схеме ${schema} своим запросом, полями, ресурсами и вариантом; сохраняй форму ` +
                  "примера (как писать схему — навык 1ccoder-ib-reports).",
                `2. 1c_check_dcs с path: "${schema}" — до сборки.`,
                `3. 1c_load_epf_from_files: path "${root}", epfPath "${built}".`,
                "4. 1c_run_report — сформировать, как сформирует пользователь, и прочитать PDF.",
              ]
            : [
                `1. Код — в ${join(target, args.name, "Ext", "ObjectModule.bsl")}` +
                  (args.form
                    ? `; форма — ${join(target, args.name, "Forms", "Форма", "Ext", "Form.xml")} (элементы, реквизиты, ` +
                      `команды), её модуль — ${join(target, args.name, "Forms", "Форма", "Ext", "Form", "Module.bsl")}. ` +
                      "Новые элементы и реквизиты добавляй в Form.xml по образцу того, что там уже есть."
                    : ". Если нужна форма — создай исходники заново с form: true, а не пиши её файлы сам."),
                `2. 1c_load_epf_from_files: path "${root}", epfPath "${built}".`,
                "3. 1c_check_epf — компиляция модуля и форм.",
              ]),
        ].join("\n"),
      }
    },
  })

  // 2026-09-29, debrief16.md §16.3 item 4 (mcp/report-run.ts).
  const runReportTool = tool({
    description:
      "Сформировать внешний отчёт (.erf) так, как его сформирует пользователь: основная схема, вариант по " +
      "умолчанию, плюс только переданные параметры и отборы. Пишет PDF, MXL и текст ячеек в рабочий каталог и " +
      "говорит, какие параметры пусты при первом открытии, в каких колонках пустые ячейки и где текст шире " +
      "колонки. Прочитай PDF — так отчёт видно глазами. Один прогон проверяет один случай: меняй то, по чему " +
      "ветвится запрос (валюта, есть ли цена, характеристика, дата на границе изменения цены), и сверяй числа " +
      "с независимым запросом. Нужен работающий MCP Toolkit; только чтение.",
    args: {
      path: tool.schema.string().describe("Абсолютный путь к собранному .erf"),
      params: tool.schema
        .record(tool.schema.string(), tool.schema.string())
        .optional()
        .describe(
          "Параметры данных: имя → значение текстом. Элемент справочника — наименование или код, дата — " +
            "ГГГГ-ММ-ДД, стандартный период — «ГГГГ-ММ-ДД..ГГГГ-ММ-ДД», число — с точкой",
        ),
      filters: tool.schema
        .record(tool.schema.string(), tool.schema.string())
        .optional()
        .describe("Отборы: поле → значение текстом (элемент иерархического справочника отбирается «в иерархии»)"),
    },
    async execute(args: { path: string; params?: Record<string, string>; filters?: Record<string, string> }, ctx) {
      const title = "Формирование отчёта"
      const path = args.path.trim()
      if (!/\.erf$/i.test(path)) return { title, output: `Ожидается внешний отчёт .erf, получено: ${path}` }
      if (!dumpProbe.isFile(path)) return { title, output: `Файла нет: ${path}` }
      const workingDirectory = (await sessionProfile(ctx.sessionID))?.workingDirectory
      if (!workingDirectory) return { title, output: REFUSALS["no-profile"] ?? "Профиль сеанса не определён." }
      const runs = join(workingDirectory, "report_runs")
      mkdirSync(runs, { recursive: true })
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)
      const outBase = join(runs, `${path.replace(/^.*[\\/]/, "").replace(/\.erf$/i, "")}-${stamp}`)
      const result = await relay<{ ok: boolean; text?: string; reason?: string; detail?: string }>(
        "run-report",
        { conversationId: `session:${ctx.sessionID}`, path, params: args.params ?? {}, filters: args.filters ?? {}, outBase },
        330_000,
      )
      if (!result) return { title, output: "Формирование отчёта не ответило." }
      if (result.ok) return { title, output: result.text ?? "" }
      const reason =
        {
          "toolkit-down": "Отчёт сформировать нельзя: MCP Toolkit не работает — подними его через 1c_toolkit_start и повтори.",
          "designer-busy": "Отчёт сформировать нельзя: идёт операция конфигуратора. Дождись её и повтори.",
          "other-infobase": "На порту тулкита работает другая информационная база — формировать в ней нельзя.",
          "no-profile": REFUSALS["no-profile"],
        }[result.reason ?? ""] ?? "Отчёт сформировать не удалось."
      return { title, output: `${reason}${result.detail ? `\n\n${result.detail}` : ""}` }
    },
  })

  const mxlInfoTool = tool({
    description:
      "Структура макета из выгрузки конфигурации (Template.xml): именованные области с границами " +
      "в нумерации 1С, высоты строк, параметры ячеек и — главное — объединения по вертикали, " +
      "из-за которых строка выглядит свободной, не будучи ею. Вызывай ДО правки строки в " +
      "поставляемом макете. Только чтение файла, базу не трогает.",
    args: {
      path: tool.schema
        .string()
        .describe(
          "Путь к Template.xml макета в выгрузке, например ...\\\\cfg\\\\CommonTemplates\\\\<Имя>\\\\Ext\\\\Template.xml",
        ),
      area: tool.schema
        .string()
        .optional()
        .describe("Имя области — тогда строки показываются только по ней. Без него: все области и все строки."),
    },
    async execute(args: { path: string; area?: string }) {
      const title = `Макет: ${args.path.split(/[\\/]/).slice(-3).join("\\")}`
      const xml = (() => {
        try {
          return readFileSync(args.path, "utf8")
        } catch (error) {
          return error instanceof Error ? new Error(error.message) : new Error(String(error))
        }
      })()
      if (xml instanceof Error) {
        return {
          title,
          output:
            `Не удалось прочитать файл: ${xml.message}\n\n` +
            "Нужен именно Template.xml из выгрузки конфигурации (1c_dump_config_to_files), " +
            "а не .mxl и не сам макет из базы.",
        }
      }
      const template = parseMxlTemplate(xml)
      if (!template.rows.length && !template.areas.length) {
        return {
          title,
          output: "Файл прочитан, но структуры макета в нём нет — это не Template.xml табличного документа.",
        }
      }
      return { title, output: describeMxlTemplate(template, args.area) }
    },
  })

  // debrief15.md §15.12 (mxl-edit.ts): a variant of a standard form is the
  // standard template with a few cells changed, not a new grid.
  // debrief15.md §15.24 item 31 (sample-check.ts): the comparison with the
  // sample is a table handed in, and registration waits for it.
  const sampleChecks = new Map<string, SampleCheck>()
  const modifiedAt = (path: string) => {
    try {
      return statSync(path).mtimeMs
    } catch {
      return null
    }
  }

  // debrief15.md §15.24 item 34 (dump-object.ts): nine calls of PowerShell
  // XML parsing for one document's attributes, while the toolkit was down.
  const dumpObjectTool = tool({
    description:
      "Состав объекта конфигурации из её выгрузки: реквизиты с типами, табличные части, измерения и ресурсы " +
      "регистров, значения перечислений, формы, макеты, команды и модули с путями. Работает без тулкита. " +
      "Вызывай вместо разбора XML выгрузки в оболочке.",
    args: {
      object: tool.schema.string().describe("Вид и имя: Документ.ПриемНаРаботу, Справочник.Сотрудники, РегистрСведений.…"),
      dump: tool.schema
        .string()
        .optional()
        .describe("Корень выгрузки (где Configuration.xml); без него — выгрузка базы профиля"),
    },
    async execute(args: { object: string; dump?: string }, ctx) {
      const title = `Состав ${args.object}`
      const profile = await sessionProfile(ctx.sessionID)
      const infobase = profile?.infobase?.trim()
      const root =
        args.dump?.trim() ||
        dumpNearby(
          [profile?.workingDirectory ?? "", infobase && isAbsolutePath(infobase) ? dirname(infobase.replace(/[\\/]+$/, "")) : ""],
          dumpProbe,
          profile?.configuration?.name,
        )?.root
      if (!root) return { title, output: "Выгрузка конфигурации базы не найдена. Укажи её корень в dump." }
      return {
        title,
        output: describeDumpObject(root, args.object, {
          readText: dumpProbe.readText,
          list: (dir) => {
            try {
              return readdirSync(dir)
            } catch {
              return null
            }
          },
        }),
      }
    },
  })

  const compareWithSampleTool = tool({
    description:
      "Сверка печатной формы с образцом, поле за полем. Вызывай после печати текущей сборки в PDF и до " +
      "регистрации обработки: регистрация без сверки текущей сборки не выполнится. В fields — каждое поле " +
      "образца сверху вниз: шапка, каждое значение, каждая надпись, каждая пустая строка для записи от руки. " +
      "Поле — то, что подписано в образце: у каждой мелкой подписи под линией своя строка, даже если в " +
      "типовом макете две подписи стоят под одной линией. " +
      "sample — что в образце (пусто — «пусто»; вписанное ручкой — так и напиши: «от руки: …»), print — что " +
      "в твоём PDF, match — совпало ли по виду и смыслу, reason — для несовпавшего: что исправишь или почему " +
      "остаётся так. Таблица из ответа входит в итоговый отчёт.",
    args: {
      sample: tool.schema.string().describe("Файл образца (картинка или PDF); без образца — файл задания"),
      print: tool.schema.string().describe("PDF печати текущей сборки"),
      epf: tool.schema.string().describe("Файл собранной обработки, которую печатал"),
      fields: tool.schema
        .array(
          tool.schema.object({
            field: tool.schema.string().describe("Какое поле: «дата ознакомления», «характер работы»"),
            sample: tool.schema.string().describe("Что в образце"),
            print: tool.schema.string().describe("Что в печати"),
            match: tool.schema.boolean(),
            reason: tool.schema.string().optional().describe("Для несовпавшего: что исправишь или почему так"),
          }),
        )
        .describe("Каждое поле образца"),
    },
    async execute(args: { sample: string; print: string; epf: string; fields: SampleField[] }, ctx) {
      const title = "Сверка с образцом"
      const result = checkComparison(args, modifiedAt)
      if (!result.ok) return { title, output: result.error }
      sampleChecks.set(ctx.sessionID, result.check)
      const differing = result.check.rows.filter((row) => !row.match).length
      return {
        title,
        output:
          `${result.report}\n\n` +
          (differing
            ? "Каждое отличие — исправь (и сверь новую печать заново) или оставь с причиной и перенеси в отчёт. "
            : "") +
          "Сверка записана для этой сборки: её можно регистрировать. Пересборка потребует новой сверки. " +
          "Эту таблицу включи в итоговый отчёт.",
      }
    },
  })

  const mxlEditTool = tool({
    description:
      "Изменить макет (Template.xml) на месте. Координаты — строка и колонка в нумерации 1С, как их показывает " +
      "1c_mxl_info. Для печатной формы по образцу, похожему на типовую, — скопируй Template.xml типового макета " +
      "в свою обработку и поменяй только отличия.\n" +
      "Что умеет (в одном вызове — сколько угодно правок, применяются по порядку, всё или ничего):\n" +
      "- ячейка: text, template (текст с [Параметр]), parameter или clear;\n" +
      "- новая ячейка: create: true, формат можно взять у другой: like {row, column};\n" +
      "- оформление ячейки: style {bold, size, underline, align, wrap} — underline рисует линию под ячейкой, " +
      "как у полей для заполнения;\n" +
      "- объединение: merge {row, column, rows, columns} — левая верхняя ячейка и размер; то же объединение с " +
      "тем же углом меняет размер. unmerge {row, column} — разъединить.\n" +
      "- объединение колонок (1c_mxl_info: «Объединения колонок») действует во всех строках: внутри него печатается " +
      "только его первая колонка. unmerge_columns {row, column, rows} отменяет его в rows строках начиная с row.\n" +
      "Разделить одну ячейку на две: unmerge, два merge, create для второй. Строк не добавляет. " +
      "Правит только файлы в рабочем каталоге.",
    args: {
      path: tool.schema.string().describe("Template.xml макета в рабочем каталоге"),
      edits: tool.schema
        .array(
          tool.schema.object({
            row: tool.schema.number().optional().describe("Строка ячейки, с 1, как в 1c_mxl_info"),
            column: tool.schema.number().optional().describe("Колонка ячейки, с 1"),
            text: tool.schema.string().optional().describe("Постоянный текст ячейки"),
            template: tool.schema.string().optional().describe("Текст с [Параметр] внутри"),
            parameter: tool.schema.string().optional().describe("Имя параметра — значение подставляет код"),
            clear: tool.schema.boolean().optional().describe("Очистить ячейку"),
            create: tool.schema.boolean().optional().describe("Создать ячейку, если её в строке нет"),
            like: tool.schema
              .object({ row: tool.schema.number(), column: tool.schema.number() })
              .optional()
              .describe("Для новой ячейки: взять формат этой"),
            style: tool.schema
              .object({
                bold: tool.schema.boolean().optional(),
                size: tool.schema.number().optional().describe("Размер шрифта, например 8.3"),
                underline: tool.schema.boolean().optional().describe("Линия под ячейкой"),
                align: tool.schema.enum(["Left", "Center", "Right"]).optional(),
                wrap: tool.schema.boolean().optional().describe("Перенос по словам"),
              })
              .optional()
              .describe("Оформление ячейки; незаданное не меняется"),
            merge: tool.schema
              .object({
                row: tool.schema.number(),
                column: tool.schema.number(),
                rows: tool.schema.number(),
                columns: tool.schema.number(),
              })
              .optional()
              .describe("Объединить: левая верхняя ячейка и размер в ячейках"),
            unmerge: tool.schema
              .object({ row: tool.schema.number(), column: tool.schema.number() })
              .optional()
              .describe("Разъединить объединение с этой левой верхней ячейкой"),
            unmerge_columns: tool.schema
              .object({
                row: tool.schema.number().describe("Первая строка"),
                column: tool.schema.number().describe("Любая колонка объединения колонок"),
                rows: tool.schema.number().optional().describe("Сколько строк, по умолчанию 1"),
              })
              .optional()
              .describe("Отменить объединение колонок в этих строках"),
          }),
        )
        .describe(
          "Правки по порядку: в каждой — либо ячейка (row, column и что с ней), либо merge, либо unmerge, либо unmerge_columns",
        ),
    },
    async execute(
      args: {
        path: string
        edits: {
          row?: number
          column?: number
          text?: string
          template?: string
          parameter?: string
          clear?: boolean
          create?: boolean
          like?: { row: number; column: number }
          style?: MxlStyle
          merge?: { row: number; column: number; rows: number; columns: number }
          unmerge?: { row: number; column: number }
          unmerge_columns?: { row: number; column: number; rows?: number }
        }[]
      },
      ctx,
    ) {
      const title = `Правка макета: ${args.path.split(/[\\/]/).slice(-4).join("\\")}`
      const workingDirectory = (await sessionProfile(ctx.sessionID))?.workingDirectory
      if (!workingDirectory) return { title, output: REFUSALS["no-profile"] ?? "Профиль сеанса не определён." }
      const path = isAbsolutePath(args.path) ? args.path.trim() : join(workingDirectory, args.path.trim())
      if (!insideDirectory(path, workingDirectory)) return { title, output: outsideWorkingRefusal(path, workingDirectory) }
      const edits: MxlEdit[] = []
      for (const [index, edit] of args.edits.entries()) {
        const cell = edit.row !== undefined || edit.column !== undefined
        const kinds = [cell, edit.merge !== undefined, edit.unmerge !== undefined, edit.unmerge_columns !== undefined]
        if (kinds.filter(Boolean).length !== 1) {
          return {
            title,
            output: `Правка ${index + 1}: нужна ровно одна — ячейка (row и column), merge, unmerge или unmerge_columns.`,
          }
        }
        if (edit.merge) edits.push({ merge: edit.merge })
        else if (edit.unmerge) edits.push({ unmerge: edit.unmerge })
        else if (edit.unmerge_columns) edits.push({ unmerge_columns: edit.unmerge_columns })
        else if (edit.row === undefined || edit.column === undefined) {
          return { title, output: `Правка ${index + 1}: у ячейки нужны и row, и column.` }
        } else {
          edits.push({
            row: edit.row,
            column: edit.column,
            ...(edit.text !== undefined ? { text: edit.text } : {}),
            ...(edit.template !== undefined ? { template: edit.template } : {}),
            ...(edit.parameter !== undefined ? { parameter: edit.parameter } : {}),
            ...(edit.clear ? { clear: true as const } : {}),
            ...(edit.create ? { create: true } : {}),
            ...(edit.like ? { like: edit.like } : {}),
            ...(edit.style ? { style: edit.style } : {}),
          })
        }
      }
      let xml: string
      try {
        xml = readFileSync(path, "utf8")
      } catch (error) {
        return { title, output: `Не удалось прочитать файл: ${error instanceof Error ? error.message : String(error)}` }
      }
      const result = editMxlCells(xml, edits)
      if (!result.ok) return { title, output: `Макет не изменён. ${result.error}` }
      writeFileSync(path, result.xml, "utf8")
      return {
        title,
        output: [
          `Изменено (${path}):`,
          ...result.changes.map((change) => `- ${change}`),
          "",
          "Проверено после правки: строки и области те же, объединения — ровно заказанные, двух ячеек в одной " +
            "колонке нет. Как это выглядит, покажет только печать: дальше — сборка из XML и PDF рядом с образцом.",
        ].join("\n"),
      }
    },
  })

  // 2026-09-25, skills_rebuild_plan.md Part 2.5. The print-forms skill used to
  // assert which БСП objects exist; they differ by БСП version, so the base
  // answers instead, as a tool result.
  const PRINT_REFUSALS: Record<string, string> = {
    "no-profile": REFUSALS["no-profile"] ?? "У сеанса нет профиля.",
    "profile-missing": REFUSALS["profile-missing"] ?? "Профиль сеанса не найден.",
    "toolkit-down": "MCP Toolkit не работает — подними его через 1c_toolkit_start и повтори.",
    "other-infobase":
      "На порту тулкита работает другая информационная база, не база профиля. Ничего не выполняй в ней; " +
      "скажи пользователю, какая база там открыта.",
    unreadable: "Тулкит ответил, но не в ожидаемом виде.",
    failed: "Тулкит не ответил на запрос.",
  }

  const printCapabilitiesTool = tool({
    description:
      "Что эта база предлагает для печатных форм: есть ли МакетыПечатныхФорм, ПользовательскиеМакетыПечати, " +
      "ДополнительныеОтчетыИОбработки, УправлениеПечатью, сколько уже пользовательских макетов, версия БСП. " +
      "С `dump` — ещё и какие функции УправлениеПечатью экспортные. Вызывай ДО выбора механизма печатной " +
      "формы. Только чтение, базу не меняет; нужен работающий MCP Toolkit.",
    args: {
      dump: tool.schema
        .string()
        .optional()
        .describe("Каталог выгрузки конфигурации (где лежит Configuration.xml), если она есть"),
    },
    async execute(args: { dump?: string }, ctx) {
      const title = "Печатные формы: возможности базы"
      if (!baseUrl) return { title, output: "Адрес сервиса 1CCoder не передан." }
      const response = await fetch(`${baseUrl}/1c/print-capabilities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: `session:${ctx.sessionID}`, dump: args.dump }),
      })
      if (!response.ok) return { title, output: `Не удалось спросить базу: ответ ${response.status}` }
      const result = (await response.json()) as { ok: boolean; text?: string; reason?: string; detail?: string }
      if (result.ok) return { title, output: result.text ?? "" }
      return {
        title,
        output: `${PRINT_REFUSALS[result.reason ?? ""] ?? "Не удалось."}${result.detail ? `\n\n${result.detail}` : ""}`,
      }
    },
  })

  // G6, debrief9.md §9.5. The tool that can ask, because a before-hook cannot.
  // It does not execute anything: it puts scale and scope in front of the user,
  // and on approval lets exactly this code through `1c_execute_code` once. That
  // keeps execution where it already works and gives the plugin the one thing it
  // was missing, which is the decision.
  const writeCodeTool = tool({
    description:
      "Получить у пользователя разрешение на запись в информационную базу. Вызывай, когда " +
      "`1c_execute_code` отказал: тот же код, плюс что именно меняется, сколько объектов и каких " +
      "организаций это касается. Сам ничего не выполняет — после разрешения повтори вызов " +
      "`1c_execute_code` с тем же кодом.",
    args: {
      code: tool.schema.string().describe("Тот же код BSL, который отказался выполнять 1c_execute_code"),
      summary: tool.schema.string().describe("Что и зачем меняется — по-русски, одной-двумя фразами"),
      objects: tool.schema.string().describe("Что будет записано, например «Документ.<Имя>» или «Справочник.<Имя>»"),
      count: tool.schema.number().describe("Сколько объектов будет затронуто. Узнай запросом ДО записи, не угадывай"),
      organisations: tool.schema
        .string()
        .describe("Каких организаций это касается. Если всех — так и напиши; если реквизита нет — «не применимо»"),
      allow_overwrite: tool.schema
        .boolean()
        .optional()
        .describe(
          "Только если код меняет СУЩЕСТВУЮЩИЙ элемент справочника, а не добавляет новый. " +
            "По умолчанию такая правка отклоняется: сначала создай новый элемент и переключи на него " +
            "значение по умолчанию у организации.",
        ),
    },
    async execute(
      args: {
        code: string
        summary: string
        objects: string
        count: number
        organisations: string
        allow_overwrite?: boolean
      },
      ctx,
    ) {
      const title = "Запись в информационную базу"
      // Every answer below sends the agent to `1c_execute_code`, which exists
      // only while the toolkit runs -- see executeCodeUnavailable.
      const sendOn = async (text: string) => {
        const down = executeCodeUnavailable(await relay<ToolkitGate>("toolkit/gate", gateRequest(ctx.sessionID), 5_000))
        return { title, output: down ? `${text}\n\n${down}` : text }
      }
      const unchecked = registrationRefusal(args.code, sampleChecks.get(ctx.sessionID), modifiedAt)
      if (unchecked) return { title, output: unchecked }
      if (await writesWithoutAsking(ctx.sessionID)) {
        return sendOn(
          "Подтверждение не нужно: пользователь разрешил в профиле запись в эту базу без вопросов. " +
            "Выполняй код через `1c_execute_code`. Объём и охват записи назови в итоговом отчёте.",
        )
      }
      // debrief15.md §15.3: an approval given back after a call that never
      // reached the base is still valid -- asking again would be a second
      // question for one decision.
      if (hasApproval(ctx.sessionID, args.code)) {
        return sendOn(
          "Разрешение на этот код уже есть: прошлый вызов до базы не дошёл, и разрешение сохранено. " +
            "Выполняй через `1c_execute_code` с тем же кодом.",
        )
      }
      const gap = missingFacts(args)
      if (gap) return { title, output: gap }

      const write = inspectBaseWrite(args.code)
      if (!write.writes) {
        return sendOn(
          "В этом коде записи в базу не видно — разрешение не нужно, выполняй через `1c_execute_code`.\n" +
            "Если запись всё-таки есть, значит я её не распознал: напиши об этом пользователю.",
        )
      }

      // Third occurrence of F9's second half (09-20, 09-21, 09-23). The agent
      // has to say out loud that it is changing something it did not create,
      // because all three times it believed it was doing the tidy thing.
      const overwrite = inspectOverwrite(args.code)
      if (overwrite.overwrites && !args.allow_overwrite) {
        return { title, output: overwriteRefusal(overwrite) }
      }

      const bulk = inspectBulkWrite(args.code)
      // Denial throws out of here, so nothing below runs and no approval is
      // recorded -- the same contract the DESIGNER operations use.
      await ctx.ask({
        permission: "infobase_write",
        patterns: ["1c_write_code"],
        // Always-ask, like every other write to live business data. A permanent
        // grant here would recreate exactly the silence this closes.
        always: [],
        metadata: {
          operation: "write_code",
          summary: writeAskText(args, bulk.refuse ? bulkRefusal(bulk) : undefined, overwrite.elements),
          objects: args.objects,
          count: args.count,
          organisations: args.organisations,
          overwrites: overwrite.elements,
        },
      })

      recordApproval(ctx.sessionID, args.code)
      approvedRequests.set(approvalKey(ctx.sessionID, args.code), {
        summary: args.summary,
        objects: args.objects,
        count: args.count,
        organisations: args.organisations,
        ...(overwrite.elements.length ? { overwrites: overwrite.elements } : {}),
      })
      return sendOn(
        `Пользователь разрешил запись: ${args.objects}, объектов ${args.count}, организации: ${args.organisations}.\n\n` +
          "Теперь вызови `1c_execute_code` с **тем же кодом** — разрешение одноразовое и действует " +
          "только на него. После записи проверь результат запросом и включи и объём, и охват в итоговый отчёт.",
      )
    },
  })

  // T1, failures_to_tools.md. Replaces a recipe the agent had to reassemble
  // from a skill each time, and adds the check nothing performed: whether the
  // built file is the build at all (epf-identity.ts).
  const checkEpfTool = tool({
    description:
      "Проверить собранную внешнюю обработку (.epf): что это действительно новая сборка, а не заготовка, " +
      "из которой собирали, и что компилируются модуль объекта и КАЖДАЯ форма. Сборка конфигуратором " +
      "модули не компилирует, запуск через ВнешниеОбработки.Создать проверяет только модуль объекта. " +
      "Формы создаются без показа окна (ПриСозданииНаСервере выполняется). Вызывай после каждой сборки, " +
      "прежде чем говорить, что обработка готова. Нужен работающий MCP Toolkit.",
    args: {
      path: tool.schema.string().describe("Абсолютный путь к собранному .epf"),
      expect_name: tool.schema
        .string()
        .optional()
        .describe("Имя обработки в метаданных, которое должно получиться, если ты его задавал"),
      template: tool.schema
        .string()
        .optional()
        .describe("Файл, из которого собирали (скопированная заготовка), — сборка не должна с ним совпадать"),
    },
    async execute(args: { path: string; expect_name?: string; template?: string }, ctx) {
      const title = "Проверка обработки"
      const path = args.path.trim()
      const bytes = (() => {
        try {
          return readFileSync(path)
        } catch {
          return null
        }
      })()
      if (!bytes) return { title, output: `Файла нет: ${path}` }

      const build = fingerprint(bytes)
      const references = [
        ...templateFingerprints(),
        ...(args.template?.trim() && args.template.trim() !== path
          ? (() => {
              try {
                return [{ label: args.template.trim(), fingerprint: fingerprint(readFileSync(args.template.trim())) }]
              } catch {
                return []
              }
            })()
          : []),
      ]
      const identity = compareIdentity(build, references)
      const identityText = describeIdentity(path, build, identity)
      if (identity.sameAs) return { title, output: identityText }

      const checked = await relay<{ ok: boolean; text?: string; reason?: string; detail?: string }>(
        "check-epf",
        {
          conversationId: `session:${ctx.sessionID}`,
          path,
          ...(args.expect_name ? { expectName: args.expect_name } : {}),
        },
        150_000,
      )
      const compile = !checked
        ? "Проверка компиляции не ответила."
        : checked.ok
          ? (checked.text ?? "")
          : `${
              {
                "toolkit-down":
                  "Компиляцию проверить нельзя: MCP Toolkit не работает — подними его через 1c_toolkit_start и повтори.",
                "designer-busy": "Компиляцию проверить нельзя: идёт операция конфигуратора. Дождись её и повтори.",
                "other-infobase": "На порту тулкита работает другая информационная база — проверять в ней нельзя.",
                "no-profile": REFUSALS["no-profile"],
              }[checked.reason ?? ""] ?? "Компиляцию проверить не удалось."
            }${checked.detail ? `\n\n${checked.detail}` : ""}`
      return { title, output: `${identityText}\n\n${compile}` }
    },
  })

  // debrief14.md §14.5 (mcp/dcs-check.ts): a schema fixed through four rounds
  // of load, update and run, each ending in one runtime error.
  const checkDcsTool = tool({
    description:
      "Проверить схему компоновки данных (Template.xml макета СКД) в базе сеанса, не загружая её: читается ли " +
      "схема, верны ли запросы наборов данных, собирается ли макет (параметры, поля настроек), " +
      "инициализируется ли процессор (выражения; запросы выполняются, только чтение). Называет шаг и ошибку. " +
      "Вызывай перед загрузкой каждой новой или изменённой схемы, а не узнавай ошибки запуском отчёта. " +
      "Объекты самого расширения запрос увидит только после его загрузки и применения. Нужен работающий MCP Toolkit.",
    args: {
      path: tool.schema.string().describe("Абсолютный путь к Template.xml схемы компоновки"),
    },
    async execute(args: { path: string }, ctx) {
      const title = "Проверка схемы компоновки"
      const path = args.path.trim()
      const text = (() => {
        try {
          return readFileSync(path, "utf8")
        } catch {
          return null
        }
      })()
      if (text === null) return { title, output: `Файла нет: ${path}` }
      if (!/<DataCompositionSchema[\s>]/.test(text)) {
        return { title, output: `${path} — не схема компоновки данных: в нём нет корневого элемента DataCompositionSchema.` }
      }
      const checked = await relay<{ ok: boolean; text?: string; reason?: string; detail?: string }>(
        "check-dcs",
        { conversationId: `session:${ctx.sessionID}`, path },
        150_000,
      )
      if (!checked) return { title, output: "Проверка схемы не ответила." }
      if (checked.ok) return { title, output: checked.text ?? "" }
      const reason =
        {
          "toolkit-down": "Схему проверить нельзя: MCP Toolkit не работает — подними его через 1c_toolkit_start и повтори.",
          "designer-busy": "Схему проверить нельзя: идёт операция конфигуратора. Дождись её и повтори.",
          "other-infobase": "На порту тулкита работает другая информационная база — проверять в ней нельзя.",
          "no-profile": REFUSALS["no-profile"],
        }[checked.reason ?? ""] ?? "Схему проверить не удалось."
      return { title, output: `${reason}${checked.detail ? `\n\n${checked.detail}` : ""}` }
    },
  })

  // T5, failures_to_tools.md.
  const processesTool = tool({
    description:
      "Процессы 1С, открытые на базе этого сеанса: кто запустил (приложение или пользователь), режим, что " +
      "запущено, заголовок окна. Вызывай, когда MCP Toolkit перестал отвечать после запуска обработки или " +
      "конфигуратора, — чтобы назвать пользователю окно, а не гадать. С `close` закрывает процесс, но только " +
      "запущенный приложением; окна пользователя не трогает.",
    args: {
      close: tool.schema.number().optional().describe("PID процесса, запущенного приложением, который нужно закрыть"),
    },
    async execute(args: { close?: number }, ctx) {
      const title = "Процессы 1С"
      if (args.close !== undefined) {
        await ctx.ask({
          permission: "1c_process_close",
          patterns: [String(args.close)],
          always: [],
          metadata: { pid: args.close, summary: `Закрыть процесс 1С ${args.close}, запущенный приложением` },
        })
      }
      const answer = await relay<{ ok: boolean; text?: string; reason?: string; detail?: string }>(
        "processes",
        { conversationId: `session:${ctx.sessionID}`, ...(args.close !== undefined ? { close: args.close } : {}) },
        45_000,
      )
      if (!answer) return { title, output: "Приложение не ответило." }
      if (answer.ok) return { title, output: answer.text ?? "" }
      const reasons: Record<string, string> = {
        "not-found": "Такого процесса 1С на базе этого сеанса нет — вызови без `close` и возьми PID из списка.",
        "not-ours": "Этот процесс открыт пользователем, не приложением — закрывать его нельзя. Попроси пользователя.",
        "no-profile": REFUSALS["no-profile"] ?? "",
        failed: "Не удалось получить список процессов.",
      }
      return {
        title,
        output: `${reasons[answer.reason ?? ""] ?? "Не удалось."}${answer.detail ? `\n\n${answer.detail}` : ""}`,
      }
    },
  })

  // debrief15.md §15.2 (mcp/processes.ts closeDialog): the agent closes the
  // windows that block a 1C session, instead of restarting into them.
  const closeDialogTool = tool({
    description:
      "Нажать кнопку в окне-диалоге 1С, которое блокирует сеанс (его показывает 1c_processes): " +
      "по PID процесса и названию кнопки, без мыши и фокуса. Только в процессах, запущенных приложением. " +
      "Для окна, которое ничего не решает, — «Закрыть». Возвращает, свободен ли сеанс после этого.",
    args: {
      pid: tool.schema.number().describe("PID процесса 1С из 1c_processes"),
      button: tool.schema.string().describe("Название кнопки, как его показал 1c_processes, например «Закрыть»"),
    },
    async execute(args: { pid: number; button: string }, ctx) {
      const title = `Окно 1С: «${args.button}»`
      const answer = await relay<{ ok: boolean; text?: string; reason?: string; detail?: string }>(
        "close-dialog",
        { conversationId: `session:${ctx.sessionID}`, pid: args.pid, button: args.button },
        45_000,
      )
      if (!answer) return { title, output: "Приложение не ответило." }
      if (answer.ok) return { title, output: answer.text ?? "" }
      const reasons: Record<string, string> = {
        "not-found": "Такого процесса 1С на базе этого сеанса нет — возьми PID из 1c_processes.",
        "not-ours": "Этот процесс открыт пользователем — его окна не трогай, попроси пользователя.",
        "no-button": "Такой кнопки в окнах этого процесса нет. Что там есть:",
        "no-profile": REFUSALS["no-profile"] ?? "",
        failed: "Нажать не удалось.",
        "still-open": "Окно не закрылось.",
      }
      return {
        title,
        output: `${reasons[answer.reason ?? ""] ?? "Не удалось."}${answer.detail ? `\n\n${answer.detail}` : ""}`,
      }
    },
  })

  // T4, failures_to_tools.md.
  const sessionWritesTool = tool({
    description:
      "Все записи в информационную базу за этот сеанс: что, сколько объектов, каких организаций, чем " +
      "закончилось. Ведётся приложением при каждой разрешённой записи. Вызывай перед итоговым отчётом — " +
      "разделы «Что сделано» и «Как откатить» составляй по этому списку, а не по памяти.",
    args: {} as Record<string, never>,
    async execute(_args: Record<string, never>, ctx) {
      const title = "Записи в базу за сеанс"
      const profile = await sessionProfile(ctx.sessionID)
      if (!profile?.workingDirectory) return { title, output: REFUSALS["no-profile"] ?? "" }
      const path = journalPath(profile.workingDirectory)
      const text = supportProbe.readText(path) ?? ""
      return { title, output: describeJournal(readJournal(text, ctx.sessionID), path) }
    },
  })

  // Layer 2 of debrief14.md §14.4 (auto-resume.ts): a turn that ended in an
  // error nobody has to decide about is resumed, with a budget, visibly.
  // `resumeDelaysMs` exists for tests; the defaults are auto-resume.ts's.
  const resumeBudget = new ResumeBudget(
    Date.now,
    Array.isArray(options?.resumeDelaysMs) ? (options.resumeDelaysMs as number[]) : undefined,
  )
  const resumeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const exhaustedNoticeAt = new Map<string, number>()

  async function resumeSession(sessionID: string, attempt: number, error: SessionErrorLike): Promise<void> {
    const client = input?.client
    if (!client) return
    const messages = ((await client.session.messages({ path: { id: sessionID } }).catch(() => undefined))?.data ??
      []) as unknown as MessageLike[]
    // Somebody has taken over, or the agent was waiting on them: not ours to resume.
    if (userSpokeAfterFailure(messages) || awaitsHuman(messages)) return
    const statuses = (await client.session.status().catch(() => undefined))?.data as
      | Record<string, { type?: string }>
      | undefined
    if (statuses?.[sessionID]?.type && statuses[sessionID]!.type !== "idle") return
    const last = messages.findLast((message) => message.info.role === "assistant")?.info as
      | { mode?: string; providerID?: string; modelID?: string }
      | undefined
    resumeBudget.record(sessionID)
    // debrief15.md §15.22: every resume is logged, so a loop of them shows.
    const why = error.announced !== undefined ? `announced a step and stopped: ${error.announced}` : String(error.data?.message ?? error.name ?? "")
    await client.app
      ?.log({
        body: {
          service: "1ccoder-resume",
          level: "info",
          message: `session ${sessionID}: resume ${attempt}/${RESUME_LIMIT} (${why.slice(0, 200)})`,
          // The server writes `message` and `extra`, not `service`: without this
          // the line can't be found by name (debrief15.md §15.28).
          extra: { service: "1ccoder-resume" },
        },
      })
      .catch(() => undefined)
    await client.session
      .promptAsync({
        path: { id: sessionID },
        body: {
          ...(last?.mode ? { agent: last.mode } : {}),
          ...(last?.providerID && last.modelID ? { model: { providerID: last.providerID, modelID: last.modelID } } : {}),
          parts: [{ type: "text", text: resumeText(attempt, error) }],
        },
      })
      .catch(() => undefined)
  }

  /** Resumes a session after the budget's pause, or says once that the budget is spent. */
  async function scheduleResume(sessionID: string, reason: SessionErrorLike): Promise<void> {
    const client = input?.client
    if (!client || resumeTimers.has(sessionID)) return
    // A sub-agent's session belongs to its parent's turn; resuming it alone
    // would run work nobody is waiting for.
    const session = (await client.session.get({ path: { id: sessionID } }).catch(() => undefined))?.data
    if (!session || session.parentID) return
    const next = resumeBudget.next(sessionID)
    if (!next) {
      const noticed = exhaustedNoticeAt.get(sessionID) ?? 0
      if (Date.now() - noticed < RESUME_WINDOW_MS) return
      exhaustedNoticeAt.set(sessionID, Date.now())
      await client.session
        .promptAsync({ path: { id: sessionID }, body: { noReply: true, parts: [{ type: "text", text: exhaustedText(reason) }] } })
        .catch(() => undefined)
      return
    }
    resumeTimers.set(
      sessionID,
      setTimeout(() => {
        void resumeSession(sessionID, next.attempt, reason).finally(() => resumeTimers.delete(sessionID))
      }, next.delayMs),
    )
  }

  // debrief14.md §14.6 (agent-routing.ts). The sidecar's agents are fixed for
  // its lifetime, so one successful read is enough.
  let registeredAgents: Set<string> | undefined
  async function agentNames(): Promise<Set<string> | undefined> {
    if (registeredAgents) return registeredAgents
    const list = (await input?.client?.app.agents().catch(() => undefined))?.data
    if (Array.isArray(list)) registeredAgents = new Set(list.map((agent) => agent.name))
    return registeredAgents
  }

  async function logRouting(level: "info" | "warn", message: string): Promise<void> {
    await input?.client?.app
      .log({ body: { service: "1ccoder-routing", level, message, extra: { service: "1ccoder-routing" } } })
      .catch(() => undefined)
  }

  const hooks: Awaited<ReturnType<Plugin>> = {
    // The agent is decided here, not by whoever sent the prompt -- see
    // agent-routing.ts. opencode runs the turn as the stored message's agent
    // and records it on the session after this hook.
    "chat.message": async (message, output) => {
      const binding = await sessionBinding(message.sessionID)
      const decision = routeAgent(output.message.agent ?? message.agent, binding, await agentNames())
      if (decision.kind === "switch") {
        output.message.agent = decision.to
        await logRouting("info", `session ${message.sessionID}: ${decision.from} -> ${decision.to}`)
      } else if (decision.kind === "missing") {
        await logRouting(
          "warn",
          `session ${message.sessionID}: binding calls for ${decision.wanted}, which is not registered; running as ${decision.from}`,
        )
      }
    },
    event: async ({ event }) => {
      // debrief15.md §15.3: a toolkit call that threw gets no `tool.execute.after`
      // -- its error arrives only as the part's state. An error that means the
      // request was never sent gives the spent approval back.
      if (event.type === "message.part.updated") {
        const part = (event.properties as { part?: { type?: string; callID?: string; state?: { status?: string; error?: unknown } } })
          .part
        const spent = part?.type === "tool" && part.callID ? spentApprovals.get(part.callID) : undefined
        if (!spent || !part?.callID || (part.state?.status !== "error" && part.state?.status !== "completed")) return
        spentApprovals.delete(part.callID)
        if (part.state.status !== "error" || !NEVER_SENT.test(String(part.state.error ?? ""))) return
        recordApproval(spent.sessionID, spent.code)
        if (spent.approved) approvedRequests.set(approvalKey(spent.sessionID, spent.code), spent.approved)
        const inFlight = writesInFlight.get(part.callID)
        if (inFlight) {
          writesInFlight.delete(part.callID)
          await journal(inFlight, {
            kind: "finished",
            callID: part.callID,
            at: new Date().toISOString(),
            failed: true,
            result: `не дошло до базы (${String(part.state.error).slice(0, 200)}); разрешение восстановлено`,
          })
        }
        return
      }
      const client = input?.client
      if (!client) return
      if (event.type === "session.error") {
        const error = event.properties.error as SessionErrorLike | undefined
        if (!event.properties.sessionID || !classifyError(error).resume) return
        await scheduleResume(event.properties.sessionID, error ?? {})
        return
      }
      // Layer 3: the turn ended without an error, on an empty answer mid-work,
      // or on an announcement of its next step with no call (debrief15.md §15.22).
      if (event.type === "session.idle") {
        const sessionID = event.properties.sessionID
        if (resumeTimers.has(sessionID)) return
        const messages = ((await client.session.messages({ path: { id: sessionID } }).catch(() => undefined))?.data ??
          []) as unknown as MessageLike[]
        if (endedEmpty(messages)) await scheduleResume(sessionID, EMPTY_ANSWER)
        const announced = announcedStep(messages)
        if (announced !== null) await scheduleResume(sessionID, { announced })
      }
    },
    // T8, failures_to_tools.md. Only the copy the model sees is changed.
    "experimental.chat.messages.transform": async (_input, output) => {
      markUnansweredQuestion(output.messages as unknown as TransformMessage[])
    },
    "tool.execute.after": async (input, output) => {
      if (!isToolkitTool(input.tool, EXPECTED_PLUGIN_TOOLS)) return
      // The call came back with a result: it reached the base, and the approval stays spent.
      spentApprovals.delete(input.callID)

      // T4. The second half of a journalled write: what came back.
      const inFlight = writesInFlight.get(input.callID)
      if (inFlight) {
        writesInFlight.delete(input.callID)
        await journal(inFlight, {
          kind: "finished",
          callID: input.callID,
          at: new Date().toISOString(),
          failed: isFailure(output),
          result: resultText(output).slice(0, 2000),
        })
      }

      const masked = maskedNote(output)
      if (masked) appendToResult(output, masked)

      if (!isFailure(output)) return
      // Recorded before anything is appended, so the key is the error as the tool returned it.
      const repeats = repeated.record(input.sessionID, input.tool, input.args, output)
      // G8. The reference that answers a name error, named where it is read.
      const hint = referenceHint(output, input.args)
      if (hint) appendToResult(output, hint)
      if (repeats >= 2) appendToResult(output, REPEATED_FAILURE_NOTICE)
    },
    // 2026-09-21, debrief6.md §9 C5. The ladder's bottom rung is enforced here
    // rather than only described in the prompt, because a rule that competes
    // with the shortest path loses. Throwing is how a before-hook refuses: the
    // tool never runs, and the agent receives the message as a tool failure --
    // which debrief4.md §2.2 found is the one form of contradiction it acts on
    // immediately, as opposed to reasoning its way past.
    // T2, debrief9.md §9.7. Set before anything runs, so Python cannot reach
    // the ANSI codepage by default and report Cyrillic as a crash.
    "shell.env": async (_input, output) => {
      Object.assign(output.env, SHELL_ENV)
    },
    "tool.execute.before": async (input, output) => {
      noteSession(input.sessionID)
      // A `1c_*` tool this plugin does not define is the toolkit's: it is in use.
      if (input.tool.startsWith("1c_") && !ownTools.has(input.tool)) toolkitStartedAt.delete(input.sessionID)

      // G5. A toolkit that is certainly not there, or a base the configurator
      // holds, is said in words before the call can fail as `fetch failed`.
      // First, so a refused call does not consume a write approval.
      if (isToolkitTool(input.tool, EXPECTED_PLUGIN_TOOLS)) {
        const gate = await relay<ToolkitGate>("toolkit/gate", gateRequest(input.sessionID), 5_000)
        const refusal = gate ? gateRefusal(gate) : null
        if (refusal) throw new Error(refusal)
        const masked = maskedTokenRefusal(output.args)
        if (masked) throw new Error(masked)
      }

      // T2. The encoding fix needs no judgement, so it is applied to every
      // Windows shell command rather than asked for in prose -- the prose rule
      // was loaded and violated three times in one hour, and the fourth time it
      // produced a confident false conclusion about the product (§9.7).
      const command = commandFrom(input.tool, output.args)
      if (command) {
        const refusal = shellRefusal(command)
        if (refusal) throw new Error(refusal)
        const tempTarget = shellTempWrite(command)
        if (tempTarget) throw new Error(shellTempRefusal(tempTarget))
        const packed = v8packOutput(command)
        const workingDirectory = packed ? (await sessionProfile(input.sessionID))?.workingDirectory : undefined
        if (packed && workingDirectory && isAbsolutePath(packed) && !insideDirectory(packed, workingDirectory)) {
          throw new Error(outsideWorkingRefusal(packed, workingDirectory))
        }
        output.args.command = withEncoding(command)
      }

      // G6, debrief9.md §9.5. Every base write goes through a decision. D11's
      // bulk check is still made, but its verdict now travels INTO the ask as a
      // warning rather than ending the matter: twice a loop rewrote all 8 567
      // invoices, and the missing step both times was somebody being asked, not
      // a cleverer pattern.
      const bsl = bslFrom(input.tool, output.args)
      if (bsl) {
        const write = inspectBaseWrite(bsl)
        const unchecked = write.writes ? registrationRefusal(bsl, sampleChecks.get(input.sessionID), modifiedAt) : null
        if (unchecked) throw new Error(unchecked)
        // T4. Read before consuming: the approval's key is what finds the request.
        const approved = write.writes ? approvedRequests.get(approvalKey(input.sessionID, bsl)) : undefined
        if (write.writes && consumeApproval(input.sessionID, bsl)) {
          approvedRequests.delete(approvalKey(input.sessionID, bsl))
          spentApprovals.set(input.callID, { sessionID: input.sessionID, code: bsl, ...(approved ? { approved } : {}) })
          if (approved) {
            writesInFlight.set(input.callID, input.sessionID)
            await journal(input.sessionID, {
              kind: "started",
              callID: input.callID,
              sessionID: input.sessionID,
              at: new Date().toISOString(),
              ...approved,
            })
          }
        } else if (write.writes && (await writesWithoutAsking(input.sessionID))) {
          // The user's standing permission (profile.allowWriteWithoutConfirmation):
          // no ask and no refusal, but the write is still journalled, so
          // 1c_session_writes and the report's rollback section keep working.
          writesInFlight.set(input.callID, input.sessionID)
          // No approval call carries the scope here, so the journal takes what
          // the code names (debrief15.md §15.18).
          const targets = writeTargets(bsl)
          await journal(input.sessionID, {
            kind: "started",
            callID: input.callID,
            sessionID: input.sessionID,
            at: new Date().toISOString(),
            summary: "без подтверждения — разрешено в профиле",
            objects: targets.length ? `по коду: ${targets.join(", ")}` : "не указано (в коде не названы)",
            count: 0,
            organisations: "не указано",
          })
        } else if (write.writes) {
          // Changing an element it did not create is a different mistake from
          // writing without asking, and it has its own cheaper alternative, so
          // it gets its own message rather than a generic one.
          // An approval for nearly this code means the code changed after the
          // ask, not that nobody asked. Different mistake, different message.
          if (hasNearMissApproval(input.sessionID, bsl)) throw new Error(writeRefusal(write, undefined, true))
          // 2026-09-25, skills_rebuild_plan.md Part 2 step 6. The refusals are
          // written for any configuration; when the base runs one with a pack,
          // the pack's concrete route is appended. Looked up only here, on the
          // refusal path, so an ordinary call pays nothing for it.
          const overwrite = inspectOverwrite(bsl)
          if (overwrite.overwrites)
            throw new Error(overwriteRefusal(overwrite) + packHint(await sessionPack(input.sessionID), "overwrite"))
          const bulk = inspectBulkWrite(bsl)
          throw new Error(
            writeRefusal(write, bulk.refuse ? bulkRefusal(bulk) : undefined) +
              (bulk.refuse ? packHint(await sessionPack(input.sessionID), "bulk") : ""),
          )
        }
        // A write the user approved is a write the user approved, bulk or not.
        if (!write.writes) {
          const bulk = inspectBulkWrite(bsl)
          if (bulk.refuse) throw new Error(bulkRefusal(bulk) + packHint(await sessionPack(input.sessionID), "bulk"))
        }
      }

      const target = writeTarget(input.tool, output.args)
      if (!target) return
      // T6. Files the agent writes stay out of the system temp.
      if (insideTemp(target)) throw new Error(tempRefusal(target))
      // debrief15.md §15.4: the profile's dump is readable without an ask
      // (dump-dirs.ts), and opencode's permission can't tell reads from writes,
      // so writes into a dump outside the working directory are refused here.
      // A dump inside it (an extension being edited and loaded back) is work.
      const dumpRoot = insideDump(target)
      if (dumpRoot) {
        const workingDirectory = (await sessionProfile(input.sessionID))?.workingDirectory
        if (!workingDirectory || !insideDirectory(target, workingDirectory)) throw new Error(dumpWriteRefusal(target, dumpRoot))
      }
      const verdict = decideSupport(target, supportProbe)
      if (verdict.blocked) throw new Error(supportRefusal(verdict, target))
    },
    tool: {
      "1c_profile_info": profileInfoTool,
      "1c_toolkit_start": toolkitStartTool,
      "1c_mxl_info": mxlInfoTool,
      "1c_mxl_edit": mxlEditTool,
      "1c_compare_with_sample": compareWithSampleTool,
      "1c_dump_object": dumpObjectTool,
      "1c_print_capabilities": printCapabilitiesTool,
      "1c_write_code": writeCodeTool,
      "1c_check_epf": checkEpfTool,
      "1c_check_dcs": checkDcsTool,
      "1c_processes": processesTool,
      "1c_close_dialog": closeDialogTool,
      "1c_session_writes": sessionWritesTool,
      "1c_check_config": makeTool(
        "check",
        "Проверить конфигурацию информационной базы. Чтение, базу не меняет.",
        false,
      ),
      "1c_dump_config": makeTool(
        "dump_config",
        "Выгрузить конфигурацию информационной базы в файл .cf — двоичный контейнер, " +
          "пригодный только для загрузки обратно. Читать конфигурацию им нельзя: для этого " +
          "1c_dump_config_to_files. Чтение, базу не меняет.",
        true,
      ),
      // 2026-09-21, debrief6.md §8.1. Added because its absence was costing a
      // hand-rolled configurator launch through `bash` in every session that
      // needed to READ the configuration -- which is every session that touches
      // a макет, a module or a metadata object. The description says outright
      // what the .cf is not, because the failure was never "the agent could not
      // find the tool": it found `dump_config`, ran it, and only then
      // discovered the artefact was unreadable.
      "1c_dump_config_to_files": makeTool(
        "dump_config_to_files",
        "Выгрузить конфигурацию в XML-файлы в указанный каталог — то, что нужно, чтобы " +
          "ЧИТАТЬ конфигурацию: модули, макеты (`CommonTemplates\\<Имя>\\Ext\\Template.xml`), " +
          "формы, метаданные. Каталог создаётся, если его нет. Выгрузка большой конфигурации " +
          "занимает минуты и место на диске. Чтение, базу не меняет.",
        true,
      ),
      // 2026-09-23, debrief7.md §8.7 / D12. The two conventions are in the
      // descriptions because they cost ~70 minutes to establish by trial and
      // neither is guessable: the dump's root descriptor lands BESIDE the
      // directory, and the load UPDATES an existing container.
      "1c_dump_epf_to_files": makeTool(
        "dump_epf_to_files",
        "Выгрузить внешнюю обработку (.epf) в XML-файлы — единственный способ править РАЗМЕТКУ " +
          "формы: команды, кнопки, реквизиты, имя обработки. (Модули правятся дешевле, через " +
          "v8pack — см. навык 1ccoder-epf-editing.) `path` — каталог для выгрузки, `epfPath` — " +
          "исходный .epf. Внутри `path` появятся корневой файл `<ИмяОбработки>.xml` и каталог " +
          "`<ИмяОбработки>` рядом с ним; результат называет корневой файл. Чтение, базу не меняет.",
        true,
      ),
      "1c_load_epf_from_files": makeTool(
        "load_epf_from_files",
        // debrief16.md §16.3: the target is created when missing, and its extension
        // must be the root's -- the platform otherwise writes `<target>.erf`.
        "Собрать внешнюю обработку (.epf) или внешний отчёт (.erf) из XML-файлов. `path` — корневой файл " +
          "`<Имя>.xml` (из выгрузки или от 1c_new_external), `epfPath` — файл результата: .epf для обработки, " +
          ".erf для отчёта. Файла может ещё не быть — платформа создаст его; существующий она перезапишет. " +
          "После сборки обработки — 1c_check_epf (компиляция модуля и форм), отчёта — 1c_run_report. Базу не меняет.",
        true,
      ),
      "1c_load_config": makeTool(
        "load_config",
        "Загрузить конфигурацию из файла .cf в информационную базу. ИЗМЕНЯЕТ БАЗУ: потребуется подтверждение.",
        true,
      ),
      "1c_load_config_from_files": makeTool(
        "load_config_from_files",
        "Загрузить расширение из каталога XML (корень с Configuration.xml, как у выгрузки) — так создаётся " +
          "новое расширение и заменяется существующее целиком, включая удалённые объекты. Только для " +
          "расширений: `extension` обязателен. Каталог — в рабочем каталоге профиля; заготовку даёт " +
          "1c_new_extension. После загрузки — 1c_update_db с тем же extension. ИЗМЕНЯЕТ БАЗУ: " +
          "потребуется подтверждение.",
        true,
      ),
      "1c_delete_extension": makeTool(
        "delete_extension",
        "Удалить расширение из базы (`extension` обязателен). Нужен, в частности, после неудачной загрузки " +
          "из файлов: она всё равно создаёт пустое расширение с этим именем. ИЗМЕНЯЕТ БАЗУ: потребуется " +
          "подтверждение.",
        false,
      ),
      "1c_new_extension": newExtensionTool,
      "1c_new_external": newExternalTool,
      "1c_run_report": runReportTool,
      "1c_update_db": makeTool(
        "update_db",
        "Обновить конфигурацию базы данных. ИЗМЕНЯЕТ БАЗУ: потребуется подтверждение.",
        false,
      ),
      // Renamed from "1c_execute" on 2026-09-20. The old name was a strict
      // prefix of the toolkit's own "1c_execute_code" and "1c_execute_query",
      // and across three sessions the agent emitted "1c_execute" with a path
      // argument when its own reasoning said it meant one of those two --
      // including a five-hour loop that modal-blocked the base. See
      // debrief4.md §2.2. The operation id stays "execute"; only the tool
      // name changes, so nothing downstream of exec() is affected.
      "1c_run_epf": makeTool(
        "execute",
        "Выполнить внешнюю обработку (.epf) в информационной базе в режиме предприятия. " +
          "Только для .epf, который ты собрал сам и можешь назвать. Не инструмент для выполнения " +
          "кода 1С — для кода есть 1c_execute_code. ИЗМЕНЯЕТ БАЗУ: потребуется подтверждение.",
        true,
      ),
    },
  }
  for (const name of Object.keys(hooks.tool ?? {})) ownTools.add(name)
  return hooks
}

export default InfobasePlugin
