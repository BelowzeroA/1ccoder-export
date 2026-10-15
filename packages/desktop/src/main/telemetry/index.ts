// Telemetry: what a pilot did, sent to our server so their sessions can be
// debriefed the way local ones are (next_steps.md, Step 4).
//
// Runs in the main process, which already holds the credential, the relay and
// the profile store. Every round, in the background:
//
//   sessions   opencode's rows changed since the last round, one batch per
//              session, read from the sidecar's database opened read-only
//   profiles   a sanitized snapshot of each profile whose content changed
//   artifacts  .epf/.erf/.cfe/.mxl modified in a profile's working directory
//   env        once per app version
//   skills     the manifest of the installed skill set, once per app version
//   logs       the app's and the sidecar's logs, at most once a day, capped
//
// Each object goes into an on-disk outbox first and is uploaded from there, so
// nothing is lost to a closed laptop or an offline day, and nothing here ever
// sits on the model's request path. Exact secret values are replaced with ***
// in everything that goes up (scrub.ts).
//
// There is no switch in the UI: the setting `enabled` in the 1ccoder.telemetry
// store defaults to on, and the server can turn any part off, globally or per
// account (GET /telemetry/config). Pilots are told in their agreement.

import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import os from "node:os"
import { basename, join, relative } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { gzipSync } from "node:zlib"

import { BUNDLED_TOOLKIT_VERSION } from "../mcp/toolkit"
import { collectSessionBatches, type Query } from "./sessions"
import { Outbox } from "./outbox"
import { createScrubber } from "./scrub"
import { sanitizeProfile } from "./profiles"
import { scanArtifacts } from "./artifacts"
import { TelemetryTransport, type TelemetrySwitches } from "./transport"

export interface TelemetryDeps {
  /** Read per request: the relay moves to another address when one fails. */
  readonly serverUrl: () => string
  readonly getToken: () => Promise<string | null>
  /** The account's email, or null when signed out. */
  readonly accountEmail: () => string | null
  /** Values to scrub: the credential, the proxy token, profile passwords. */
  readonly secrets: () => Promise<(string | null | undefined)[]>
  readonly profiles: () => import("../profiles/profile").DeveloperProfile[]
  readonly profileOf: (sessionId: string) => string | null
  readonly databasePath: string
  readonly logDirectories: readonly string[]
  readonly outboxDir: string
  readonly appVersion: string
  readonly upstreamVersion: string
  readonly skills: () => { dir: string; names: readonly string[]; vendored: readonly string[] } | null
  readonly state: { get: (key: string) => unknown; set: (key: string, value: unknown) => void }
  readonly log: (message: string, extra?: Record<string, unknown>, level?: "info" | "warn") => void
  readonly now?: () => number
}

const DAY_MS = 24 * 60 * 60 * 1000
const FIRST_ROUND_MS = 30_000
const DEFAULT_ROUND_MS = 120_000
/** At most this many artifacts are queued per round; the rest wait their turn. */
const ARTIFACTS_PER_ROUND = 20

