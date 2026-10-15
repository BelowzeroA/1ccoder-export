// Keeping MCP Toolkits alive: one per profile, each on the profile's own port.
//
// A toolkit serves whichever infobase the 1C session that hosts it is
// connected to, so a port belongs to exactly one profile at a time. Quietly
// letting one profile's session talk to another's infobase would be the worst
// possible outcome, because `execute_code` writes.
//
// 2026-10-13: there used to be one port (6003) for every profile, so two
// sessions on different bases stopped each other's toolkit whenever either
// touched its base -- eight handovers in ninety minutes, each 40-70 s of 1C
// startup. Each profile now has its own port (deps.portFor, toolkit-ports.ts),
// and a start stops another profile's toolkit only when the two share a port.
// At most MAX_TOOLKITS run at once: each is a whole 1C client in memory.
//
// Started on the agent's request (1c_toolkit_start) or the user's, stopped
// when the app quits.

import { execFile, type ChildProcess } from "node:child_process"
import { access } from "node:fs/promises"

import { write as writeLog } from "../logging"
import { describeDialogs, isBlocking, type DialogProbe } from "./dialogs"
import { buildToolkitArgs, healthUrl, MCP_PORT, toolkitCandidates, type ToolkitProfile } from "./toolkit"
import { describeProtection, type ProtectionCheck, type ProtectionOutcome } from "./unsafe-protection"
import type { WindowPark } from "./window-park"

export type ToolkitFailure =
  | "no-toolkit"
  | "no-profile"
  | "launch-failed"
  | "timeout"
  /**
   * The platform is up but a modal window is holding the session, so the
   * toolkit's form never opens. `detail` carries the window's own text.
   */
  | "dialog"
  /** Someone else already holds the port, and it is not a toolkit we started. */
  | "port-taken"

export type ToolkitStatus =
  | { readonly state: "stopped" }
  | { readonly state: "starting"; readonly profileId: string; readonly port: number }
  | { readonly state: "running"; readonly profileId: string; readonly port: number }
  | {
      readonly state: "failed"
      readonly profileId: string
      readonly port: number
      readonly reason: ToolkitFailure
      readonly detail?: string
    }
  /**
   * It was running, nobody stopped it, and the port no longer answers. Distinct
   * from "stopped" (we closed it, on purpose) and from "failed" (it never came
   * up): this one means the tools the agent can see are stale registrations.
   */
  | {
      readonly state: "died"
      readonly profileId: string
      readonly port: number
      readonly noticedAt: number
      /** Set when the process's own exit was seen, not only a silent port. */
      readonly exit?: ToolkitExit
    }

/** How a toolkit process that nobody stopped ended. */
export interface ToolkitExit {
  readonly code: number | null
  readonly signal: string | null
  /** From the launch to the exit. */
  readonly lifetimeMs: number
}

/** How long the platform gets to open the infobase and start serving. */
export const START_TIMEOUT_MS = 120_000
const POLL_INTERVAL_MS = 1_000
/**
 * When the launched 1C is first looked at for a dialog, and how often after.
 * Not from the first second: the splash screen and the platform's own startup
 * windows come and go, and the probe costs a PowerShell start each time.
 */
export const DIALOG_FIRST_CHECK_MS = 10_000
export const DIALOG_CHECK_INTERVAL_MS = 10_000

/** One health request's patience. */
const PROBE_TIMEOUT_MS = 2_000
/** How many times to ask before believing the port is empty. */
const PROBE_ATTEMPTS = 3
const PROBE_RETRY_MS = 500

/** How many toolkits may run at once; the least recently used one makes room. */
export const MAX_TOOLKITS = 3

