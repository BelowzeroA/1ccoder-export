// Startup wiring for 1CCoder managed model access.
//
// Called from main/index.ts before the opencode sidecar is spawned, because the
// sidecar reads provider config at its own startup and the relay port is
// ephemeral -- the config has to name a port that already exists.

import { getStore } from "../store"
import { write as writeLog } from "../logging"
import { LlmRelay, type CreditBalance, type RelayCredential } from "./relay"
import { CREDITS_CHANNELS } from "./credits-channels"
import { DEFAULT_MODEL_LABEL, resolveOpencodeConfigDir, writeProviderConfig } from "./provider-config"
import { installSkillsSafely, resolveBundledResource } from "../skills"
import { electronBindingDeps, electronStoreDeps } from "../profiles/profile-store-electron"
import { ProfileStore } from "../profiles/profile-store"
import { SessionBindingStore } from "../profiles/session-binding"
import { describeProfile, runOperation, type ExecRequest } from "../infobase/executor"
import { profileDumpDirectories } from "../infobase/dump-dirs"
import { startTelemetry } from "../telemetry/electron"
import {
  blockingDialogsForConversation,
  checkDcsForConversation,
  checkEpfForConversation,
  detectConfiguration,
  printCapabilitiesForConversation,
  processesForConversation,
  runReportForConversation,
  closeDialogForConversation,
  toolkitGate,
  startToolkitForConversation,
  stopToolkitForConversation,
  toolkitSnapshot,
} from "../mcp/ipc"

export { resolveOpencodeConfigDir }

const AUTH_STORE = "1ccoder.auth"

let relay: LlmRelay | null = null
let telemetry: ReturnType<typeof startTelemetry> | null = null

/**
 * Reads the credential the auth gate stored. Deliberately read fresh on every
 * call rather than captured once: the relay starts before the user has signed
 * in on a first run, and must pick the credential up mid-session afterwards
 * without a restart.
 */
async function readStoredCredential(): Promise<RelayCredential | null> {
  try {
    const store = getStore(AUTH_STORE)
    const credential = store.get("credential")
    const email = store.get("email")
    if (typeof credential !== "string" || typeof email !== "string") return null
    if (!credential || !email) return null
    return { email, credential }
  } catch {
    return null
  }
}

