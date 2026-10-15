// Verification: does this profile actually work?
//
// Run before a profile is saved (a profile that fails is not saved) and before
// a session starts against one. Four checks, each reported separately with the
// command it ran and the output it captured, because "verification failed" on
// its own is not something a user can act on.
//
// The credential check is the interesting one, and its shape comes from
// measurements against a real 8.3.27 installation rather than from guesswork:
//
//   DESIGNER with no command at all       -> opens the GUI and never exits.
//   DESIGNER /CheckConfig, good creds     -> exit 0,  "Ошибок не обнаружено"
//   DESIGNER /CheckConfig, bad creds      -> exit 1,  "Пользователь ИБ не идентифицирован"
//   DESIGNER /CheckConfig, missing base   -> exit 1,  "Информационная база не обнаружена!"
//
// Two consequences. First, the command is mandatory: a bare connect would leave
// a Designer window sitting on the user's screen forever, so every launch here
// carries a command AND a hard timeout that kills the process. Second, the exit
// code is the signal and the text is only the explanation -- the text is
// localised to the platform's own language, so classifying on it alone would
// work on this machine and fail on the next one.
//
// Anything we cannot classify is reported as INCONCLUSIVE rather than as a
// failure. A base that is locked by another Designer, or a check that timed
// out, tells us nothing about whether the credentials are right, and refusing
// to save on that basis would be wrong.

import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

import { decodeConfigText } from "./v8i"
import { classifyBinDir } from "./discovery"
import type { InfobaseKind, ProfileDraft } from "./profile"

/** How long a single platform launch may take before we kill it. */
export const DEFAULT_TIMEOUT_MS = 90_000

/** The default 1C server agent port, used only for a reachability probe. */
const DEFAULT_CLUSTER_PORT = 1541

export type CheckId = "platform" | "infobase" | "workspace" | "credentials" | "admin"

export type CheckStatus = "pass" | "fail" | "inconclusive"

export interface CheckResult {
  readonly id: CheckId
  readonly status: CheckStatus
  /** A key the renderer resolves against its own dictionary. Never a user-facing string. */
  readonly code: string
  /** Raw platform output or a path, shown verbatim as evidence. Never contains the password. */
  readonly detail?: string
  /** Whether a non-pass result should stop the profile from being saved or a session from starting. */
  readonly blocking: boolean
}

export interface VerificationResult {
  readonly ok: boolean
  readonly checks: readonly CheckResult[]
}

export interface VerifyInput {
  readonly platformPath: string
  readonly kind: InfobaseKind
  readonly filePath?: string
  readonly serverCluster?: string
  readonly serverDatabase?: string
  readonly workingDirectory?: string
  readonly userName: string
  readonly password?: string
  readonly timeoutMs?: number
}

/** The seams tests replace: launching the platform and probing a TCP port. */
export interface VerifyDeps {
  readonly runPlatform: (exe: string, args: string[], timeoutMs: number) => Promise<PlatformRun>
  readonly readOut: (path: string) => Promise<string>
  readonly pathExists: (path: string) => Promise<boolean>
  readonly isFile: (path: string) => Promise<boolean>
  readonly listDir: (path: string) => Promise<string[]>
  readonly probeTcp: (host: string, port: number, timeoutMs: number) => Promise<boolean>
  /** Creates the directory if it is not there, and reports whether it is usable afterwards. */
  readonly ensureWritableDir: (path: string) => Promise<"ok" | "created" | "failed">
  readonly tempDir: () => Promise<string>
  readonly cleanup: (dir: string) => Promise<void>
}

export interface PlatformRun {
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly spawnError?: string
}

export type DesignerVerdict =
  | { readonly kind: "ok" }
  | { readonly kind: "bad-credentials" }
  | { readonly kind: "infobase-missing" }
  | { readonly kind: "inconclusive"; readonly reason: "timeout" | "spawn-failed" | "unrecognised" }

// Substrings are matched case-insensitively and only to explain a non-zero
// exit. Russian first because that is what a Russian platform prints; the
// English forms are there for a platform installed in another language.
const AUTH_MARKERS = ["не идентифицирован", "неверные имя", "not identified", "authentication"]
const MISSING_MARKERS = ["информационная база не обнаружена", "infobase not found", "не обнаружена"]

/**
 * Turns a platform run into a verdict. Pure, so every branch is testable
 * without launching 1C.
 */
export function classifyDesignerRun(run: PlatformRun, out: string): DesignerVerdict {
  if (run.spawnError) return { kind: "inconclusive", reason: "spawn-failed" }
  if (run.timedOut) return { kind: "inconclusive", reason: "timeout" }
  if (run.exitCode === 0) return { kind: "ok" }

  const text = out.toLowerCase()
  if (AUTH_MARKERS.some((marker) => text.includes(marker))) return { kind: "bad-credentials" }
  if (MISSING_MARKERS.some((marker) => text.includes(marker))) return { kind: "infobase-missing" }
  return { kind: "inconclusive", reason: "unrecognised" }
}

