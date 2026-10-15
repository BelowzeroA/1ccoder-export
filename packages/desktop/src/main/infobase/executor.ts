// Running a 1C operation on behalf of a session.
//
// The agent never gets the credentials. It asks for an operation by name; this
// resolves the session's bound profile, decrypts the password, runs the
// platform and returns only the exit code and the log. The password stays in
// the main process, which is the whole reason the tool goes through here
// instead of building a command line itself.
//
// Two refusals are enforced here rather than trusted to the caller, because
// the caller is a plugin running inside the sidecar and a bug there must not
// become an unguarded write:
//
//   a conversation with no profile cannot run anything at all;
//   an operation that writes is refused unless the caller says the permission
//   was granted -- opencode's permission system is the authority, and this is
//   the second lock on the same door.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { configurationFromDump, type DumpReader, type InfobaseConfiguration } from "../profiles/configuration"
import { decodeConfigText } from "../profiles/v8i"
import type { ProfileStore } from "../profiles/profile-store"
import type { SessionBindingStore } from "../profiles/session-binding"
import type { ToolkitExitInfo } from "./toolkit-calls"
import { nodeVerifyDeps, type VerifyDeps } from "../profiles/verify"
import {
  buildArgs,
  connectionArg,
  isOperationId,
  needsExclusiveInfobase,
  operationTimeout,
  OPERATIONS,
  pathSpec,
  requiresPath,
  requiresSecondPath,
  type OperationId,
} from "./operations"

// Declared alongside the operation table, with the transport deadline that has
// to outlive it -- the two only make sense read together. Re-exported here
// because this is where callers have always found it.
export { OPERATION_TIMEOUT_MS } from "./operations"

export interface ExecRequest {
  readonly conversationId: string
  readonly operation: string
  readonly path?: string
  /** The second path, for the operations that take one (see requiresSecondPath). */
  readonly secondPath?: string
  /** For `dump_config_to_files` over an earlier dump: write only what changed. */
  readonly update?: boolean
  /** Scopes a configurator command to one extension (`-Extension <Имя>`). */
  readonly extension?: string
  /** For `dump_config_to_files`: dump only these objects (`-listFile`), e.g. `Configuration`, `Language.Русский`. */
  readonly objects?: readonly string[]
  /**
   * Whether the caller obtained permission for a write. The plugin sets this
   * only after ctx.ask() resolved; a write with it unset is refused.
   */
  readonly permitted?: boolean
}

export type ExecResult =
  | {
      readonly ok: true
      readonly exitCode: number | null
      readonly output: string
      readonly summary: string
      /** Set when the toolkit was closed to make room for this run. */
      readonly toolkitStopped?: boolean
      /** Set when the toolkit answered before this run and stopped answering after it. */
      readonly toolkitBlocked?: boolean
      /** With toolkitBlocked: the text of the modal windows now holding the base's sessions. */
      readonly blockingDialogs?: string
    }
  | {
      readonly ok: false
      readonly reason: ExecRefusal
      readonly detail?: string
      readonly toolkitStopped?: boolean
      readonly toolkitBlocked?: boolean
      readonly blockingDialogs?: string
      /** Set when the toolkit was closed for this run and then handed back. */
      readonly toolkitRestored?: boolean
    }

export type ExecRefusal =
  | "unknown-operation"
  | "path-required"
  /** The path was refused after the plugin's own check -- see the directory dump. */
  | "path-rejected"
  | "no-profile"
  | "profile-missing"
  | "not-permitted"
  | "launch-failed"
  | "timed-out"

export interface ExecutorDeps {
  readonly profiles: ProfileStore
  readonly bindings: SessionBindingStore
  readonly verify?: VerifyDeps
  /**
   * The live toolkit, when there is one to ask about and close.
   *
   * Optional so the executor stays testable without the supervisor, but in the
   * app it is always wired: without it a DESIGNER run cannot tell whether the
   * base is held, which is the situation that corrupted one.
   */
  readonly toolkit?: {
    readonly snapshot: () => Promise<ToolkitSnapshot>
    readonly stop: () => Promise<void>
    /**
     * Brings the toolkit back after it was closed for a DESIGNER run that then
     * never touched the base. Optional: the executor works without it and
     * simply leaves the toolkit down, which is the pre-2026-09-21 behaviour.
     */
    readonly start?: () => Promise<unknown>
    /**
     * The text of the modal dialogs on this base's 1C sessions, "" for none.
     * Asked only when the toolkit stopped answering after a run.
     */
    readonly dialogs?: () => Promise<string>
  }
  /** Reads a finished configuration dump; the filesystem unless a test supplies one. */
  readonly readDump?: DumpReader
}

