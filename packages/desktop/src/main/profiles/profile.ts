// The DeveloperProfile model: everything the agent needs in order to work
// against one 1C infobase.
//
// An infobase on its own is not enough -- the agent also needs a platform
// binary to run, credentials to log in with, and, for a server infobase, a
// cluster and database name. The profile is that whole bundle, and it is what
// the user picks when starting a session.
//
// Pure by design. Persistence lives in profile-store.ts and verification in
// verify.ts, so the shape and the rules can be tested without Electron.

import type { InfobaseConfiguration } from "./configuration"

export type InfobaseKind = "file" | "server"

/** A profile as the renderer sees it. Never carries the password. */
export interface DeveloperProfile {
  readonly id: string
  /** The account this profile was created under; the list is filtered by it. */
  readonly accountEmail: string
  readonly name: string
  /** Absolute path to the thick client executable, e.g. ...\bin\1cv8.exe. */
  readonly platformPath: string
  readonly kind: InfobaseKind
  readonly filePath?: string
  readonly serverCluster?: string
  readonly serverDatabase?: string
  /**
   * Where the agent keeps everything it produces for this profile: unpacked
   * processings, extracted modules, scratch files.
   *
   * Deliberately NOT opencode's own "project". A project there is a resolved
   * directory with a git-derived id, owned by the core database and its
   * migrations (packages/core/src/project.ts). This field just names a
   * directory; when a session opens there, opencode resolves it into a project
   * on its own, so the two concepts meet without either owning the other. Many
   * profiles may share one working directory; a profile has exactly one.
   */
  readonly workingDirectory: string
  readonly userName: string
  /** True when a password is held for this profile, without revealing it. */
  readonly hasPassword: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastVerifiedAt?: number
  /**
   * The configuration the infobase runs, once something has detected it.
   * Decides which configuration pack the session's agent may load -- see
   * configuration.ts and skills/packs.
   */
  readonly configuration?: InfobaseConfiguration
  /**
   * The user's standing permission to write to this infobase without being
   * asked each time. Off unless the user turned it on for this profile: the
   * default stays always-ask, because a write to live business data is far
   * harder to undo than a file edit. See infobase/plugin.ts, where the asks are.
   */
  readonly allowWriteWithoutConfirmation?: boolean
}

/** What the UI submits. The password, when present, is plaintext in memory only. */
export interface ProfileDraft {
  readonly id?: string
  readonly name: string
  readonly platformPath: string
  readonly kind: InfobaseKind
  readonly filePath?: string
  readonly serverCluster?: string
  readonly serverDatabase?: string
  readonly workingDirectory: string
  readonly userName: string
  /** undefined means "leave whatever is stored alone"; "" means "clear it". */
  readonly password?: string
  /** Absent or false: every write asks. */
  readonly allowWriteWithoutConfirmation?: boolean
}

export type ProfileField =
  | "name"
  | "platformPath"
  | "filePath"
  | "serverCluster"
  | "serverDatabase"
  | "workingDirectory"
  | "userName"

export interface FieldProblem {
  readonly field: ProfileField
  /** A key the renderer resolves against its own ru/en dictionary, not a message. */
  readonly code: "required"
}

/**
 * Structural validation only -- that the fields a given kind needs are filled
 * in. Whether the paths exist and the credentials work is verification's job
 * (verify.ts), which is a different question with a different failure mode.
 *
 * The user name is required even though an infobase may have no users defined:
 * a blank *password* is legal, a blank user is a half-filled form.
 */
export function validateDraft(draft: ProfileDraft): FieldProblem[] {
  const problems: FieldProblem[] = []
  const required = (field: ProfileField, value: string | undefined) => {
    if (!value || !value.trim()) problems.push({ field, code: "required" })
  }

  required("name", draft.name)
  required("platformPath", draft.platformPath)
  required("workingDirectory", draft.workingDirectory)
  required("userName", draft.userName)

  if (draft.kind === "file") {
    required("filePath", draft.filePath)
  } else {
    required("serverCluster", draft.serverCluster)
    required("serverDatabase", draft.serverDatabase)
  }

  return problems
}

/**
 * Normalises a draft: trims every field and drops the ones the chosen kind does
 * not use, so a profile switched from server to file does not keep a stale
 * cluster name that would later confuse verification.
 */
export function normalizeDraft(draft: ProfileDraft): ProfileDraft {
  const trim = (value: string | undefined) => (value ?? "").trim()
  const base = {
    ...(draft.id ? { id: draft.id } : {}),
    name: trim(draft.name),
    platformPath: trim(draft.platformPath),
    kind: draft.kind,
    workingDirectory: trim(draft.workingDirectory),
    userName: trim(draft.userName),
    // Not trimmed: a password may legitimately begin or end with a space.
    ...(draft.password === undefined ? {} : { password: draft.password }),
    ...(draft.allowWriteWithoutConfirmation === true ? { allowWriteWithoutConfirmation: true } : {}),
  }

  return draft.kind === "file"
    ? { ...base, filePath: trim(draft.filePath) }
    : { ...base, serverCluster: trim(draft.serverCluster), serverDatabase: trim(draft.serverDatabase) }
}

/**
 * The connection string this profile describes, in 1C's own syntax.
 *
 * Used for verification and, later, for every batch invocation. Values are
 * quoted and inner quotes doubled, matching what parseConnectionString reads.
 */
export function connectionString(profile: {
  kind: InfobaseKind
  filePath?: string
  serverCluster?: string
  serverDatabase?: string
}): string {
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`
  if (profile.kind === "file") return `File=${quote(profile.filePath ?? "")};`
  return `Srvr=${quote(profile.serverCluster ?? "")};Ref=${quote(profile.serverDatabase ?? "")};`
}

/** A short one-line description for lists and the session caption. */
export function describeTarget(profile: DeveloperProfile): string {
  return profile.kind === "file" ? (profile.filePath ?? "") : `${profile.serverCluster ?? ""}\\${profile.serverDatabase ?? ""}`
}