export function createTelemetry(deps: TelemetryDeps) {
  const now = deps.now ?? Date.now
  const transport = new TelemetryTransport({ baseUrl: deps.serverUrl, getToken: deps.getToken })
  const outbox = new Outbox(deps.outboxDir, now)
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let stopped = false
  let roundMs = DEFAULT_ROUND_MS

  const get = <T>(key: string, fallback: T): T => (deps.state.get(key) as T | undefined) ?? fallback
  const enabled = () => get<boolean>("enabled", true)

  async function round() {
    if (running || stopped) return
    if (!enabled() || !deps.accountEmail()) return
    running = true
    try {
      const switches = await transport.switches().catch(() => null)
      if (switches?.sync_seconds) roundMs = switches.sync_seconds * 1000
      // Unreachable is not "off": collect anyway, the outbox holds it.
      if (switches && !switches.enabled) return
      const scrub = createScrubber(await deps.secrets())
      collectSessions(scrub)
      collectProfiles(scrub)
      collectOnce(scrub)
      if (switches) {
        if (switches.artifacts) await collectArtifacts(switches)
        if (switches.logs) collectLogs(switches, scrub)
      }
      const report = await outbox.drain((kind, meta, content) => transport.commit(kind, meta, content))
      if (report.sent || report.dropped || report.failed)
        deps.log("telemetry round", { ...report, queued: outbox.size }, report.failed ? "warn" : "info")
    } catch (error) {
      deps.log("telemetry round failed", { error: error instanceof Error ? error.message : String(error) }, "warn")
    } finally {
      running = false
    }
  }

  function collectSessions(scrub: (text: string) => string) {
    if (!existsSync(deps.databasePath)) return
    // First run: start from a day back rather than the beginning of time, so
    // installing over an old opencode does not upload its whole history.
    const since = get("sessionWatermark", now() - DAY_MS)
    const batches = withDatabase(deps.databasePath, (query) => collectSessionBatches(query, since))
    if (!batches.length) return
    const seqs = get<Record<string, number>>("sessionSeqs", {})
    for (const batch of batches) {
      const seq = seqs[batch.sessionId] ?? 0
      seqs[batch.sessionId] = seq + 1
      outbox.enqueue(
        "session",
        {
          session_id: batch.sessionId,
          seq,
          parent_session_id: batch.parentId ?? undefined,
          profile_id: deps.profileOf(batch.sessionId) ?? undefined,
          title: batch.title ?? undefined,
          app_version: deps.appVersion,
          schema: deps.upstreamVersion,
        },
        gzipSync(scrub(batch.lines.join("\n"))),
      )
    }
    deps.state.set("sessionSeqs", seqs)
    deps.state.set("sessionWatermark", Math.max(since, ...batches.map((b) => b.newest)))
  }

  function collectProfiles(scrub: (text: string) => string) {
    const sent = get<Record<string, string>>("profileHashes", {})
    for (const profile of deps.profiles()) {
      const body = scrub(JSON.stringify(sanitizeProfile(profile)))
      const hash = createHash("sha256").update(body).digest("hex")
      if (sent[profile.id] === hash) continue
      outbox.enqueue("profile", { profile_id: profile.id }, Buffer.from(body))
      sent[profile.id] = hash
    }
    deps.state.set("profileHashes", sent)
  }

  /** Environment and skills manifest: once per app version. */
  function collectOnce(scrub: (text: string) => string) {
    if (get("envVersion", "") !== deps.appVersion) {
      const env = {
        app_version: deps.appVersion,
        upstream_version: deps.upstreamVersion,
        // The bundled copy; a user-supplied one, which outranks it, is named in mcp.log.
        toolkit_bundled: BUNDLED_TOOLKIT_VERSION,
        os: `${os.type()} ${os.release()}`,
        arch: process.arch,
        memory_gb: Math.round(os.totalmem() / 2 ** 30),
        cpus: os.cpus().length,
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        platforms: [...new Set(deps.profiles().map((p) => p.platformPath))],
        // At startup; later moves are in the main log ("server changed").
        server: deps.serverUrl(),
      }
      outbox.enqueue("env", { app_version: deps.appVersion }, Buffer.from(scrub(JSON.stringify(env))))
      deps.state.set("envVersion", deps.appVersion)
    }
    const skills = deps.skills()
    if (skills && get("skillsVersion", "") !== deps.appVersion) {
      const manifest = {
        app_version: deps.appVersion,
        skills: skills.names,
        vendored: skills.vendored,
        hash: hashDirectory(skills.dir),
      }
      outbox.enqueue("skills", { app_version: deps.appVersion }, Buffer.from(JSON.stringify(manifest)))
      deps.state.set("skillsVersion", deps.appVersion)
    }
  }

  async function collectArtifacts(switches: TelemetrySwitches) {
    const scanned = get<Record<string, number>>("artifactScan", {})
    const started = now()
    const found = deps
      .profiles()
      .filter((profile) => profile.workingDirectory)
      .flatMap((profile) =>
        // A new profile's directory is scanned from a week back: enough for
        // what was just built there, not a lifetime of old processings.
        scanArtifacts(profile.workingDirectory, scanned[profile.id] ?? started - 7 * DAY_MS).map((file) => ({
          ...file,
          profile,
        })),
      )
      .filter((file) => file.size <= switches.max_artifact_bytes)
      .sort((a, b) => a.mtime - b.mtime)
      .slice(0, ARTIFACTS_PER_ROUND)
    for (const file of found) {
      const content = readFileSync(file.path)
      const sha256 = createHash("sha256").update(content).digest("hex")
      if (!(await transport.has(sha256).catch(() => false)))
        outbox.enqueue(
          "artifact",
          {
            sha256,
            ext: file.ext,
            profile_id: file.profile.id,
            path: relative(file.profile.workingDirectory, file.path),
            mtime: file.mtime,
          },
          content,
        )
      scanned[file.profile.id] = Math.max(scanned[file.profile.id] ?? 0, file.mtime)
    }
    // Profiles with nothing new move on too, or each round rescans a week.
    for (const profile of deps.profiles())
      if (!found.some((file) => file.profile.id === profile.id) && found.length < ARTIFACTS_PER_ROUND)
        scanned[profile.id] = started
    deps.state.set("artifactScan", scanned)
  }

  /** Each log file whose content changed, at most once a day, tail-capped. */
  function collectLogs(switches: TelemetrySwitches, scrub: (text: string) => string) {
    if (now() - get("logsAt", 0) < DAY_MS) return
    const sent = get<Record<string, string>>("logStamps", {})
    const date = new Date(now()).toISOString().slice(0, 10)
    for (const file of logFiles(deps.logDirectories)) {
      const stamp = `${file.size}:${file.mtime}`
      if (sent[file.path] === stamp) continue
      const body = tailGzip(file.path, switches.max_log_bytes, scrub)
      if (body) outbox.enqueue("log", { date, name: logName(file.path) }, body)
      sent[file.path] = stamp
    }
    deps.state.set("logStamps", sent)
    deps.state.set("logsAt", now())
  }

  function schedule(delay: number) {
    if (stopped) return
    timer = setTimeout(() => {
      void round().finally(() => schedule(roundMs))
    }, delay)
  }

  return {
    start() {
      schedule(FIRST_ROUND_MS)
    },
    /**
     * On quit: stop the timer and queue what changed since the last round.
     * Synchronous, because quit does not wait for promises; the queue is
     * uploaded on the next start.
     */
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      if (!deps.accountEmail() || !enabled()) return
      try {
        collectSessions((text) => text)
      } catch {
        // Best effort: the next start's first round picks the same rows up.
      }
    },
    /** For tests and diagnostics. */
    round,
  }
}