/**
 * Builds the DESIGNER command line.
 *
 * `/F` and `/S` are used rather than `/IBConnectionString` because the
 * connection-string form needs quotes nested inside quotes, which did not
 * survive process creation on Windows -- the platform answered "Неопределена
 * информационная база". Exported so a test can assert the password never
 * reaches a log.
 */
export function designerArgs(input: VerifyInput, outPath: string): string[] {
  const target =
    input.kind === "file"
      ? `/F"${input.filePath ?? ""}"`
      : `/S"${input.serverCluster ?? ""}\\${input.serverDatabase ?? ""}"`

  return [
    "DESIGNER",
    target,
    `/N"${input.userName}"`,
    // An empty /P makes the platform raise the login dialog even when the user
    // has no password -- emit /P only when there is one.
    ...(input.password ? [`/P"${input.password}"`] : []),
    // A command is mandatory: without one the Designer GUI opens and never exits.
    // -ConfigLogIntegrity is the cheapest form of the check.
    "/CheckConfig",
    "-ConfigLogIntegrity",
    "/DisableStartupDialogs",
    "/DisableStartupMessages",
    `/Out"${outPath}"`,
  ]
}

/** Splits "host:port" into its parts, defaulting to the 1C agent port. */
export function splitCluster(cluster: string): { host: string; port: number } {
  const at = cluster.lastIndexOf(":")
  if (at <= 0) return { host: cluster, port: DEFAULT_CLUSTER_PORT }
  const host = cluster.slice(0, at)
  const port = Number.parseInt(cluster.slice(at + 1), 10)
  // An unparseable port is a typo in the port, not in the host -- keeping the
  // whole string as the host would turn it into a guaranteed DNS failure.
  if (!Number.isFinite(port) || port <= 0) return { host, port: DEFAULT_CLUSTER_PORT }
  return { host, port }
}

/**
 * Spawn options for a platform launch.
 *
 * Exported so the argv0 invariant can be asserted without launching 1C: it is
 * invisible at the call site, and getting it wrong silently breaks every
 * DESIGNER operation while leaving ENTERPRISE ones working. See runPlatform.
 */
export function platformSpawnOptions(
  exe: string,
  onWindows: boolean = process.platform === "win32",
): { windowsHide: true; windowsVerbatimArguments: boolean; argv0?: string } {
  return {
    windowsHide: true,
    windowsVerbatimArguments: onWindows,
    ...(onWindows ? { argv0: `"${exe}"` } : {}),
  }
}

