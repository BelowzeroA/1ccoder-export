// Renderer-side bridge for developer profiles.
//
// Fork-owned so that preload/index.ts and preload/types.ts each gain a single
// line, keeping the rebase surface as small as the auth work did.
//
// Note what is absent: there is no way to ask for a password. The renderer can
// send one when the user types it and can see whether a profile has one, and
// that is all.

import { ipcRenderer } from "electron"

import type { DiscoveryResult } from "../main/profiles/discovery"
import type { DeveloperProfile, ProfileDraft } from "../main/profiles/profile"
import type { SaveResult } from "../main/profiles/profile-store"
import type { VerificationResult } from "../main/profiles/verify"
import type { VerifyRequest } from "../main/profiles/ipc"
import type { SessionBinding } from "../main/profiles/session-binding"

export type { DiscoveryResult, DeveloperProfile, ProfileDraft, SaveResult, VerificationResult, VerifyRequest, SessionBinding }

export interface ProfilesApi {
  discover: () => Promise<DiscoveryResult>
  list: (accountEmail: string) => Promise<DeveloperProfile[]>
  save: (accountEmail: string, draft: ProfileDraft) => Promise<SaveResult>
  remove: (id: string) => Promise<boolean>
  verify: (request: VerifyRequest) => Promise<VerificationResult>
  /** null when this session has not been asked yet. See session-binding.ts. */
  getBinding: (sessionId: string) => Promise<SessionBinding | null>
  setBinding: (sessionId: string, profileId: string | null) => Promise<SessionBinding>
}

export const profilesApi: ProfilesApi = {
  discover: () => ipcRenderer.invoke("1ccoder-profiles-discover"),
  list: (accountEmail) => ipcRenderer.invoke("1ccoder-profiles-list", accountEmail),
  save: (accountEmail, draft) => ipcRenderer.invoke("1ccoder-profiles-save", accountEmail, draft),
  remove: (id) => ipcRenderer.invoke("1ccoder-profiles-remove", id),
  verify: (request) => ipcRenderer.invoke("1ccoder-profiles-verify", request),
  getBinding: (sessionId) => ipcRenderer.invoke("1ccoder-session-binding-get", sessionId),
  setBinding: (sessionId, profileId) => ipcRenderer.invoke("1ccoder-session-binding-set", sessionId, profileId),
}
