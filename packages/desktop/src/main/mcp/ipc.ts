// The renderer's door to the MCP Toolkit.
//
// "Make sure the toolkit is up for this profile", "what is it doing", and
// "this session folder's 1c_* tools now reach this profile". The renderer never
// learns where the .epf is, never sees the password that opens the infobase,
// and cannot choose the port: each profile has its own (toolkit-ports.ts), and
// the renderer is told it only to point the folder's MCP client at it.
//
// Registered from here rather than from main/ipc.ts, like profiles/ipc.ts, to
// keep the fork's diff off upstream files.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { readFile } from "node:fs/promises"

import { app, ipcMain } from "electron"

import { designerBusy, type ToolkitSnapshot } from "../infobase/executor"
import { resolveOpencodeConfigDir } from "../llm/provider-config"
import { write as writeLog } from "../logging"
import type { InfobaseConfiguration } from "../profiles/configuration"
import { ProfileStore } from "../profiles/profile-store"
import { electronStoreDeps, electronBindingDeps } from "../profiles/profile-store-electron"
import { SessionBindingStore } from "../profiles/session-binding"
import { resolveBundledResource } from "../skills"
import { probeConfiguration } from "./configuration-probe"
import { describeDialogs, isBlocking, nodeDialogProbe } from "./dialogs"
import { checkDcs } from "./dcs-check"
import { checkEpf } from "./epf-check"
import { printCapabilities } from "./print-capabilities"
import { runReport } from "./report-run"
import {
  closable,
  closeDialog,
  describeProcesses,
  nodeProcessDeps,
  opensInfobase,
  parseProcessList,
  type ProcessDeps,
} from "./processes"
import { ToolkitSupervisor, type ToolkitExit, type ToolkitStatus } from "./supervisor"
import { nodeProtectionCheck } from "./unsafe-protection"
import { nodeWindowPark } from "./window-park"
import { BUNDLED_TOOLKIT_DIR, TOOLKIT_FILE_NAME } from "./toolkit"
import { ToolkitPorts } from "./toolkit-ports"

export const MCP_CHANNELS = {
  ensure: "1ccoder-mcp-ensure",
  status: "1ccoder-mcp-status",
  health: "1ccoder-mcp-health",
  link: "1ccoder-mcp-link",
} as const

let supervisor: ToolkitSupervisor | null = null

/** The ports given to profiles, kept in userData so they survive restarts. */
function toolkitPorts(): ToolkitPorts {
  const file = join(app.getPath("userData"), "toolkit-ports.json")
  return new ToolkitPorts({
    load: () => {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
        return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {}
      } catch {
        return {}
      }
    },
    save: (ports) => {
      try {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify(ports, null, 2), "utf8")
      } catch (error) {
        writeLog("mcp", "toolkit ports not saved", { error: String(error) }, "warn")
      }
    },
  })
}

function instance(): ToolkitSupervisor {
  if (supervisor) return supervisor
  const profiles = new ProfileStore(electronStoreDeps())
  const ports = toolkitPorts()
  supervisor = new ToolkitSupervisor({
    portFor: (id) => ports.portFor(id),
    configDir: resolveOpencodeConfigDir(),
    bundledToolkit: resolveBundledResource(join(BUNDLED_TOOLKIT_DIR, TOOLKIT_FILE_NAME), {
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    }),
    dialogs: nodeDialogProbe,
    park: nodeWindowPark,
    unsafeProtection: nodeProtectionCheck,
    profile: (id) => {
      const found = profiles.get(id)
      if (!found) return null
      return {
        kind: found.kind,
        filePath: found.filePath,
        serverCluster: found.serverCluster,
        serverDatabase: found.serverDatabase,
        workingDirectory: found.workingDirectory,
        userName: found.userName,
        platformPath: found.platformPath,
      }
    },
    password: (id) => profiles.password(id),
  })
  return supervisor
}

export function registerMcpIpc(): void {
  ipcMain.handle(MCP_CHANNELS.ensure, async (_event, profileId: string): Promise<ToolkitStatus> => {
    if (typeof profileId !== "string" || !profileId) return { state: "stopped" }
    const status = await instance().ensure(profileId)
    if (status.state === "running") noticeHealth(profileId, true)
    return status
  })
  ipcMain.handle(MCP_CHANNELS.status, (_event, profileId?: unknown): ToolkitStatus =>
    instance().current(typeof profileId === "string" && profileId ? profileId : undefined),
  )
  // Asked on a timer while a profile session is open, so a toolkit that starts
  // (or dies) mid-session is noticed rather than waited for forever. The
  // profile, when the renderer passes it, is what lets a toolkit the user
  // opened by hand get its configuration detected too.
  ipcMain.handle(MCP_CHANNELS.health, async (_event, profileId?: unknown): Promise<boolean> => {
    const id = typeof profileId === "string" && profileId ? profileId : undefined
    const alive = await instance().health(id)
    if (id) noticeHealth(id, alive)
    return alive
  })
  ipcMain.handle(MCP_CHANNELS.link, (_event, request: unknown): number | null => linkToolkit(request))
}