const nodeDumpReader: DumpReader = {
  read: (path) => readFile(path, "utf8").catch(() => null),
}

/** Brings the toolkit back. Returns whether it was actually asked to start. */
async function restoreToolkit(toolkit: ExecutorDeps["toolkit"]): Promise<boolean> {
  if (!toolkit?.start) return false
  // Not awaited for readiness on purpose: starting 1C takes tens of seconds,
  // and the caller should get its answer now rather than after the toolkit is
  // up. A failure here must not turn a launch failure into a crash.
  try {
    await toolkit.start()
    return true
  } catch {
    return false
  }
}

/** Does the toolkit answer right now? Any failure counts as "no". */
async function toolkitAlive(toolkit: ExecutorDeps["toolkit"]): Promise<boolean> {
  if (!toolkit) return false
  const snapshot = await toolkit.snapshot().catch(() => undefined)
  return snapshot?.alive === true
}

/**
 * Closes the toolkit if it is holding the base, before a DESIGNER run.
 *
 * Stop rather than refuse, because refusing would be a dead end: there is no
 * agent-facing way to close the toolkit, so "stop it and retry" is advice the
 * agent cannot act on. Stopping is also the cheap half of the pair -- it kills
 * a process, while starting one took 444 seconds in the session that prompted
 * this.
 *
 * Deliberately no automatic restart. A restart costs minutes, several DESIGNER
 * operations usually arrive in a row, and only the agent knows whether it still
 * needs the query tools. So this reports what it did and leaves
 * `1c_toolkit_start` to the caller.
 *
 * A snapshot that throws is treated as "not running": the guard exists to
 * prevent damage, and failing to reach a health endpoint is not evidence of a
 * live session worth blocking a legitimate operation over.
 */
async function releaseInfobase(
  operation: OperationId,
  toolkit: ExecutorDeps["toolkit"],
): Promise<boolean> {
  if (!toolkit || !needsExclusiveInfobase(operation)) return false
  const snapshot = await toolkit.snapshot().catch(() => undefined)
  if (!snapshot?.alive) return false
  await toolkit.stop()
  return true
}

/**
 * How many DESIGNER operations are running right now, and for which base.
 *
 * 2026-09-23, debrief7.md §5 and §8.7 / D2. `needsExclusiveInfobase()` closes
 * the toolkit BEFORE a configurator run. Nothing stopped the toolkit being
 * STARTED while one was already in flight -- and on 09-21 that is exactly what
 * happened: a DESIGNER dump took the base at 17:36, the agent read the
 * resulting transport failure as a dropped connection, called
 * `1c_toolkit_start` at 17:43, and a thick client came up on a file base the
 * configurator was holding. That is the pairing that truncated
 * `RuntimeCacheStorage` on 2026-09-16, reached from the other side.
 *
 * Module-level rather than per-executor because the supervisor is a separate
 * object with no reference to this one; a counter both can consult is the
 * smallest thing that closes the window.
 */
const designerRuns = new Map<string, number>()

/**
 * True while a configurator operation holds this profile's base; without a
 * profile, any base. Per profile since toolkits are (mcp/toolkit-ports.ts): a
 * dump on one base must not refuse another session's toolkit on another.
 */
export function designerBusy(profileId?: string): boolean {
  if (profileId !== undefined) return (designerRuns.get(profileId) ?? 0) > 0
  return [...designerRuns.values()].some((count) => count > 0)
}

function countDesignerRun(profileId: string, delta: 1 | -1): void {
  const next = (designerRuns.get(profileId) ?? 0) + delta
  if (next > 0) designerRuns.set(profileId, next)
  else designerRuns.delete(profileId)
}