export interface SupervisorDeps {
  /**
   * The port a profile's toolkit listens on. Optional: without it every
   * profile shares MCP_PORT and a start for one stops the other, as before.
   */
  readonly portFor?: (profileId: string) => number
  /** The profile to run for, without its password. */
  readonly profile: (id: string) => (ToolkitProfile & { readonly platformPath: string }) | null
  readonly password: (id: string) => string | null
  readonly configDir: string
  /** The .epf that ships with the app, tried after every user-supplied copy. */
  readonly bundledToolkit?: string
  readonly fileExists?: (path: string) => Promise<boolean>
  readonly probeHealth?: (port: number) => Promise<PortState>
  readonly spawn?: (exe: string, args: string[]) => ChildProcess
  readonly sleep?: (ms: number) => Promise<void>
  /**
   * Reads the dialogs of 1C processes (dialogs.ts). Optional: without it a
   * blocked start is reported as a bare timeout, as before.
   */
  readonly dialogs?: DialogProbe
  /**
   * Moves the launched 1C's window off-screen once the toolkit answers
   * (window-park.ts). Optional: without it the window stays where the platform
   * put it.
   */
  readonly park?: WindowPark
  /**
   * Switches off the user's «Защита от опасных действий» before the first launch
   * (unsafe-protection.ts). Optional: without it the platform may ask before
   * opening the toolkit, as before.
   */
  readonly unsafeProtection?: ProtectionCheck
  /** The clock, for tests that walk through the start timeout. */
  readonly now?: () => number
}

const defaultFileExists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

/**
 * What is on the port.
 *
 * The distinction that matters is "free" versus the other two. Launching a
 * second platform instance on top of a live toolkit is the one outcome we must
 * never produce, so only a refused connection -- nobody is listening, full stop
 * -- is allowed to authorise a launch.
 */
export type PortState = "up" | "busy" | "free"

/** A refused connection is the only proof that nothing is listening. */
function isRefused(error: unknown): boolean {
  for (let cause: unknown = error, depth = 0; cause && depth < 5; depth++) {
    const code = (cause as { code?: unknown }).code
    if (code === "ECONNREFUSED") return true
    cause = (cause as { cause?: unknown }).cause
  }
  return false
}

/**
 * A GET that answers only when the embedded server is listening.
 *
 * `/health` is used rather than the MCP endpoint because it needs no session,
 * no protocol negotiation and no Accept dance -- it is there precisely so
 * something outside can tell whether the server is up.
 *
 * A timeout is NOT evidence of an empty port. The toolkit's server lives inside
 * a 1C client, which serves one thing at a time: a modal dialog or a long
 * server call leaves the port open and silent. Reading that silence as "free"
 * is what starts a second 1C on top of a working one.
 */
async function probeOnce(port: number, timeoutMs: number): Promise<PortState> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(healthUrl(port), { signal: controller.signal })
    return response.ok ? "up" : "busy"
  } catch (error) {
    return isRefused(error) ? "free" : "busy"
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Retries before reporting "free", because that answer costs a duplicate 1C.
 *
 * "up" returns at once, and so does the first refusal-free evidence of life:
 * only an unbroken run of refusals ends as "free".
 */
async function defaultProbeHealth(port: number): Promise<PortState> {
  let sawBusy = false
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
    if (attempt > 0) await defaultSleep(PROBE_RETRY_MS)
    const state = await probeOnce(port, PROBE_TIMEOUT_MS)
    if (state === "up") return "up"
    if (state === "busy") sawBusy = true
  }
  return sawBusy ? "busy" : "free"
}

const defaultSpawn = (exe: string, args: string[]) =>
  // windowsVerbatimArguments for the same reason as verify.ts: 1C wants the
  // quotes around the value, not around the argument.
  execFile(exe, args, { windowsHide: true, windowsVerbatimArguments: process.platform === "win32" }, () => {})

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

interface Running {
  readonly profileId: string
  readonly port: number
  readonly child: ChildProcess
  readonly startedAt: number
}

export class ToolkitSupervisor {
  /** The launched toolkits, by port: a port holds one toolkit at most. */
  private readonly running = new Map<number, Running>()
  /** Each profile's own state. */
  private readonly statuses = new Map<string, ToolkitStatus>()
  /** Last use per port, for choosing which toolkit makes room (MAX_TOOLKITS). */
  private readonly usedAt = new Map<number, number>()
  /** The profile asked about last: what the profile-less calls mean. */
  private last: string | null = null
  /** Exits seen before the toolkit ever answered, for the start that is waiting on it. */
  private readonly startExits = new WeakMap<ChildProcess, ToolkitExit>()
  /** In-flight start per port, so two sessions asking at once do not launch two 1C. */
  private readonly starting = new Map<number, Promise<ToolkitStatus>>()
  /**
   * The protection check's outcome per profile, once per app run: it costs
   * ~25 s, and a new toolkit follows every configurator run.
   */
  private readonly protection = new Map<string, ProtectionOutcome>()