/**
 * Which profile each session folder's MCP client was last pointed at.
 *
 * opencode keeps one MCP client per instance, and an instance is a folder.
 * Normally each profile has its own working folder and so its own client; two
 * sessions with different profiles in one folder share one, and the one linked
 * last wins. The gate (toolkitGate) reads this to refuse the other session's
 * calls rather than let them reach a base that is not its own.
 */
const links = new Map<string, string>()

const folderKey = (directory: string) => resolve(directory).replace(/[\\/]+$/, "").toLowerCase()

/**
 * The renderer is about to point a session folder's `1c` MCP client at a
 * profile's toolkit: records the link and returns the port to point it at.
 */
export function linkToolkit(request: unknown): number | null {
  const record = (request ?? {}) as { directory?: unknown; profileId?: unknown }
  if (typeof record.profileId !== "string" || !record.profileId) return null
  if (typeof record.directory === "string" && record.directory) links.set(folderKey(record.directory), record.profileId)
  return instance().portFor(record.profileId)
}

/**
 * The profiles whose toolkit was last seen answering. A configuration is asked
 * for once per toolkit coming up, not on every poll: the answer only changes
 * when the configuration is updated, and that needs the base closed -- which
 * takes the toolkit down with it.
 */
const answering = new Set<string>()

function noticeHealth(profileId: string, alive: boolean): void {
  if (!alive) {
    answering.delete(profileId)
    return
  }
  if (answering.has(profileId)) return
  answering.add(profileId)
  void detectConfiguration(profileId)
}

const detecting = new Map<string, Promise<InfobaseConfiguration | undefined>>()

/**
 * Asks the running toolkit which configuration the profile's infobase runs,
 * and records it on the profile.
 *
 * 2026-09-25, skills_rebuild_plan.md Part 2.2. Never throws: this runs in the
 * background of a health poll and of `1c_profile_info`, and a failure to learn
 * the configuration must cost nothing but the pack.
 */
export function detectConfiguration(profileId: string): Promise<InfobaseConfiguration | undefined> {
  const pending = detecting.get(profileId)
  if (pending) return pending
  const run = (async () => {
    const profiles = new ProfileStore(electronStoreDeps())
    const profile = profiles.get(profileId)
    if (!profile) return undefined
    const outcome = await probeConfiguration(profile, { port: instance().portFor(profileId) })
    if (!outcome.ok) {
      writeLog("mcp", "configuration not detected", { profileId, reason: outcome.reason, detail: outcome.detail }, "warn")
      return profile.configuration
    }
    profiles.recordConfiguration(profileId, outcome.configuration)
    writeLog("mcp", "configuration detected", { profileId, ...outcome.configuration })
    return outcome.configuration
  })().finally(() => detecting.delete(profileId))
  detecting.set(profileId, run)
  return run
}

/** The profile a conversation is bound to, if any. */
function boundProfileId(request: { conversationId?: unknown } | undefined): string | undefined {
  const conversationId = typeof request?.conversationId === "string" ? request.conversationId : ""
  return (conversationId && new SessionBindingStore(electronBindingDeps()).get(conversationId)?.profileId) || undefined
}

/**
 * The toolkit's state for a conversation's profile, for the agent rather than
 * for the UI.
 *
 * Goes through the same supervisor instance the renderer talks to, so the two
 * never disagree about whether the toolkit is up.
 */
export async function toolkitSnapshot(request?: { conversationId?: unknown }): Promise<ToolkitSnapshot> {
  const supervisorInstance = instance()
  const profileId = boundProfileId(request)
  // observeHealth rather than health: a toolkit that died on its own must be
  // recorded as dead here, or every later report repeats a stale `running`.
  // debrief5.md §8.4.
  const alive = await supervisorInstance.observeHealth(profileId).catch(() => false)
  const status = supervisorInstance.current(profileId)
  return {
    port: "port" in status ? status.port : profileId ? supervisorInstance.portFor(profileId) : 0,
    state: status.state,
    alive,
    ...(status.state === "failed" ? { reason: status.reason } : {}),
    ...(status.state === "failed" && status.detail ? { detail: status.detail } : {}),
    ...(status.state === "died" && status.exit ? { exit: status.exit } : {}),
  }
}