export async function runOperation(request: ExecRequest, deps: ExecutorDeps): Promise<ExecResult> {
  if (!isOperationId(request.operation)) {
    return { ok: false, reason: "unknown-operation", detail: request.operation }
  }
  const operation: OperationId = request.operation
  const definition = OPERATIONS[operation]

  if (requiresPath(operation) && !request.path?.trim()) {
    return { ok: false, reason: "path-required", detail: operation }
  }
  if (requiresSecondPath(operation) && !request.secondPath?.trim()) {
    return { ok: false, reason: "path-required", detail: `${operation} (второй путь)` }
  }

  // A session that chose "без профиля" has no infobase by construction, and a
  // session that has not chosen yet has not started.
  const binding = deps.bindings.get(request.conversationId)
  if (!binding?.profileId) return { ok: false, reason: "no-profile" }

  const profile = deps.profiles.get(binding.profileId)
  if (!profile) return { ok: false, reason: "profile-missing", detail: binding.profileId }

  if (definition.writes && request.permitted !== true) {
    return { ok: false, reason: "not-permitted", detail: operation }
  }

  // Before anything is launched, and after every refusal above: a refused
  // operation must not close the toolkit as a side effect.
  const toolkitStopped = await releaseInfobase(operation, deps.toolkit)

  // Whether the toolkit was answering before this run.
  //
  // 2026-09-20, debrief4.md §3.1. An ENTERPRISE launch opens a 1C client, and a
  // processing that shows a modal form -- or a missing file, which raises the
  // platform's own error dialog -- disables that client entirely. The MCP
  // Toolkit runs INSIDE a client session, so the agent's own call can take away
  // the tools it needs to finish, and nothing anywhere says so: the tools
  // simply stop answering. Comparing before and after is the only way the app
  // can notice, and saying it plainly is worth far more than the probe costs.
  //
  // Skipped for DESIGNER runs, which close the toolkit deliberately
  // (releaseInfobase) -- there the disappearance is expected and already
  // reported as toolkitStopped.
  const watchToolkit = Boolean(deps.toolkit) && !needsExclusiveInfobase(operation)
  const toolkitAliveBefore = watchToolkit ? await toolkitAlive(deps.toolkit) : false

  const verify = deps.verify ?? nodeVerifyDeps()
  const dir = await verify.tempDir()
  const outPath = join(dir, "operation.log")
  const objects = Array.isArray(request.objects)
    ? request.objects.filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    : []
  const listFile = operation === "dump_config_to_files" && objects.length > 0 ? join(dir, "objects.txt") : undefined
  if (listFile) await writeFile(listFile, objects.map((name) => `${name.trim()}\n`).join(""), "utf8")

  // Counted from here, so the window a toolkit start must not enter covers the
  // whole launch, not only the moments the platform is provably alive.
  if (needsExclusiveInfobase(operation)) countDesignerRun(profile.id, 1)
  try {
    // /DumpConfigToFiles writes into a folder and does not create it. Making it
    // here rather than demanding the agent do it first removes a failure that
    // costs a full configurator launch to discover: `checkPath` has already
    // established the parent is real, so this is the last cheap moment.
    if (pathSpec(operation)?.kind === "directory") {
      const target = request.path!.trim()
      if ((await verify.ensureWritableDir(target)) === "failed") {
        return { ok: false, reason: "path-rejected", detail: `Каталог недоступен для записи: ${target}` }
      }
    }

    const args = buildArgs({
      id: operation,
      connection: connectionArg(profile),
      userName: profile.userName,
      password: deps.profiles.password(profile.id) ?? "",
      outPath,
      path: request.path,
      secondPath: request.secondPath,
      update: request.update === true,
      extension: request.extension,
      listFile,
    })

    const run = await verify.runPlatform(profile.platformPath, args, operationTimeout(operation))
    const output = (await verify.readOut(outPath)).trim()

    const toolkitBlocked = toolkitAliveBefore && !(await toolkitAlive(deps.toolkit))
    const blockingDialogs = toolkitBlocked ? await deps.toolkit?.dialogs?.().catch(() => "") : undefined
    const blocked = { toolkitBlocked, ...(blockingDialogs ? { blockingDialogs } : {}) }

    if (run.spawnError) {
      // The platform never started, so the base was never touched — and the
      // toolkit was closed for nothing. Closing it costs the user a ~3-minute
      // restart (debrief5.md §8.2), so give it back rather than making them
      // pay for our failed launch.
      //
      // Deliberately only this branch. A run that DID start and then failed
      // leaves the agent likely to fix and retry, and restarting between
      // configurator operations would thrash: the skill tells it to do all
      // DESIGNER work first and call 1c_toolkit_start afterwards.
      const toolkitRestored = toolkitStopped ? await restoreToolkit(deps.toolkit) : false
      return {
        ok: false,
        reason: "launch-failed",
        detail: run.spawnError,
        toolkitStopped: toolkitStopped && !toolkitRestored,
        toolkitRestored,
        ...blocked,
      }
    }
    if (run.timedOut) return { ok: false, reason: "timed-out", detail: output, toolkitStopped, ...blocked }

    // 2026-09-25, skills_rebuild_plan.md Part 2.2. A dump of the profile's own
    // base names its configuration, and it is the one source available before
    // the toolkit has ever run. Best effort: a dump whose root cannot be read
    // here is still a successful dump.
    // Not from an extension's dump: its Configuration.xml names the extension,
    // and recording that replaced the base's configuration in the profile
    // (2026-09-26, debrief13.md §13.12) -- and with it the configuration pack.
    if (operation === "dump_config_to_files" && run.exitCode === 0 && request.path && !request.extension?.trim()) {
      const found = await configurationFromDump(request.path, deps.readDump ?? nodeDumpReader).catch(() => null)
      if (found) deps.profiles.recordConfiguration(profile.id, found)
    }

    return { ok: true, exitCode: run.exitCode, output, summary: definition.summary, toolkitStopped, ...blocked }
  } finally {
    if (needsExclusiveInfobase(operation)) countDesignerRun(profile.id, -1)
    await verify.cleanup(dir)
  }
}

