// Telemetry's ties to the running app: where things are, who is signed in,
// what to scrub. Kept apart from index.ts so that one stays testable without
// Electron.

import { app } from "electron"
import { join } from "node:path"

import { UPSTREAM_VERSION } from "../constants"
import { DATABASE_FILE, serverDataDirectory } from "../database"
import { write as writeLog } from "../logging"
import { electronBindingDeps, electronStoreDeps } from "../profiles/profile-store-electron"
import { ProfileStore } from "../profiles/profile-store"
import { SessionBindingStore } from "../profiles/session-binding"
import { getStore } from "../store"
import { createTelemetry } from "./index"

const STATE_STORE = "1ccoder.telemetry"

export interface TelemetryInputs {
  readonly serverUrl: () => string
  readonly getToken: () => Promise<string | null>
  readonly credential: () => Promise<{ email: string; credential: string } | null>
  readonly skills: () => { dir: string; names: readonly string[]; vendored: readonly string[] } | null
}

export function startTelemetry(inputs: TelemetryInputs) {
  const state = getStore(STATE_STORE)
  const profiles = new ProfileStore(electronStoreDeps())
  const bindings = new SessionBindingStore(electronBindingDeps())
  const auth = getStore("1ccoder.auth")
  const email = () => {
    const value = auth.get("email")
    return typeof value === "string" && value ? value : null
  }

  const telemetry = createTelemetry({
    serverUrl: inputs.serverUrl,
    getToken: inputs.getToken,
    accountEmail: email,
    secrets: async () => {
      const own = email()
      const credential = await inputs.credential()
      return [
        credential?.credential,
        await inputs.getToken(),
        ...(own ? profiles.list(own) : []).map((profile) => profiles.password(profile.id)),
      ]
    },
    profiles: () => {
      const own = email()
      return own ? profiles.list(own) : []
    },
    // Bindings are keyed by conversation, `session:<id>` once the draft is
    // promoted (renderer/profiles/conversation-key.ts).
    profileOf: (sessionId) => bindings.get(`session:${sessionId}`)?.profileId ?? null,
    databasePath: join(serverDataDirectory(), process.env.OPENCODE_DB || DATABASE_FILE),
    logDirectories: [join(app.getPath("userData"), "logs"), join(serverDataDirectory(), "log")],
    outboxDir: join(app.getPath("userData"), "telemetry-outbox"),
    appVersion: app.getVersion(),
    upstreamVersion: UPSTREAM_VERSION,
    skills: inputs.skills,
    state: { get: (key) => state.get(key), set: (key, value) => state.set(key, value) },
    log: (message, extra, level = "info") => writeLog("telemetry", message, extra, level),
  })
  telemetry.start()
  return telemetry
}