export interface ToolkitStartResult {
  readonly ok: boolean
  readonly reason?: string
  readonly detail?: string
  readonly port?: number
  readonly state?: string
}

/**
 * Opens the toolkit for a conversation's profile, on the agent's request.
 *
 * Binding a profile no longer starts 1C -- see startToolkit in
 * renderer/profiles/use-session-profile.ts. The agent needs some way to ask for
 * it, and it cannot be one of the `1c_*` query tools, because those ARE the
 * toolkit: none of them exists until it is serving. So the request arrives
 * through the sidecar plugin, which is always loaded, and lands here.
 *
 * Goes through the same supervisor instance as the renderer, so a toolkit
 * started this way is one the UI and the health poll already know about.
 */
export async function startToolkitForConversation(request: {
  conversationId?: unknown
}): Promise<ToolkitStartResult> {
  const conversationId = typeof request?.conversationId === "string" ? request.conversationId : ""
  if (!conversationId) return { ok: false, reason: "no-conversation" }

  const binding = new SessionBindingStore(electronBindingDeps()).get(conversationId)
  if (!binding?.profileId) return { ok: false, reason: "no-profile" }

  // 2026-09-23, debrief7.md §5 / D2. A configurator run holds the base
  // exclusively, and `needsExclusiveInfobase()` closes the toolkit before one
  // starts. Nothing stopped a toolkit being started back up WHILE one was
  // running -- and on 09-21 a thick client came up on a base a DESIGNER dump
  // was holding, which is the pairing that corrupted `RuntimeCacheStorage` on
  // 09-16. Refusing is safe here in a way it is not elsewhere: the agent can
  // simply call this again when the operation finishes.
  if (designerBusy(binding.profileId)) return { ok: false, reason: "designer-busy" }

  const status = await instance().ensure(binding.profileId)
  if (status.state === "running") {
    noticeHealth(binding.profileId, true)
    return { ok: true, state: status.state, port: status.port }
  }
  if (status.state === "failed") {
    return {
      ok: false,
      reason: status.reason,
      port: status.port,
      state: status.state,
      ...(status.detail ? { detail: status.detail } : {}),
    }
  }
  // "starting" and "stopped" are not failures: 1C takes tens of seconds, and the
  // health poll connects the tools whenever it does come up.
  return { ok: true, state: status.state, ...("port" in status ? { port: status.port } : {}) }
}

/**
 * `1c_print_capabilities`: what the session's base offers for print forms.
 *
 * 2026-09-25, skills_rebuild_plan.md Part 2.5. Refuses rather than guesses
 * when the toolkit is down or serves another base -- a table about the wrong
 * infobase is worse than none.
 */
export async function printCapabilitiesForConversation(request: {
  conversationId?: unknown
  dump?: unknown
}): Promise<{ ok: boolean; text?: string; reason?: string; detail?: string }> {
  const conversationId = typeof request?.conversationId === "string" ? request.conversationId : ""
  const binding = conversationId ? new SessionBindingStore(electronBindingDeps()).get(conversationId) : null
  if (!binding?.profileId) return { ok: false, reason: "no-profile" }
  const profile = new ProfileStore(electronStoreDeps()).get(binding.profileId)
  if (!profile) return { ok: false, reason: "profile-missing" }
  if (!(await instance().health(profile.id))) return { ok: false, reason: "toolkit-down" }

  const dump = typeof request?.dump === "string" ? request.dump.trim().replace(/[\\/]+$/, "") : ""
  const outcome = await printCapabilities(profile, {
    port: instance().portFor(profile.id),
    ...(dump
      ? { readModule: () => readFile(`${dump}/CommonModules/УправлениеПечатью/Ext/Module.bsl`, "utf8").catch(() => null) }
      : {}),
  })
  return outcome.ok ? { ok: true, text: outcome.text } : { ok: false, reason: outcome.reason, detail: outcome.detail }
}

/** The bound profile of a conversation, or the refusal reason. */
function conversationProfile(request: { conversationId?: unknown }) {
  const conversationId = typeof request?.conversationId === "string" ? request.conversationId : ""
  const binding = conversationId ? new SessionBindingStore(electronBindingDeps()).get(conversationId) : null
  if (!binding?.profileId) return { ok: false as const, reason: "no-profile" }
  const profile = new ProfileStore(electronStoreDeps()).get(binding.profileId)
  if (!profile) return { ok: false as const, reason: "profile-missing" }
  return { ok: true as const, profile }
}