export function nodeVerifyDeps(): VerifyDeps {
  return {
    runPlatform: (exe, args, timeoutMs) =>
      new Promise<PlatformRun>((resolve) => {
        // windowsVerbatimArguments because 1C wants the quotes around the VALUE
        // (/F"C:\path"), not around the whole argument, which is what Node's own
        // quoting produces. Without it the platform answers "Неопределена
        // информационная база" and exits 1 -- a convincing imitation of a real
        // failure, caused entirely by us.
        //
        // argv0 is the other half of that, and it is load-bearing. Verbatim
        // mode tells libuv not to quote ANYTHING -- including the executable
        // it puts at the front of the command line. 1C lives in
        // "C:\Program Files\1cv8\...", so the command line split at that space
        // and the platform read `Files\1cv8\...\1cv8.exe` as its start mode:
        //
        //   C:\Program Files\1cv8\8.5.1.1529\bin\1cv8.exe DESIGNER /F"..."
        //   argv[1] = Files\1cv8\8.5.1.1529\bin\1cv8.exe   <- read as the mode
        //   argv[2] = DESIGNER                             <- never seen
        //
        // Every DESIGNER run therefore failed with «Неопределен режим запуска»
        // (1c_check_config, 1c_dump_config -- broken since at least 2026-09-19),
        // while ENTERPRISE runs appeared to work because Enterprise is the
        // platform's default when the mode argument is not recognised. The
        // working tool masked the broken ones for days. debrief5.md §8.1.
        //
        // Passing argv0 quoted keeps the executable a single token without
        // touching lpApplicationName, so the child is still 1cv8.exe itself --
        // a cmd.exe wrapper would also fix the quoting but would make the
        // direct child a shell, and the timeout below kills the direct child.
        const child = spawn(exe, args, platformSpawnOptions(exe))
        let timedOut = false
        // SIGTERM first, then SIGKILL if it is still there. A 1C client sitting
        // on a modal dialog is the case that matters: it has no reason to
        // notice a polite request, and leaving it alive strands a window over
        // the base and, with it, the MCP Toolkit that runs inside a client
        // session. debrief4.md §3.1.
        let escalation: ReturnType<typeof setTimeout> | undefined
        const timer = setTimeout(() => {
          timedOut = true
          child.kill()
          escalation = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
          }, 5_000)
        }, timeoutMs)
        const done = () => {
          clearTimeout(timer)
          if (escalation) clearTimeout(escalation)
        }
        child.on("error", (error) => {
          done()
          resolve({ exitCode: null, timedOut, spawnError: String(error) })
        })
        child.on("close", (code) => {
          done()
          resolve({ exitCode: code, timedOut })
        })
      }),
    readOut: async (path) => {
      try {
        // The platform writes this log in the system encoding, not UTF-8.
        return decodeConfigText(await readFile(path))
      } catch {
        return ""
      }
    },
    pathExists: async (path) => {
      try {
        await stat(path)
        return true
      } catch {
        return false
      }
    },
    isFile: async (path) => {
      try {
        return (await stat(path)).isFile()
      } catch {
        return false
      }
    },
    listDir: async (path) => {
      try {
        const { readdir } = await import("node:fs/promises")
        return await readdir(path)
      } catch {
        return []
      }
    },
    probeTcp: (host, port, timeoutMs) =>
      new Promise<boolean>((resolve) => {
        const socket = createConnection({ host, port })
        const finish = (result: boolean) => {
          socket.destroy()
          resolve(result)
        }
        socket.setTimeout(timeoutMs)
        socket.once("connect", () => finish(true))
        socket.once("timeout", () => finish(false))
        socket.once("error", () => finish(false))
      }),
    ensureWritableDir: async (path) => {
      let created = false
      try {
        if (!(await stat(path).then(() => true).catch(() => false))) {
          await mkdir(path, { recursive: true })
          created = true
        }
      } catch {
        return "failed"
      }
      try {
        // Existing is not the same as usable: a path can survive stat() and
        // still refuse writes. Probe with a file we immediately remove.
        const probe = join(path, ".1ccoder-write-probe")
        await writeFile(probe, "")
        await rm(probe, { force: true })
      } catch {
        return "failed"
      }
      return created ? "created" : "ok"
    },
    tempDir: () => mkdtemp(join(tmpdir(), "1ccoder-verify-")),
    cleanup: (dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined),
  }
}

/**
 * Check 1: the platform path is a thick client we can drive.
 *
 * The thin client cannot run DESIGNER, and the binary is not always 1cv8.exe --
 * the training edition ships 1cv8t.exe -- so this asks the same question
 * discovery does, of a path the user may have typed by hand.
 */
async function checkPlatform(input: VerifyInput, deps: VerifyDeps): Promise<CheckResult> {
  if (!(await deps.isFile(input.platformPath))) {
    return { id: "platform", status: "fail", code: "platform-missing", detail: input.platformPath, blocking: true }
  }

  const binDir = dirname(input.platformPath)
  const classified = classifyBinDir(await deps.listDir(binDir))
  if (!classified) {
    return { id: "platform", status: "fail", code: "platform-not-thick", detail: binDir, blocking: true }
  }

  const chosen = basename(input.platformPath).toLowerCase()
  if (chosen !== classified.thickClient) {
    return {
      id: "platform",
      status: "fail",
      code: "platform-not-thick",
      detail: `${chosen} != ${classified.thickClient}`,
      blocking: true,
    }
  }

  return { id: "platform", status: "pass", code: `platform-ok-${classified.edition}`, detail: binDir, blocking: true }
}

/** Check 2: the infobase is where the profile says it is. */
async function checkInfobase(input: VerifyInput, deps: VerifyDeps): Promise<CheckResult> {
  if (input.kind === "file") {
    const dir = input.filePath ?? ""
    if (!(await deps.pathExists(dir))) {
      return { id: "infobase", status: "fail", code: "infobase-dir-missing", detail: dir, blocking: true }
    }
    // 1Cv8.1CD is the file infobase itself; a directory without one is not a base.
    if (!(await deps.pathExists(join(dir, "1Cv8.1CD")))) {
      return { id: "infobase", status: "fail", code: "infobase-not-a-base", detail: dir, blocking: true }
    }
    return { id: "infobase", status: "pass", code: "infobase-ok", detail: dir, blocking: true }
  }

  const { host, port } = splitCluster(input.serverCluster ?? "")
  const reachable = await deps.probeTcp(host, port, 5_000)
  if (!reachable) {
    // Deliberately not blocking: a cluster may sit behind a firewall that drops
    // the agent port while the base itself is perfectly reachable, and the
    // credential check that follows is the real evidence either way.
    return {
      id: "infobase",
      status: "inconclusive",
      code: "cluster-unreachable",
      detail: `${host}:${port}`,
      blocking: false,
    }
  }
  return { id: "infobase", status: "pass", code: "infobase-ok", detail: `${host}:${port}`, blocking: true }
}

