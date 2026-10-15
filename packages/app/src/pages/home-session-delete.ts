import { notifySessionTabsRemoved } from "@/components/titlebar-session-events"
import type { ServerConnection } from "@/context/server"

type HomeSession = {
  id: string
  directory: string
}

/**
 * Deleting a session from the home list.
 *
 * Shaped like archiveHomeSession, and for the same reason: the caller owns the
 * server call and the local store, this owns the order. The difference is that
 * archiving is reversible and this is not, so the caller is expected to have
 * asked the user first.
 */
export async function deleteHomeSession(input: {
  server: ServerConnection.Key
  session: HomeSession
  remove: (sessionID: string) => Promise<unknown>
  forget: () => void
  onError?: (error: unknown) => void
}) {
  try {
    await input.remove(input.session.id)
  } catch (error) {
    // Only the server call is reported as a failed delete. Wrapping the local
    // cleanup in the same catch made a throw in forget() look like the session
    // had survived, when it was already gone -- the row stayed and the toast
    // lied about why.
    input.onError?.(error)
    return
  }

  input.forget()
  // Any tab showing the session now points at something the server no longer
  // has. Closing them is part of the delete, not a follow-up.
  notifySessionTabsRemoved({
    server: input.server,
    directory: input.session.directory,
    sessionIDs: [input.session.id],
  })
}