/**
 * What the plugin checks before letting a toolkit tool call through.
 *
 * 2026-09-25, failures_to_tools.md G5. One probe, no retries: a refused
 * connection is immediate and certain, and anything else lets the call go
 * ahead. A refusal also records a death the supervisor had not noticed, so the
 * next `1c_profile_info` agrees with what the agent was just told.
 *
 * Per conversation since toolkits are per profile: the port probed is the
 * session's own profile's, and a session folder whose MCP client another
 * profile's session has since linked is reported as `linkedTo`.
 */
export async function toolkitGate(request?: { conversationId?: unknown; directory?: unknown }): Promise<{
  designerBusy: boolean
  port: "up" | "busy" | "free"
  state: string
  exit?: ToolkitExit
  linkedTo?: string
}> {
  const supervisorInstance = instance()
  const profileId = boundProfileId(request)
  const port = await supervisorInstance.portState(profileId).catch(() => "busy" as const)
  if (port === "free") await supervisorInstance.observeHealth(profileId).catch(() => false)
  const status = supervisorInstance.current(profileId)
  const directory = typeof request?.directory === "string" && request.directory ? folderKey(request.directory) : ""
  const linked = directory ? links.get(directory) : undefined
  const linkedTo =
    profileId && linked && linked !== profileId
      ? (new ProfileStore(electronStoreDeps()).get(linked)?.name ?? linked)
      : undefined
  return {
    designerBusy: designerBusy(profileId),
    port,
    state: status.state,
    ...(status.state === "died" && status.exit ? { exit: status.exit } : {}),
    ...(linkedTo ? { linkedTo } : {}),
  }
}

/** `1c_check_epf`, the half that needs the platform. failures_to_tools.md T1. */
export async function checkEpfForConversation(request: {
  conversationId?: unknown
  path?: unknown
  expectName?: unknown
}): Promise<{ ok: boolean; text?: string; passed?: boolean; reason?: string; detail?: string }> {
  const found = conversationProfile(request)
  if (!found.ok) return found
  const path = typeof request?.path === "string" ? request.path.trim() : ""
  if (!path) return { ok: false, reason: "path-required" }
  if (designerBusy(found.profile.id)) return { ok: false, reason: "designer-busy" }
  if (!(await instance().health(found.profile.id))) return { ok: false, reason: "toolkit-down" }
  const expectName = typeof request?.expectName === "string" && request.expectName.trim() ? request.expectName.trim() : undefined
  return checkEpf({ path, ...(expectName ? { expectName } : {}) }, found.profile, { port: instance().portFor(found.profile.id) })
}

/** `1c_check_dcs`: a data composition schema, checked in the session's base. debrief14.md §14.5. */
export async function checkDcsForConversation(request: {
  conversationId?: unknown
  path?: unknown
}): Promise<{ ok: boolean; text?: string; passed?: boolean; reason?: string; detail?: string }> {
  const found = conversationProfile(request)
  if (!found.ok) return found
  const path = typeof request?.path === "string" ? request.path.trim() : ""
  if (!path) return { ok: false, reason: "path-required" }
  if (designerBusy(found.profile.id)) return { ok: false, reason: "designer-busy" }
  if (!(await instance().health(found.profile.id))) return { ok: false, reason: "toolkit-down" }
  return checkDcs({ path }, found.profile, { port: instance().portFor(found.profile.id) })
}

