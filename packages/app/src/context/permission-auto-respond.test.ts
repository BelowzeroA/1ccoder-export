import { describe, expect, test } from "bun:test"
import type { PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { autoRespondsPermission, isDirectoryAutoAccepting, sessionAutoAccept } from "./permission-auto-respond"

const session = (input: { id: string; parentID?: string }) =>
  ({
    id: input.id,
    parentID: input.parentID,
  }) as Session

const permission = (sessionID: string) =>
  ({
    sessionID,
  }) as Pick<PermissionRequest, "sessionID">

describe("autoRespondsPermission", () => {
  test("uses a parent session's directory-scoped auto-accept", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/root`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(true)
  })

  test("uses a parent session's legacy auto-accept key", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]

    expect(autoRespondsPermission({ root: true }, sessions, permission("child"), "/tmp/project")).toBe(true)
  })

  test("falls back to the directory's mode when no lineage override exists", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" }), session({ id: "other" })]
    const directory = "/tmp/project"
    // Another session's override says nothing about this one, so the project's
    // own mode decides -- and with no record that is AutoMode.
    expect(autoRespondsPermission({ other: true }, sessions, permission("child"), directory)).toBe(true)
    expect(
      autoRespondsPermission(
        { other: true, [`${base64Encode(directory)}/*`]: false },
        sessions,
        permission("child"),
        directory,
      ),
    ).toBe(false)
  })

  test("inherits a parent session's false override", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/root`]: false,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(false)
  })

  test("prefers a child override over parent override", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/root`]: false,
      [`${base64Encode(directory)}/child`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(true)
  })

  test("falls back to directory-level auto-accept", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("root"), directory)).toBe(true)
    expect(sessionAutoAccept(autoAccept, sessions, permission("root"), directory)).toBeUndefined()
  })

  test("session-level override takes precedence over directory-level", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: true,
      [`${base64Encode(directory)}/root`]: false,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("root"), directory)).toBe(false)
  })

  test("parent false override takes precedence over directory-level auto-accept", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: true,
      [`${base64Encode(directory)}/root`]: false,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(false)
  })

  test("parent true override takes precedence over disabled directory fallback", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: false,
      [`${base64Encode(directory)}/root`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(true)
  })
})

describe("isDirectoryAutoAccepting", () => {
  test("returns true when directory key is set", () => {
    const directory = "/tmp/project"
    const autoAccept = { [`${base64Encode(directory)}/*`]: true }
    expect(isDirectoryAutoAccepting(autoAccept, directory)).toBe(true)
  })

  // 1CCoder default: a project nobody has answered for is in AutoMode. Upstream
  // defaulted to false and the fork asked once with a dialog; that dialog is
  // gone, so "no record" now means the product default rather than "unknown".
  test("treats a directory with no record as auto-accepting", () => {
    expect(isDirectoryAutoAccepting({}, "/tmp/project")).toBe(true)
  })

  test("still honours an explicit switch to manual", () => {
    const directory = "/tmp/project"
    expect(isDirectoryAutoAccepting({ [`${base64Encode(directory)}/*`]: false }, directory)).toBe(false)
  })

  test("returns false when directory key is explicitly false", () => {
    const directory = "/tmp/project"
    const autoAccept = { [`${base64Encode(directory)}/*`]: false }
    expect(isDirectoryAutoAccepting(autoAccept, directory)).toBe(false)
  })
})

// 1CCoder AutoMode: the three always-ask classes outrank every auto-accept
// switch, whether it was set for a directory or for a single session.
describe("always-ask classes under AutoMode", () => {
  const directory = "/tmp/project"
  const sessions = [session({ id: "root" })]
  const bash = (command: string) =>
    ({
      sessionID: "root",
      permission: "bash",
      patterns: [command],
    }) as Pick<PermissionRequest, "sessionID" | "permission" | "patterns">

  test("a directory-wide auto-accept still stops for a destructive delete", () => {
    const autoAccept = { [`${base64Encode(directory)}/*`]: true }
    expect(autoRespondsPermission(autoAccept, sessions, bash("rm -rf build"), directory)).toBe(false)
    expect(autoRespondsPermission(autoAccept, sessions, bash("bun test"), directory)).toBe(true)
  })

  test("a session-scoped auto-accept still stops for a push", () => {
    const autoAccept = { [`${base64Encode(directory)}/root`]: true }
    expect(autoRespondsPermission(autoAccept, sessions, bash("git push origin main"), directory)).toBe(false)
    expect(sessionAutoAccept(autoAccept, sessions, bash("git push origin main"), directory)).toBe(false)
    expect(sessionAutoAccept(autoAccept, sessions, bash("git status"), directory)).toBe(true)
  })

  test("the external directory prompt is answered, since that is the point", () => {
    const autoAccept = { [`${base64Encode(directory)}/*`]: true }
    const request = {
      sessionID: "root",
      permission: "external_directory",
      patterns: ["/other/place"],
    } as Pick<PermissionRequest, "sessionID" | "permission" | "patterns">
    expect(autoRespondsPermission(autoAccept, sessions, request, directory)).toBe(true)
  })
})
