// The renderer's door into the profile machinery.
//
// Unlike the auth credential in Phase 3, this needs real IPC: scanning the
// registry, reading 1C's config files and launching the platform are all
// main-process work that the generic electron-store bridge cannot express.
//
// Handlers are registered from here rather than from main/ipc.ts so that
// upstream file stays untouched -- see SYSTEM-REFERENCE.md §2.3 on keeping the
// fork's diff small. main/index.ts calls registerProfileIpc() once at startup.
//
// The password is the reason this file is careful. It travels renderer -> main
// when the user types it, and never travels back: no handler here returns a
// password, and toPublic() in profile-store.ts is the only way a profile leaves
// the store.

import { ipcMain, type IpcMainInvokeEvent } from "electron"

import { write as writeLog } from "../logging"
import { discover, type DiscoveryResult } from "./discovery"
import { ProfileStore } from "./profile-store"
import { electronBindingDeps, electronStoreDeps } from "./profile-store-electron"
import { SessionBindingStore, type SessionBinding } from "./session-binding"
import type { DeveloperProfile, ProfileDraft } from "./profile"
import { verifyInputFromDraft, verifyProfile, type VerificationResult } from "./verify"

export const CHANNELS = {
  discover: "1ccoder-profiles-discover",
  bindingGet: "1ccoder-session-binding-get",
  bindingSet: "1ccoder-session-binding-set",
  list: "1ccoder-profiles-list",
  save: "1ccoder-profiles-save",
  remove: "1ccoder-profiles-remove",
  verify: "1ccoder-profiles-verify",
} as const

/**
 * Verification runs against the draft in hand, falling back to the stored
 * password when the user did not retype one -- editing a profile to fix a typo
 * in its path must not force them to enter the password again.
 */
export interface VerifyRequest {
  readonly draft: ProfileDraft
  readonly profileId?: string
}

let store: ProfileStore | null = null
let bindings: SessionBindingStore | null = null

function profileStore(): ProfileStore {
  if (!store) store = new ProfileStore(electronStoreDeps())
  return store
}

function bindingStore(): SessionBindingStore {
  if (!bindings) bindings = new SessionBindingStore(electronBindingDeps())
  return bindings
}

/** Test seam: lets a test drive the handlers against a fake store. */
export function setProfileStoreForTesting(next: ProfileStore | null) {
  store = next
}

async function handleVerify(request: VerifyRequest): Promise<VerificationResult> {
  const { draft, profileId } = request
  const password = draft.password ?? (profileId ? (profileStore().password(profileId) ?? undefined) : undefined)

  const started = Date.now()
  const result = await verifyProfile(verifyInputFromDraft(draft, password))

  // Logged because verification is the slowest and least predictable thing the
  // app does -- it launches 1C and waits -- and without a record of which check
  // reached which verdict, a report of "it said the wrong thing" cannot be
  // chased after the fact. No password is included; `detail` is platform output,
  // which designerArgs keeps the password out of.
  writeLog("profiles", "verification finished", {
    profileId: profileId ?? "(unsaved draft)",
    ok: result.ok,
    ms: Date.now() - started,
    hasPassword: Boolean(password),
    checks: result.checks.map((check) => `${check.id}=${check.status}:${check.code}`),
  })

  // "Проверен" must mean the credentials were actually accepted. `ok` is true
  // even when the credentials check is inconclusive, because an inconclusive
  // result is deliberately non-blocking -- so recording a verification date off
  // `ok` alone claimed more than had been established, notably when 1C sat on
  // its own authentication dialog until our timeout killed it.
  const credentialsPassed = result.checks.some((check) => check.id === "credentials" && check.status === "pass")
  if (result.ok && credentialsPassed && profileId) profileStore().markVerified(profileId)
  return result
}

export function registerProfileIpc() {
  ipcMain.handle(CHANNELS.discover, async (): Promise<DiscoveryResult> => {
    const result = await discover()
    writeLog("profiles", "discovery finished", {
      platforms: result.platforms.length,
      infobases: result.infobases.length,
      skipped: result.skippedInfobases.length,
      problems: result.problems,
    })
    return result
  })

  ipcMain.handle(CHANNELS.list, (_event: IpcMainInvokeEvent, accountEmail: string): DeveloperProfile[] =>
    profileStore().list(accountEmail),
  )

  ipcMain.handle(CHANNELS.save, (_event: IpcMainInvokeEvent, accountEmail: string, draft: ProfileDraft) =>
    profileStore().save(accountEmail, draft),
  )

  ipcMain.handle(CHANNELS.remove, (_event: IpcMainInvokeEvent, id: string): boolean => {
    // A deleted profile must not leave sessions pointing at nothing; those
    // sessions fall back to needing a choice again.
    bindingStore().forgetProfile(id)
    return profileStore().remove(id)
  })

  ipcMain.handle(CHANNELS.bindingGet, (_event: IpcMainInvokeEvent, conversationId: string): SessionBinding | null =>
    bindingStore().get(conversationId),
  )

  ipcMain.handle(
    CHANNELS.bindingSet,
    (_event: IpcMainInvokeEvent, conversationId: string, profileId: string | null): SessionBinding =>
      bindingStore().set(conversationId, profileId),
  )

  ipcMain.handle(CHANNELS.verify, (_event: IpcMainInvokeEvent, request: VerifyRequest) => handleVerify(request))
}