/** What the toolkit supervisor knows, as far as the agent needs to hear it. */
export interface ToolkitSnapshot {
  readonly port: number
  readonly state: string
  /** Whether the port answers right now -- a toolkit the user opened counts. */
  readonly alive: boolean
  readonly reason?: string
  /** For a failed start: what the supervisor saw -- a blocking dialog's text, for one. */
  readonly detail?: string
  /** For a toolkit that ended on its own: see toolkit-calls.ts describeExit. */
  readonly exit?: ToolkitExitInfo
}

export type ProfileDescription =
  | {
      readonly ok: true
      readonly name: string
      readonly platformPath: string
      readonly kind: "file" | "server"
      readonly infobase: string
      readonly workingDirectory: string
      readonly userName: string
      /** Whether a password is stored. Never the password itself. */
      readonly hasPassword: boolean
      readonly toolkit?: ToolkitSnapshot
      /** What the infobase runs, once detected -- see profiles/configuration.ts. */
      readonly configuration?: InfobaseConfiguration
      /** The user allowed writes to this base without an ask each time. */
      readonly allowWriteWithoutConfirmation?: boolean
    }
  | { readonly ok: false; readonly reason: "no-profile" | "profile-missing"; readonly detail?: string }

/**
 * What the session is attached to, in the agent's own words.
 *
 * This exists because the alternative is what actually happened without it: an
 * agent that needed the platform path spent twenty minutes reading the app's
 * source and its electron-store files to find one, on a machine that happened
 * to have the source checked out. The facts are ours to hand over; only the
 * password is not, and it is the one field that never appears here.
 */
export async function describeProfile(
  /** `detect: false` reports only what is recorded, without asking the toolkit. */
  request: { readonly conversationId: string; readonly detect?: boolean },
  deps: Pick<ExecutorDeps, "profiles" | "bindings"> & {
    readonly toolkit?: () => Promise<ToolkitSnapshot>
    /** Asks the running toolkit; used only when nothing has been recorded yet. */
    readonly detectConfiguration?: (profileId: string) => Promise<InfobaseConfiguration | undefined>
  },
): Promise<ProfileDescription> {
  const binding = deps.bindings.get(request.conversationId)
  if (!binding?.profileId) return { ok: false, reason: "no-profile" }

  const profile = deps.profiles.get(binding.profileId)
  if (!profile) return { ok: false, reason: "profile-missing", detail: binding.profileId }

  const toolkit = await deps.toolkit?.().catch(() => undefined)
  // The agent is told to call this first, so it is the natural moment to fill
  // a gap the health poll has not closed yet.
  const configuration =
    profile.configuration ??
    (toolkit?.alive && request.detect !== false
      ? await deps.detectConfiguration?.(profile.id).catch(() => undefined)
      : undefined)

  return {
    ok: true,
    name: profile.name,
    platformPath: profile.platformPath,
    kind: profile.kind,
    infobase:
      profile.kind === "file"
        ? (profile.filePath ?? "")
        : `${profile.serverCluster ?? ""}\\${profile.serverDatabase ?? ""}`,
    workingDirectory: profile.workingDirectory,
    userName: profile.userName,
    hasPassword: profile.hasPassword,
    ...(toolkit ? { toolkit } : {}),
    ...(configuration ? { configuration } : {}),
    ...(profile.allowWriteWithoutConfirmation ? { allowWriteWithoutConfirmation: true } : {}),
  }
}

/** Exported for the relay's own use; keeps the temp-file handling in one place. */
export async function readPlatformLog(path: string): Promise<string> {
  try {
    return decodeConfigText(await readFile(path))
  } catch {
    return ""
  }
}

/** Used by tests that need a real temp directory without the rest of nodeVerifyDeps. */
export async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "1ccoder-op-"))
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
}
