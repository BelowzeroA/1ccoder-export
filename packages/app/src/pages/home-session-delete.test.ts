import { expect, test } from "bun:test"
import { SESSION_TABS_REMOVED_EVENT, readSessionTabsRemovedDetail } from "@/components/titlebar-session-events"
import { deleteHomeSession } from "./home-session-delete"
import type { ServerConnection } from "@/context/server"

const remote = "remote" as ServerConnection.Key

test("deleting a Home session closes its open titlebar tab", async () => {
  let detail: ReturnType<typeof readSessionTabsRemovedDetail>
  let forgotten = false
  window.addEventListener(
    SESSION_TABS_REMOVED_EVENT,
    (event) => {
      detail = readSessionTabsRemovedDetail(event)
    },
    { once: true },
  )

  await deleteHomeSession({
    server: remote,
    session: { id: "ses_1", directory: "/workspace" },
    remove: async () => undefined,
    forget: () => {
      forgotten = true
    },
  })

  expect(forgotten).toBe(true)
  expect(detail).toEqual({ server: remote, directory: "/workspace", sessionIDs: ["ses_1"] })
})

// A row that vanishes from the list while the server still has the session is
// worse than a visible failure: the user believes it is gone.
test("reports delete failures without dropping the session from the list", async () => {
  const failure = new Error("offline")
  let error: unknown
  let forgotten = false

  await deleteHomeSession({
    server: remote,
    session: { id: "ses_1", directory: "/workspace" },
    remove: async () => Promise.reject(failure),
    forget: () => {
      forgotten = true
    },
    onError: (value) => {
      error = value
    },
  })

  expect(error).toBe(failure)
  expect(forgotten).toBe(false)
})

// The bug this closes: the local cleanup and the server call shared one catch,
// so a throw while updating the list was reported as "failed to delete" for a
// session the server had already removed.
test("a failure while forgetting is not reported as a failed delete", async () => {
  const boom = new Error("store is not there")
  let reported: unknown
  let attempt: Promise<void> | undefined

  attempt = deleteHomeSession({
    server: remote,
    session: { id: "ses_1", directory: "/workspace" },
    remove: async () => undefined,
    forget: () => {
      throw boom
    },
    onError: (value) => {
      reported = value
    },
  })

  await expect(attempt).rejects.toThrow(boom)
  expect(reported).toBeUndefined()
})

test("passes the session id to the server call", async () => {
  const asked: string[] = []
  await deleteHomeSession({
    server: remote,
    session: { id: "ses_42", directory: "/workspace" },
    remove: async (sessionID) => {
      asked.push(sessionID)
    },
    forget: () => {},
  })
  expect(asked).toEqual(["ses_42"])
})
