import { describe, expect, test } from "bun:test"

import { conversationKey, sessionIdFromPath } from "./conversation-key"

// A session does not exist when the choice is made: opencode creates it lazily,
// on the first message. The key therefore has to work in both phases, and the
// prefixes have to keep them apart -- a draft id and a session id could
// otherwise collide in the same store.
describe("conversationKey", () => {
  test("prefers the session once one exists", () => {
    expect(conversationKey("ses_abc", "draft_1")).toBe("session:ses_abc")
  })

  test("falls back to the draft before the session is created", () => {
    expect(conversationKey(undefined, "draft_1")).toBe("draft:draft_1")
  })

  test("is undefined when there is no conversation at all", () => {
    expect(conversationKey(undefined, undefined)).toBeUndefined()
  })

  test("keeps drafts and sessions in separate namespaces", () => {
    expect(conversationKey("x", undefined)).not.toBe(conversationKey(undefined, "x"))
  })
})

describe("sessionIdFromPath", () => {
  test("reads the id from the current layout's session route", () => {
    expect(sessionIdFromPath("/server/http%3A%2F%2F127.0.0.1%3A123/session/ses_abc")).toBe("ses_abc")
  })

  test("reads the id from the legacy directory route", () => {
    expect(sessionIdFromPath("/ZDpcV29yaw/session/ses_abc")).toBe("ses_abc")
  })

  test("returns undefined where no session is named", () => {
    // The draft route, which carries its id in the query string instead.
    expect(sessionIdFromPath("/new-session")).toBeUndefined()
    expect(sessionIdFromPath("/")).toBeUndefined()
    // Legacy route with the optional id absent.
    expect(sessionIdFromPath("/ZDpcV29yaw/session")).toBeUndefined()
    expect(sessionIdFromPath("/ZDpcV29yaw/session/")).toBeUndefined()
  })
})
