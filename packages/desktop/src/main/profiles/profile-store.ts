// Persistence for developer profiles.
//
// Profiles live on this machine and nowhere else. The 1C user password is
// encrypted with Electron's safeStorage (DPAPI on Windows) and only the
// ciphertext is written; it is never sent to the auth service, never included
// in a diagnostic bundle, and never handed to the renderer. The reasoning is in
// dev_plan.md Phase 6: our backend box is shared with another product and
// already stores confirmation codes in the clear, and customer infobase
// credentials must not join them.
//
// When safeStorage cannot encrypt, we refuse to store the password rather than
// falling back to plaintext -- the rest of the profile still saves, and the
// password is asked for when it is needed.
//
// Like the auth credential in Phase 3, this rides the generic electron-store
// bridge, so it needs no new IPC of its own.

import type { InfobaseConfiguration } from "./configuration"
import {
  normalizeDraft,
  validateDraft,
  type DeveloperProfile,
  type FieldProblem,
  type InfobaseKind,
  type ProfileDraft,
} from "./profile"

export const PROFILE_STORE = "1ccoder.profiles"
export const PROFILES_KEY = "profiles"

/** The stored shape. Differs from DeveloperProfile only by carrying the secret. */
export interface StoredProfile {
  id: string
  accountEmail: string
  name: string
  platformPath: string
  kind: InfobaseKind
  filePath?: string
  serverCluster?: string
  serverDatabase?: string
  workingDirectory: string
  userName: string
  /** Base64 safeStorage ciphertext. Absent when there is no password, or when encryption was unavailable. */
  passwordCipher?: string
  createdAt: number
  updatedAt: number
  lastVerifiedAt?: number
  configuration?: InfobaseConfiguration
  allowWriteWithoutConfirmation?: boolean
}

/**
 * The encryption seam. An interface rather than a direct safeStorage call so
 * the store's behaviour -- including what it does when encryption is
 * unavailable -- is testable without an Electron process.
 */
export interface SecretBox {
  available(): boolean
  encrypt(plain: string): string
  decrypt(cipher: string): string | null
}

/** Everything the store needs from the outside world, so tests can supply all of it. */
export interface StoreDeps {
  readonly read: () => StoredProfile[]
  readonly write: (profiles: StoredProfile[]) => void
  readonly secrets: SecretBox
  readonly now: () => number
  readonly newId: () => string
}

/** Strips the secret. Every path out of this module goes through it. */
export function toPublic(stored: StoredProfile): DeveloperProfile {
  const { passwordCipher, ...rest } = stored
  return { ...rest, hasPassword: Boolean(passwordCipher) }
}

function sameTarget(stored: StoredProfile, draft: ProfileDraft): boolean {
  return (
    stored.kind === draft.kind &&
    (stored.filePath ?? "") === (draft.filePath ?? "") &&
    (stored.serverCluster ?? "") === (draft.serverCluster ?? "") &&
    (stored.serverDatabase ?? "") === (draft.serverDatabase ?? "")
  )
}

export type SaveResult =
  | { readonly ok: true; readonly profile: DeveloperProfile; readonly passwordNotStored: boolean }
  | { readonly ok: false; readonly problems: readonly FieldProblem[] }

export class ProfileStore {
  constructor(private readonly deps: StoreDeps) {}

  /** Every profile, of every account: for what the app sets up once for all of them. */
  all(): DeveloperProfile[] {
    return this.deps.read().map(toPublic)
  }

  list(accountEmail: string): DeveloperProfile[] {
    const wanted = accountEmail.trim().toLowerCase()
    return this.deps
      .read()
      .filter((profile) => profile.accountEmail.toLowerCase() === wanted)
      .map(toPublic)
      .sort((a, b) => a.name.localeCompare(b.name, "ru"))
  }

  get(id: string): DeveloperProfile | null {
    const found = this.deps.read().find((profile) => profile.id === id)
    return found ? toPublic(found) : null
  }

  /**
   * The password, decrypted, for the code that is about to use it. Deliberately
   * separate from get() so that reading a profile for display cannot leak the
   * secret by accident.
   */
  password(id: string): string | null {
    const found = this.deps.read().find((profile) => profile.id === id)
    if (!found?.passwordCipher) return null
    return this.deps.secrets.decrypt(found.passwordCipher)
  }

  /**
   * Creates or updates a profile.
   *
   * `passwordNotStored` comes back true when the user supplied a password that
   * could not be encrypted; the profile is still saved, and the caller is
   * expected to say so rather than let the user believe it was kept.
   */
  save(accountEmail: string, draft: ProfileDraft): SaveResult {
    const normalized = normalizeDraft(draft)
    const problems = validateDraft(normalized)
    if (problems.length) return { ok: false, problems }

    const profiles = this.deps.read()
    const index = normalized.id ? profiles.findIndex((profile) => profile.id === normalized.id) : -1
    const existing = index >= 0 ? profiles[index] : undefined
    const now = this.deps.now()

    let passwordCipher = existing?.passwordCipher
    let passwordNotStored = false
    if (normalized.password !== undefined) {
      if (normalized.password === "") {
        passwordCipher = undefined
      } else if (this.deps.secrets.available()) {
        passwordCipher = this.deps.secrets.encrypt(normalized.password)
      } else {
        passwordCipher = undefined
        passwordNotStored = true
      }
    }

    const stored: StoredProfile = {
      id: existing?.id ?? normalized.id ?? this.deps.newId(),
      accountEmail: existing?.accountEmail ?? accountEmail,
      name: normalized.name,
      platformPath: normalized.platformPath,
      kind: normalized.kind,
      ...(normalized.kind === "file"
        ? { filePath: normalized.filePath }
        : { serverCluster: normalized.serverCluster, serverDatabase: normalized.serverDatabase }),
      workingDirectory: normalized.workingDirectory,
      userName: normalized.userName,
      ...(passwordCipher ? { passwordCipher } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.lastVerifiedAt ? { lastVerifiedAt: existing.lastVerifiedAt } : {}),
      // A detected configuration describes the infobase, so it survives a rename
      // or a new password but not a change of base.
      ...(existing?.configuration && sameTarget(existing, normalized) ? { configuration: existing.configuration } : {}),
      // Set by the form on every save: unticked means off, not "keep".
      ...(normalized.allowWriteWithoutConfirmation ? { allowWriteWithoutConfirmation: true } : {}),
    }

    const next = [...profiles]
    if (index >= 0) next[index] = stored
    else next.push(stored)
    this.deps.write(next)

    return { ok: true, profile: toPublic(stored), passwordNotStored }
  }

  /** Records that verification passed, so the list can show when it last did. */
  markVerified(id: string): void {
    const profiles = this.deps.read()
    const index = profiles.findIndex((profile) => profile.id === id)
    if (index < 0) return
    const next = [...profiles]
    next[index] = { ...profiles[index]!, lastVerifiedAt: this.deps.now() }
    this.deps.write(next)
  }

  /** Records what the infobase runs, as detected from the toolkit or a dump. */
  recordConfiguration(id: string, configuration: InfobaseConfiguration): void {
    const profiles = this.deps.read()
    const index = profiles.findIndex((profile) => profile.id === id)
    if (index < 0) return
    const next = [...profiles]
    next[index] = { ...profiles[index]!, configuration }
    this.deps.write(next)
  }

  remove(id: string): boolean {
    const profiles = this.deps.read()
    const next = profiles.filter((profile) => profile.id !== id)
    if (next.length === profiles.length) return false
    this.deps.write(next)
    return true
  }
}