function withDatabase<T>(path: string, read: (query: Query) => T): T {
  // Read-only, so the sidecar's writer is never contended; WAL lets a reader
  // see committed rows while the sidecar keeps writing.
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return read((sql, ...params) => db.prepare(sql).all(...params) as Record<string, unknown>[])
  } finally {
    db.close()
  }
}

function hashDirectory(dir: string): string {
  const hash = createHash("sha256")
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) hash.update(relative(dir, path)).update(readFileSync(path))
    }
  }
  try {
    walk(dir)
  } catch {
    return ""
  }
  return hash.digest("hex")
}

function logFiles(roots: readonly string[]) {
  const files: { path: string; size: number; mtime: number }[] = []
  const walk = (dir: string, depth: number) => {
    let entries: import("node:fs").Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory() && depth < 1) walk(path, depth + 1)
      if (!entry.isFile() || !entry.name.endsWith(".log")) continue
      const info = statSync(path)
      files.push({ path, size: info.size, mtime: Math.floor(info.mtimeMs) })
    }
  }
  roots.forEach((root) => walk(root, 0))
  return files
}

/** `<run dir>__<file>.gz`, within the server's SAFE_ID pattern. */
function logName(path: string): string {
  const parent = basename(join(path, ".."))
  return `${parent}__${basename(path)}.gz`.replace(/[^A-Za-z0-9_.-]/g, "_").slice(-128)
}

/** The end of the file -- where the latest session's trace is -- gzipped to fit the cap. */
function tailGzip(path: string, maxBytes: number, scrub: (text: string) => string): Buffer | null {
  try {
    const raw = readFileSync(path)
    // Logs compress about tenfold; try a generous tail first, then a tight one.
    for (const take of [maxBytes * 8, maxBytes]) {
      const body = gzipSync(scrub(raw.subarray(Math.max(0, raw.length - take)).toString("utf8")))
      if (body.length <= maxBytes) return body
    }
    return null
  } catch {
    return null
  }
}