/**
 * Check 3: the agent has somewhere to work.
 *
 * This is the profile's own directory, not opencode's project -- see the note
 * on `workingDirectory` in profile.ts. We create it when it is missing, because
 * it is ours to create and refusing to save over a directory that does not
 * exist yet would be pedantry.
 */
async function checkWorkspace(input: VerifyInput, deps: VerifyDeps): Promise<CheckResult> {
  const dir = (input.workingDirectory ?? "").trim()
  if (!dir) {
    return { id: "workspace", status: "fail", code: "workspace-missing", blocking: true }
  }

  const outcome = await deps.ensureWritableDir(dir)
  if (outcome === "failed") {
    return { id: "workspace", status: "fail", code: "workspace-not-writable", detail: dir, blocking: true }
  }
  return {
    id: "workspace",
    status: "pass",
    code: outcome === "created" ? "workspace-created" : "workspace-ok",
    detail: dir,
    blocking: true,
  }
}

/** Checks 4 and 5: the credentials work, and — as far as we can tell — carry admin rights. */
async function checkCredentials(input: VerifyInput, deps: VerifyDeps): Promise<CheckResult[]> {
  const dir = await deps.tempDir()
  const outPath = join(dir, "verify.log")
  try {
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const run = await deps.runPlatform(input.platformPath, designerArgs(input, outPath), timeoutMs)
    const out = (await deps.readOut(outPath)).trim()
    const verdict = classifyDesignerRun(run, out)

    switch (verdict.kind) {
      case "ok":
        return [
          { id: "credentials", status: "pass", code: "credentials-ok", detail: out, blocking: true },
          // Establishing role membership needs code executed inside the infobase,
          // which the POC does not ship. A DESIGNER session succeeding is the
          // signal we have: in most configurations it implies administrative
          // rights. Reported, never blocking.
          { id: "admin", status: "pass", code: "admin-implied-by-designer", blocking: false },
        ]
      case "bad-credentials":
        return [
          { id: "credentials", status: "fail", code: "credentials-rejected", detail: out, blocking: true },
          { id: "admin", status: "inconclusive", code: "admin-unknown", blocking: false },
        ]
      case "infobase-missing":
        return [
          { id: "credentials", status: "fail", code: "infobase-missing", detail: out, blocking: true },
          { id: "admin", status: "inconclusive", code: "admin-unknown", blocking: false },
        ]
      default:
        return [
          {
            id: "credentials",
            status: "inconclusive",
            code: `credentials-${verdict.reason}`,
            detail: out || run.spawnError || "",
            blocking: false,
          },
          { id: "admin", status: "inconclusive", code: "admin-unknown", blocking: false },
        ]
    }
  } finally {
    await deps.cleanup(dir)
  }
}

/**
 * Runs the whole procedure.
 *
 * Checks run in order and stop at the first blocking failure: launching the
 * platform against an infobase we already know is missing would cost the user
 * a minute to learn something we could tell them immediately.
 */
export async function verifyProfile(
  input: VerifyInput,
  deps: VerifyDeps = nodeVerifyDeps(),
): Promise<VerificationResult> {
  const checks: CheckResult[] = []

  const platform = await checkPlatform(input, deps)
  checks.push(platform)
  if (platform.status === "fail") return { ok: false, checks }

  const infobase = await checkInfobase(input, deps)
  checks.push(infobase)
  if (infobase.status === "fail") return { ok: false, checks }

  // Before the expensive one: a bad workspace is worth knowing about instantly
  // rather than after five seconds of platform startup.
  const workspace = await checkWorkspace(input, deps)
  checks.push(workspace)
  if (workspace.status === "fail") return { ok: false, checks }

  checks.push(...(await checkCredentials(input, deps)))

  const blocked = checks.some((check) => check.blocking && check.status === "fail")
  return { ok: !blocked, checks }
}

/**
 * Maps a draft onto the verification input.
 *
 * Extracted and exported so it can be tested. It was previously written inline
 * and silently omitted `workingDirectory`, which made the working-directory
 * check fail for every profile regardless of what the user had typed: the field
 * never arrived. The unit tests did not catch it because they called
 * verifyProfile directly with a complete input, leaving this seam -- the only
 * place the two halves meet -- untested.
 */
export function verifyInputFromDraft(draft: ProfileDraft, password: string | undefined): VerifyInput {
  return {
    platformPath: draft.platformPath,
    kind: draft.kind,
    filePath: draft.filePath,
    serverCluster: draft.serverCluster,
    serverDatabase: draft.serverDatabase,
    workingDirectory: draft.workingDirectory,
    userName: draft.userName,
    password,
  }
}