/** `1c_run_report`: an external report composed with its default variant. debrief16.md §16.3. */
export async function runReportForConversation(request: {
  conversationId?: unknown
  path?: unknown
  params?: unknown
  filters?: unknown
  outBase?: unknown
}): Promise<{ ok: boolean; text?: string; passed?: boolean; reason?: string; detail?: string }> {
  const found = conversationProfile(request)
  if (!found.ok) return found
  const path = typeof request?.path === "string" ? request.path.trim() : ""
  const outBase = typeof request?.outBase === "string" ? request.outBase.trim() : ""
  if (!path || !outBase) return { ok: false, reason: "path-required" }
  if (designerBusy(found.profile.id)) return { ok: false, reason: "designer-busy" }
  if (!(await instance().health(found.profile.id))) return { ok: false, reason: "toolkit-down" }
  const texts = (value: unknown) =>
    Object.fromEntries(
      Object.entries(value && typeof value === "object" ? value : {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    )
  return runReport(
    { path, params: texts(request.params), filters: texts(request.filters), outBase },
    found.profile,
    (file) => {
      try {
        return readFileSync(file, "utf8").replace(/^﻿/, "")
      } catch {
        return null
      }
    },
    { port: instance().portFor(found.profile.id) },
  )
}

/**
 * `1c_processes`: the 1C processes on the session's infobase, and closing one
 * the app started. failures_to_tools.md T5.
 */
export async function processesForConversation(
  request: { conversationId?: unknown; close?: unknown },
  deps: ProcessDeps = nodeProcessDeps(),
): Promise<{ ok: boolean; text?: string; reason?: string; detail?: string }> {
  const found = conversationProfile(request)
  if (!found.ok) return found
  const all = await deps
    .list()
    .then(parseProcessList)
    .catch((error: unknown) => new Error(String(error)))
  if (all instanceof Error) return { ok: false, reason: "failed", detail: all.message }
  const ours = all.filter((process) => opensInfobase(process.commandLine, found.profile))

  const close = typeof request?.close === "number" ? request.close : undefined
  if (close === undefined) {
    // Only this base's processes are read: another base's dialogs are not this
    // session's business, and the pid list keeps the probe short.
    const dialogs = ours.length && deps.dialogs ? await deps.dialogs(ours.map((process) => process.pid)).catch(() => []) : []
    return { ok: true, text: describeProcesses(ours, deps.selfPid, dialogs) }
  }

  const verdict = closable(ours, close, deps.selfPid)
  if (!verdict.ok) return { ok: false, reason: verdict.reason, ...(verdict.detail ? { detail: verdict.detail } : {}) }
  // The toolkit goes through its supervisor, so its state says "stopped"
  // rather than being discovered later as a death.
  if (verdict.role === "toolkit") await instance().stop(found.profile.id)
  if (verdict.role === "operation") deps.kill(close)
  writeLog("mcp", "1c process closed on request", { pid: close, role: verdict.role })
  return { ok: true, text: `Процесс ${close} закрыт.` }
}

/** `1c_close_dialog`: presses a button in a dialog of a 1C process the app started on this base. debrief15.md §15.2. */
export async function closeDialogForConversation(
  request: { conversationId?: unknown; pid?: unknown; button?: unknown },
  deps: ProcessDeps = nodeProcessDeps(),
): Promise<{ ok: boolean; text?: string; reason?: string; detail?: string }> {
  const found = conversationProfile(request)
  if (!found.ok) return found
  const pid = typeof request?.pid === "number" ? request.pid : Number.NaN
  const button = typeof request?.button === "string" ? request.button.trim() : ""
  if (!Number.isInteger(pid) || !button) return { ok: false, reason: "failed", detail: "нужны pid и button" }
  const all = await deps
    .list()
    .then(parseProcessList)
    .catch((error: unknown) => new Error(String(error)))
  if (all instanceof Error) return { ok: false, reason: "failed", detail: all.message }
  const ours = all.filter((process) => opensInfobase(process.commandLine, found.profile))
  const outcome = await closeDialog(ours, pid, button, deps)
  writeLog("mcp", "1c dialog button", { pid, button, ok: outcome.ok, ...(outcome.ok ? {} : { reason: outcome.reason }) })
  return outcome
}

/**
 * The modal dialogs holding 1C sessions on a conversation's infobase, as text,
 * or "" when there are none or they cannot be read. For the executor's notice
 * that the toolkit stopped answering after a run: with this, it can say what
 * the window says instead of guessing that there is one.
 */
export async function blockingDialogsForConversation(
  request: { conversationId?: unknown },
  deps: ProcessDeps = nodeProcessDeps(),
): Promise<string> {
  const found = conversationProfile(request)
  if (!found.ok || !deps.dialogs) return ""
  const pids = await deps
    .list()
    .then((json) => parseProcessList(json).filter((process) => opensInfobase(process.commandLine, found.profile)))
    .then((processes) => processes.map((process) => process.pid))
    .catch(() => [] as number[])
  if (!pids.length) return ""
  const dialogs = await deps.dialogs(pids).catch(() => [])
  return describeDialogs(dialogs.filter(isBlocking))
}

/** Called on app quit: each toolkit is a 1C window we opened, so we close them all. */
export async function stopMcpToolkit(): Promise<void> {
  await supervisor?.stop()
  supervisor = null
}

/**
 * Closes one conversation's toolkit, before a configurator run on its base.
 * The others serve other bases and stay up.
 */
export async function stopToolkitForConversation(request: { conversationId?: unknown }): Promise<void> {
  const profileId = boundProfileId(request)
  if (profileId) await supervisor?.stop(profileId)
}