  constructor(private readonly deps: SupervisorDeps) {}

  /** The port this profile's toolkit uses. */
  portFor(profileId: string): number {
    return this.deps.portFor?.(profileId) ?? MCP_PORT
  }

  /** A profile's state; without one, the state of the profile asked about last. */
  current(profileId?: string): ToolkitStatus {
    const id = profileId ?? this.last
    return (id ? this.statuses.get(id) : undefined) ?? { state: "stopped" }
  }

  /** The profile whose toolkit holds this port, if any. */
  owner(port: number): string | null {
    return this.running.get(port)?.profileId ?? null
  }

  async ensure(profileId: string, port: number = this.portFor(profileId)): Promise<ToolkitStatus> {
    this.last = profileId
    this.usedAt.set(port, (this.deps.now ?? Date.now)())
    if (this.running.get(port)?.profileId === profileId && this.current(profileId).state === "running") {
      // Still ours, but the user may have closed the 1C window by hand. Only a
      // refused connection says it is gone: a toolkit that is merely busy is
      // still ours, and forgetting it here would start a second one beside it.
      if ((await this.probe(port)) !== "free") return this.current(profileId)
      this.forget(port)
    }
    const pending = this.starting.get(port)
    if (pending) {
      const outcome = await pending
      if (outcome.state === "running" && this.running.get(port)?.profileId === profileId) return outcome
    }
    const started = this.start(profileId, port).finally(() => {
      if (this.starting.get(port) === started) this.starting.delete(port)
    })
    this.starting.set(port, started)
    return started
  }

  private async start(profileId: string, port: number): Promise<ToolkitStatus> {
    const profile = this.deps.profile(profileId)
    if (!profile) return this.fail(profileId, port, "no-profile")

    // A toolkit for another profile on this port serves another infobase. Take
    // the port back rather than leave the agent pointed at the wrong database.
    // With per-profile ports this happens only when two profiles share one.
    const occupant = this.running.get(port)
    if (occupant && occupant.profileId !== profileId) await this.stop(occupant.profileId)
    if (!this.running.has(port)) await this.makeRoom(port)

    const mine = this.running.get(port)
    if (!mine) {
      // Only a refused connection authorises a launch. Anything else -- an
      // answer, or a silence we cannot explain -- means somebody may be there,
      // and a second platform instance on top of a live toolkit is the one
      // outcome never worth risking.
      //
      // Refusing is not the end state we want. Which infobase the occupant
      // serves IS knowable -- the toolkit runs arbitrary 1C code, so
      // СтрокаСоединенияИнформационнойБазы() answers it in one call -- and an
      // occupant on the profile's own infobase should simply be adopted. Until
      // that check exists here, the agent does it from the toolkit-launch
      // skill, which tells it to identify the occupant before concluding
      // anything.
      const state = await this.probe(port)
      if (state !== "free") {
        // Which process holds the port is unknown here, so every 1C on the
        // machine is looked at; each dialog names its PID.
        const blocking = state === "up" ? "" : await this.blockingDialogs([])
        return this.fail(
          profileId,
          port,
          "port-taken",
          state === "up"
            ? "порт отвечает: на нём уже работает MCP Toolkit"
            : blocking
              ? `порт открыт, но не отвечает; сеанс 1С держит модальное окно:\n\n${blocking}`
              : "порт открыт, но не отвечает: возможно, 1С занята диалогом или долгим вызовом",
        )
      }
    } else {
      // A launch for this profile is still alive: it timed out, or stopped on
      // a dialog the user may since have answered. Waiting on it again is the
      // retry; spawning here would put a second 1C beside the first.
      writeLog("mcp", "toolkit start resumed", { profileId, port })
      return this.waitUntilUp(profileId, port, mine.child, () => undefined)
    }

    const exists = this.deps.fileExists ?? defaultFileExists
    const candidates = toolkitCandidates({ configDir: this.deps.configDir, profile, bundled: this.deps.bundledToolkit })
    let toolkitPath: string | null = null
    for (const candidate of candidates) {
      if (await exists(candidate)) {
        toolkitPath = candidate
        break
      }
    }
    if (!toolkitPath) return this.fail(profileId, port, "no-toolkit", candidates.join("; "))

    this.statuses.set(profileId, { state: "starting", profileId, port })
    // Before the launch, because the launch is itself the first thing the
    // platform asks about (debrief18.md).
    if (this.deps.unsafeProtection && !this.protection.has(profileId)) {
      const outcome = await this.deps.unsafeProtection({ profile, password: this.deps.password(profileId) ?? "" })
      this.protection.set(profileId, outcome)
      writeLog("mcp", "unsafe-action protection", { profileId, ...outcome })
    }
    const args = buildToolkitArgs({
      profile,
      password: this.deps.password(profileId) ?? "",
      toolkitPath,
      port,
    })

    let child: ChildProcess
    try {
      child = (this.deps.spawn ?? defaultSpawn)(profile.platformPath, args)
    } catch (error) {
      return this.fail(profileId, port, "launch-failed", String(error))
    }

    let spawnError: string | undefined
    child.on("error", (error) => {
      spawnError = String(error)
    })
    // The 1C window is the server; if it goes away the tools go with it, and
    // the next ensure() has to start a new one rather than report health it
    // cannot deliver.
    child.on("close", (code, signal) => this.exited(child, code, signal))
    this.running.set(port, { profileId, port, child, startedAt: (this.deps.now ?? Date.now)() })

    writeLog("mcp", "toolkit starting", { profileId, port, toolkitPath })
    return this.waitUntilUp(profileId, port, child, () => spawnError)
  }