export async function startManagedModelAccess(): Promise<number | null> {
  try {
    relay = new LlmRelay({
      getCredential: readStoredCredential,
      // The plugin running inside the sidecar asks for infobase work here, so
      // that the credentials never leave this process.
      runInfobaseOperation: (request) =>
        runOperation(request as ExecRequest, {
          profiles: new ProfileStore(electronStoreDeps()),
          bindings: new SessionBindingStore(electronBindingDeps()),
          // A DESIGNER run against a base the toolkit is holding corrupts it.
          // The executor closes the toolkit first; it needs both halves to do
          // that -- one to ask whether it is up, one to shut it.
          //
          // `start` is the third: when the platform never launched at all, the
          // toolkit was shut for nothing, and the executor hands it back rather
          // than charging the user a restart for our failed launch.
          toolkit: {
            snapshot: () => toolkitSnapshot({ conversationId: (request as ExecRequest).conversationId }),
            stop: () => stopToolkitForConversation({ conversationId: (request as ExecRequest).conversationId }),
            start: () =>
              startToolkitForConversation({
                conversationId: (request as ExecRequest).conversationId,
              }),
            dialogs: () =>
              blockingDialogsForConversation({
                conversationId: (request as ExecRequest).conversationId,
              }),
          },
        }),
      // Read-only, and the cheapest way to stop an agent guessing where the
      // platform and the infobase are.
      describeInfobaseProfile: (request) =>
        describeProfile(request as { conversationId: string; detect?: boolean }, {
          profiles: new ProfileStore(electronStoreDeps()),
          bindings: new SessionBindingStore(electronBindingDeps()),
          toolkit: () => toolkitSnapshot(request as { conversationId?: unknown }),
          detectConfiguration: (profileId) => detectConfiguration(profileId),
        }),
      // The lazy counterpart to describeInfobaseProfile: that one reports the
      // toolkit's state, this one asks for it to exist.
      startInfobaseToolkit: (request) => startToolkitForConversation(request as { conversationId?: unknown }),
      describePrintCapabilities: (request) =>
        printCapabilitiesForConversation(request as { conversationId?: unknown; dump?: unknown }),
      infobaseRoutes: {
        "toolkit/gate": (request) => toolkitGate(request as { conversationId?: unknown; directory?: unknown }),
        "check-epf": (request) =>
          checkEpfForConversation(request as { conversationId?: unknown; path?: unknown; expectName?: unknown }),
        "check-dcs": (request) => checkDcsForConversation(request as { conversationId?: unknown; path?: unknown }),
        "run-report": (request) =>
          runReportForConversation(
            request as { conversationId?: unknown; path?: unknown; params?: unknown; filters?: unknown; outBase?: unknown },
          ),
        processes: (request) => processesForConversation(request as { conversationId?: unknown; close?: unknown }),
        "close-dialog": (request) =>
          closeDialogForConversation(request as { conversationId?: unknown; pid?: unknown; button?: unknown }),
      },
      // A broken response stream is the one failure the user feels as a hang
      // rather than an error, so it is the one that most needs a trace in the
      // log to diagnose afterwards.
      log: (message, extra) => writeLog("llm", message, extra, "warn"),
      onBalance: (balance) => void broadcastBalance(balance),
    })
    const port = await relay.start()
    const configDir = resolveOpencodeConfigDir()

    // Installed before the config is written, because the config has to name a
    // directory that already exists -- the same ordering rule the relay port
    // follows, for the same reason: the sidecar reads all of this at its own
    // startup and does not come back for it.
    const { app } = await import("electron")
    const resources = {
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    }
    const installed = await installSkillsSafely({
      configDir,
      cliSource: resolveBundledResource("v8pack-cli.mjs", resources),
      pluginSource: resolveBundledResource("1ccoder-plugin.mjs", resources),
      templatesSource: resolveBundledResource("templates", resources),
      vendorSource: resolveBundledResource("vendor/cc-1c-skills", resources),
      electronPath: process.execPath,
    })

    const configPath = await writeProviderConfig({
      configDir,
      port,
      modelLabel: DEFAULT_MODEL_LABEL,
      skillsDir: installed?.skillsDir ?? null,
      plugin: installed ? { path: installed.pluginPath, baseUrl: `http://127.0.0.1:${port}` } : null,
      // debrief15.md §15.4: reading a profile's configuration dump is the job, not a decision.
      readableDirs: readableDumps(),
      onlyOurProvider: app.isPackaged,
      limits: relay.modelLimits,
    })
    writeLog("llm", "managed model access ready", { port, configPath, skillsDir: installed?.skillsDir })

    // Telemetry rides the relay's server and token. Its own failures stay in
    // its own log lines: it must never cost the user model access.
    try {
      const current = relay
      telemetry = startTelemetry({
        serverUrl: () => current.serverUrl,
        getToken: async () => (await current.getToken())?.token ?? null,
        credential: readStoredCredential,
        skills: () =>
          installed ? { dir: installed.skillsDir, names: installed.skills, vendored: installed.vendored } : null,
      })
    } catch (error) {
      writeLog("telemetry", "failed to start", { error: String(error) }, "warn")
    }
    return port
  } catch (error) {
    // Never block app startup on this. Without it the user simply has no
    // 1CCoder model in the dropdown and can still pick their own provider,
    // which is a far better outcome than an app that will not launch.
    writeLog("llm", "managed model access failed to start", { error: String(error) }, "warn")
    relay = null
    return null
  }
}

/** The credits bridge (preload/1ccoder-credits.ts). Registered once, at startup. */
export async function registerCreditsIpc(): Promise<void> {
  const { ipcMain } = await import("electron")
  ipcMain.handle(CREDITS_CHANNELS.get, async (): Promise<CreditBalance | null> => {
    if (!relay) return null
    return relay.balance ?? (await relay.refreshBalance())
  })
  ipcMain.handle(CREDITS_CHANNELS.server, (): string | null => currentServerUrl())
}

/**
 * The address of our service in use (servers.ts), or null when managed model
 * access did not start. Sign-in and updates follow it.
 */
export function currentServerUrl(): string | null {
  return relay?.serverUrl ?? null
}

async function broadcastBalance(balance: CreditBalance): Promise<void> {
  const { BrowserWindow } = await import("electron")
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(CREDITS_CHANNELS.changed, balance)
}

export async function stopManagedModelAccess(): Promise<void> {
  telemetry?.stop()
  telemetry = null
  await relay?.close().catch(() => undefined)
  relay = null
}

/** The profiles' configuration dumps, read at startup; never fails the start. */
function readableDumps(): string[] {
  try {
    return profileDumpDirectories(new ProfileStore(electronStoreDeps()).all())
  } catch {
    return []
  }
}
