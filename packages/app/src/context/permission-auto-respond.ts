import { base64Encode } from "@opencode-ai/core/util/encode"
import { isAlwaysAsk, type ClassifiableRequest } from "@/automode/policy"

export function acceptKey(sessionID: string, directory?: string) {
  if (!directory) return sessionID
  return `${base64Encode(directory)}/${sessionID}`
}

export function directoryAcceptKey(directory: string) {
  return `${base64Encode(directory)}/*`
}

function accepted(autoAccept: Record<string, boolean>, sessionID: string, directory?: string) {
  const key = acceptKey(sessionID, directory)
  return autoAccept[key] ?? autoAccept[sessionID]
}

/**
 * 1CCoder: a project with no recorded choice is in AutoMode.
 *
 * Upstream defaulted this to false and the fork used to ask once per project
 * with a dialog, which is why the stored value was a tri-state. The dialog is
 * gone -- it blocked the app on every first open to explain a mode the user can
 * see and change in the composer -- so "never answered" now simply means the
 * product default, and only an explicit switch to manual writes false.
 */
export function isDirectoryAutoAccepting(autoAccept: Record<string, boolean>, directory: string) {
  const key = directoryAcceptKey(directory)
  return autoAccept[key] ?? true
}

function sessionLineage(session: { id: string; parentID?: string }[], sessionID: string) {
  const parent = session.reduce((acc, item) => {
    if (item.parentID) acc.set(item.id, item.parentID)
    return acc
  }, new Map<string, string>())
  const seen = new Set([sessionID])
  const ids = [sessionID]

  for (const id of ids) {
    const parentID = parent.get(id)
    if (!parentID || seen.has(parentID)) continue
    seen.add(parentID)
    ids.push(parentID)
  }

  return ids
}

export function autoRespondsPermission(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string } & ClassifiableRequest,
  directory?: string,
) {
  // 1CCoder AutoMode: three classes of request are never answered for the user,
  // however broadly auto-accept is switched on. See automode/policy.ts.
  if (isAlwaysAsk(permission)) return false
  const value = sessionAutoAccept(autoAccept, session, permission, directory)
  if (value !== undefined) return value
  return directory ? isDirectoryAutoAccepting(autoAccept, directory) : false
}

export function sessionAutoAccept(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string } & ClassifiableRequest,
  directory?: string,
) {
  // Also guarded here, not only in autoRespondsPermission: this is called
  // directly as a session-scoped override, which would otherwise bypass the
  // always-ask classes entirely.
  if (isAlwaysAsk(permission)) return false
  return sessionLineage(session, permission.sessionID)
    .map((id) => accepted(autoAccept, id, directory))
    .find((item): item is boolean => item !== undefined)
}