  /**
   * Polls until the toolkit answers, the launch fails, a dialog blocks it, or
   * the start timeout runs out.
   *
   * On a dialog or a timeout the process is left alone rather than killed: a
   * slow infobase is the likeliest cause of the one, and the other is waiting
   * for the user's answer. The next ensure() comes back here instead of
   * spawning again.
   */
  private async waitUntilUp(
    profileId: string,
    port: number,
    child: ChildProcess,
    spawnError: () => string | undefined,
  ): Promise<ToolkitStatus> {
    this.statuses.set(profileId, { state: "starting", profileId, port })
    const sleep = this.deps.sleep ?? defaultSleep
    const now = this.deps.now ?? Date.now
    const startedAt = now()
    const deadline = startedAt + START_TIMEOUT_MS
    let nextDialogCheck = startedAt + DIALOG_FIRST_CHECK_MS
    while (now() < deadline) {
      const error = spawnError()
      if (error) {
        this.forget(port)
        return this.fail(profileId, port, "launch-failed", error)
      }
      // Waiting out the whole timeout on a process that is already gone is two
      // minutes spent learning nothing.
      const exit = this.startExits.get(child)
      if (exit) {
        return this.fail(
          profileId,
          port,
          "launch-failed",
          `Процесс 1С завершился через ${Math.round(exit.lifetimeMs / 1000)} с после запуска (код ${exit.code ?? exit.signal}), ` +
            "не успев открыть тулкит.",
        )
      }
      if ((await this.probe(port)) === "up") {
        const running: ToolkitStatus = { state: "running", profileId, port }
        this.statuses.set(profileId, running)
        writeLog("mcp", "toolkit ready", { profileId, port })
        this.parkWindow(profileId, child)
        return running
      }
      if (this.deps.dialogs && child.pid && now() >= nextDialogCheck) {
        nextDialogCheck = now() + DIALOG_CHECK_INTERVAL_MS
        const blocking = await this.blockingDialogs([child.pid])
        if (blocking) {
          // When the flag could not be cleared, the dialog is most likely its
          // question, and only the user can untick it.
          const outcome = this.protection.get(profileId)
          const userName = this.deps.profile(profileId)?.userName ?? ""
          const hint = outcome ? describeProtection(outcome, userName) : undefined
          return this.fail(profileId, port, "dialog", hint ? `${blocking}\n\n${hint}` : blocking)
        }
      }
      await sleep(POLL_INTERVAL_MS)
    }

    // The caller has waited the whole timeout and deserves an answer -- and
    // whatever is on screen is part of it, modal or not.
    const shown = child.pid && this.deps.dialogs ? await this.deps.dialogs([child.pid]).catch(() => []) : []
    return this.fail(
      profileId,
      port,
      "timeout",
      shown.length ? `Окна этого процесса 1С на экране:\n\n${describeDialogs(shown)}` : undefined,
    )
  }

