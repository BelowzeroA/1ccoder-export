// Renderer-side access to the profile machinery.
//
// Types are derived from the preload bridge rather than imported across the
// process boundary, matching what ../auth/credential.ts does with the store
// bridge. Note what cannot be expressed here: there is no call that returns a
// password. The renderer can send one and can see whether a profile has one.

type ProfilesApi = typeof window.api.profiles

export type DiscoveryResult = Awaited<ReturnType<ProfilesApi["discover"]>>
export type DiscoveredPlatform = DiscoveryResult["platforms"][number]
export type DiscoveredInfobase = DiscoveryResult["infobases"][number]
export type DeveloperProfile = Awaited<ReturnType<ProfilesApi["list"]>>[number]
export type ProfileDraft = Parameters<ProfilesApi["save"]>[1]
export type SaveResult = Awaited<ReturnType<ProfilesApi["save"]>>
export type VerificationResult = Awaited<ReturnType<ProfilesApi["verify"]>>
export type CheckResult = VerificationResult["checks"][number]

function api(): ProfilesApi {
  return window.api.profiles
}

export const discover = () => api().discover()
export const listProfiles = (accountEmail: string) => api().list(accountEmail)
export const saveProfile = (accountEmail: string, draft: ProfileDraft) => api().save(accountEmail, draft)
export const removeProfile = (id: string) => api().remove(id)
export const verifyProfile = (draft: ProfileDraft, profileId?: string) =>
  api().verify(profileId ? { draft, profileId } : { draft })

/**
 * The MCP Toolkit that serves the bound infobase.
 *
 * Asking for it is all the renderer can do: which .epf, which port and which
 * password are the main process's business (see main/mcp/supervisor.ts).
 */
export type ToolkitStatus = Awaited<ReturnType<typeof window.api.mcp.ensure>>

export const ensureToolkit = (profileId: string) => window.api.mcp.ensure(profileId)

/**
 * Whether the toolkit's port answers right now. Asked on a timer while a
 * profile session is open -- see toolkit-link.ts for why that is necessary.
 */
export const toolkitHealth = (profileId?: string) => window.api.mcp.health(profileId)

/**
 * The port of a profile's toolkit, recorded as the one a session folder's MCP
 * client now points at (main/mcp/ipc.ts linkToolkit). Null without a profile.
 */
export const linkToolkit = (directory: string | undefined, profileId: string) => window.api.mcp.link(directory, profileId)

export type SessionBinding = Awaited<ReturnType<ProfilesApi["setBinding"]>>

/** null means this session has not been asked yet -- see main/profiles/session-binding.ts. */
export const getBinding = (sessionId: string) => api().getBinding(sessionId)
export const setBinding = (sessionId: string, profileId: string | null) => api().setBinding(sessionId, profileId)

/**
 * Turns a stored profile back into the draft shape verification takes. The
 * password is deliberately absent: the main process fills it in from the store
 * by profile id, so the secret never travels to the renderer and back.
 */
export function draftFromProfile(profile: DeveloperProfile): ProfileDraft {
  return {
    id: profile.id,
    name: profile.name,
    platformPath: profile.platformPath,
    kind: profile.kind,
    filePath: profile.filePath,
    serverCluster: profile.serverCluster,
    serverDatabase: profile.serverDatabase,
    workingDirectory: profile.workingDirectory,
    userName: profile.userName,
    ...(profile.allowWriteWithoutConfirmation ? { allowWriteWithoutConfirmation: true } : {}),
  }
}

/**
 * The same required-field rules as validateDraft in
 * main/profiles/profile.ts, applied before we spend five seconds launching 1C
 * against a half-filled form. That file remains the authority: the store
 * re-checks on save and would reject anything this missed.
 */
export function missingFields(draft: ProfileDraft): string[] {
  const missing: string[] = []
  const blank = (value: string | undefined) => !value || !value.trim()

  if (blank(draft.name)) missing.push("name")
  if (blank(draft.platformPath)) missing.push("platformPath")
  if (blank(draft.workingDirectory)) missing.push("workingDirectory")
  if (blank(draft.userName)) missing.push("userName")
  if (draft.kind === "file") {
    if (blank(draft.filePath)) missing.push("filePath")
  } else {
    if (blank(draft.serverCluster)) missing.push("serverCluster")
    if (blank(draft.serverDatabase)) missing.push("serverDatabase")
  }

  return missing
}

/**
 * Turns a name into a usable directory segment. Infobase names are free text and
 * routinely contain characters Windows will not accept in a path.
 */
export function sanitizeSegment(name: string): string {
  // Reserved on Windows: < > : " / \ | ? * and the control characters. A
  // trailing dot or space is rejected by the filesystem too, and silently.
  const cleaned = name
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim()
    .replace(/[. ]+$/, "")
  return cleaned || "profile"
}

/** Where a new profile's working directory is suggested. Only a suggestion. */
export function suggestWorkingDirectory(root: string, name: string): string {
  if (!root) return ""
  const separator = root.includes("/") && !root.includes("\\") ? "/" : "\\"
  return `${root.replace(/[\\/]+$/, "")}${separator}${sanitizeSegment(name)}`
}

/** Fills a draft from an infobase 1C already knows about. */
export function draftFromInfobase(
  infobase: DiscoveredInfobase,
  platformPath: string,
  workspaceRoot: string,
): ProfileDraft {
  const target = infobase.target
  return {
    name: infobase.name,
    platformPath,
    workingDirectory: suggestWorkingDirectory(workspaceRoot, infobase.name),
    kind: target.kind,
    ...(target.kind === "file"
      ? { filePath: target.filePath }
      : { serverCluster: target.serverCluster, serverDatabase: target.serverDatabase }),
    userName: infobase.suggestedUser ?? "",
    password: "",
  }
}

export function formatTimestamp(value: number, locale: string | undefined): string {
  try {
    return new Date(value).toLocaleString(locale === "en" ? "en" : "ru")
  } catch {
    return new Date(value).toISOString()
  }
}