  /**
   * Out of the user's way, once it serves. Not before: until the port answers,
   * whatever the window shows -- a login, a refusal to open the .epf -- is
   * something the user may have to answer. Not awaited, so a slow PowerShell
   * never delays the tools.
   */
  private parkWindow(profileId: string, child: ChildProcess) {
    if (!this.deps.park || !child.pid) return
    this.deps
      .park([child.pid])
      .then((titles) => writeLog("mcp", "toolkit window parked", { profileId, windows: titles }))
      .catch(() => {})
  }

  /** The text of the modal dialogs holding these processes (or any 1C), or "". */
  private async blockingDialogs(pids: readonly number[]): Promise<string> {
    if (!this.deps.dialogs) return ""
    const found = await this.deps.dialogs(pids).catch(() => [])
    return describeDialogs(found.filter(isBlocking))
  }

  /**
   * Whether anything is serving on the port right now.
   *
   * Deliberately not "is our toolkit running": a toolkit the user opened by
   * hand answers here too, and that is the point. The sidecar's MCP client
   * connects once, at instance startup, and never comes back -- so something
   * has to notice that the port started answering and say so. Without it, a
   * toolkit started after the session began is invisible to the agent no
   * matter how healthy it is, which is how a session ends up talking to the
   * toolkit through curl.
   */
  async health(profileId?: string): Promise<boolean> {
    return (await this.probe(this.portOf(profileId))) === "up"
  }

  /**
   * Probes the port and records a death the supervisor would otherwise miss.
   *
   * 2026-09-21, debrief5.md §8.4. The supervisor logs the stops it performs and
   * nothing else, so a toolkit that dies on its own -- crash, user closing the
   * 1C window, the machine sleeping -- left `state: "running"` behind forever.
   * On 2026-09-20 the toolkit was gone by 17:33 with no entry in mcp.log and
   * the status still reading `running`, and the agent met it three separate
   * times as a bare `fetch failed` from the MCP tools, which this process does
   * not sit in the path of.
   *
   * It cannot fix those tools' error text. What it can do is stop the app from
   * asserting something false: once this has run, every place that reports the
   * toolkit -- `1c_profile_info`, the executor's notices -- says it is gone and
   * why, instead of repeating a stale `running`.
   *
   * Returns whether the toolkit is answering right now.
   */
  async observeHealth(profileId?: string): Promise<boolean> {
    const port = this.portOf(profileId)
    const state = await this.probe(port)
    if (state === "up") {
      this.usedAt.set(port, (this.deps.now ?? Date.now)())
      return true
    }
    const status = this.current(profileId)
    // Only a state that claims to be up can be contradicted. `stopped` and
    // `failed` are already honest, and `starting` is not yet expected to answer.
    if (status.state !== "running") return false
    // A busy toolkit is not a dead one. `ensure()` already reads a silent port
    // as "somebody may be there"; recording a death here on the same evidence
    // made a toolkit mid-way through a long call report itself gone, and the
    // next start would have put a second 1C beside it.
    if (state !== "free") return false

    this.running.delete(port)
    this.statuses.set(status.profileId, { state: "died", profileId: status.profileId, port, noticedAt: Date.now() })
    writeLog("mcp", "toolkit died unnoticed", { profileId: status.profileId, port }, "warn")
    return false
  }

  /**
   * One look at the port, without the retries `probe` makes before calling it
   * free.
   *
   * For the check made before every toolkit tool call: a refused connection
   * is immediate, so a dead toolkit is reported at once, and anything else
   * lets the call go ahead -- the tool's own answer is better evidence than a
   * second probe. Injected probes are used as-is, so tests stay deterministic.
   */
  async portState(profileId?: string): Promise<PortState> {
    const port = this.portOf(profileId)
    if (this.deps.probeHealth) return this.deps.probeHealth(port)
    return probeOnce(port, PROBE_TIMEOUT_MS)
  }

  /** A profile's port; without one, that of the profile asked about last. */
  private portOf(profileId?: string): number {
    const id = profileId ?? this.last
    return id ? this.portFor(id) : MCP_PORT
  }

  /**
   * Stops the least recently used toolkit when MAX_TOOLKITS already run and
   * `port` is about to start another. Each one is a whole 1C client.
   */
  private async makeRoom(port: number): Promise<void> {
    if (this.running.size < MAX_TOOLKITS) return
    const [oldest] = [...this.running.values()]
      .filter((entry) => entry.port !== port)
      .sort((a, b) => (this.usedAt.get(a.port) ?? a.startedAt) - (this.usedAt.get(b.port) ?? b.startedAt))
    if (!oldest) return
    writeLog("mcp", "toolkit closed to make room", { profileId: oldest.profileId, port: oldest.port, limit: MAX_TOOLKITS })
    await this.stop(oldest.profileId)
  }

  private probe(port: number): Promise<PortState> {
    return (this.deps.probeHealth ?? defaultProbeHealth)(port)
  }

  private fail(profileId: string, port: number, reason: ToolkitFailure, detail?: string): ToolkitStatus {
    const failed: ToolkitStatus = { state: "failed", profileId, port, reason, ...(detail ? { detail } : {}) }
    this.statuses.set(profileId, failed)
    writeLog("mcp", "toolkit unavailable", { profileId, port, reason, detail }, "warn")
    return failed
  }

  /** Drops what is known about the toolkit on this port, without killing it. */
  private forget(port: number) {
    const entry = this.running.get(port)
    this.running.delete(port)
    if (entry) this.statuses.set(entry.profileId, { state: "stopped" })
  }

  /**
   * The 1C process ended. Ours to record only if nobody asked for it: stop()
   * forgets the toolkit before killing it, so its own kill never lands here.
   *
   * 2026-09-28, debrief15.md §15.15. Every toolkit on one base closed itself
   * about five minutes after starting, and this handler forgot each one without
   * a line in mcp.log. The agent read the silence as «тулкит сообщил успех, но
   * процесс не стартует» and went looking for another way to launch 1C. The
   * lifetime is the fact that tells the two apart: the same number every time
   * points at the base, not at the calls.
   */
  private exited(child: ChildProcess, code: number | null, signal: string | null) {
    const running = [...this.running.values()].find((entry) => entry.child === child)
    if (!running) return
    const exit = { code, signal, lifetimeMs: (this.deps.now ?? Date.now)() - running.startedAt }
    writeLog(
      "mcp",
      "toolkit exited on its own",
      { profileId: running.profileId, port: running.port, code, signal, lifetimeSec: Math.round(exit.lifetimeMs / 1000) },
      "warn",
    )
    this.running.delete(running.port)
    if (this.current(running.profileId).state === "running") {
      this.statuses.set(running.profileId, {
        state: "died",
        profileId: running.profileId,
        port: running.port,
        noticedAt: (this.deps.now ?? Date.now)(),
        exit,
      })
      return
    }
    this.startExits.set(child, exit)
    this.statuses.set(running.profileId, { state: "stopped" })
  }

  /** Stops one profile's toolkit, or every toolkit when no profile is named. */
  async stop(profileId?: string): Promise<void> {
    const targets = [...this.running.values()].filter((entry) => profileId === undefined || entry.profileId === profileId)
    for (const current of targets) {
      this.forget(current.port)
      try {
        current.child.kill()
      } catch {
        // Already gone; nothing to do.
      }
      writeLog("mcp", "toolkit stopped", { profileId: current.profileId, port: current.port })
    }
  }
}
