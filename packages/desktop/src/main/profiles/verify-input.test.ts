import { describe, expect, test } from "bun:test"

import { verifyInputFromDraft } from "./verify"
import type { ProfileDraft } from "./profile"

// This seam is where the renderer's draft meets the verification procedure, and
// it is the one place a field can be dropped without anything else noticing:
// the checker's own tests build a complete input by hand, so an omission here
// is invisible to them. It happened -- `workingDirectory` was missing, and the
// working-directory check therefore failed for every profile ever verified,
// reporting "не указан" for a path the user had plainly typed in.

const DRAFT: ProfileDraft = {
  id: "p1",
  name: "Бухгалтерия",
  platformPath: "D:\\Programs\\1cv8\\8.3.27.2342\\bin\\1cv8.exe",
  kind: "file",
  filePath: "D:\\Bases\\Acc",
  workingDirectory: "D:\\Work\\Dynamite\\stage\\",
  userName: "Администратор",
  password: "секрет",
}

describe("verifyInputFromDraft", () => {
  test("carries the working directory, including a trailing separator", () => {
    expect(verifyInputFromDraft(DRAFT, "секрет").workingDirectory).toBe("D:\\Work\\Dynamite\\stage\\")
  })

  test("carries every field the checker needs", () => {
    const input = verifyInputFromDraft(DRAFT, "секрет")
    expect(input).toMatchObject({
      platformPath: DRAFT.platformPath,
      kind: DRAFT.kind,
      filePath: DRAFT.filePath,
      workingDirectory: DRAFT.workingDirectory,
      userName: DRAFT.userName,
      password: "секрет",
    })
  })

  test("carries the server fields for a server infobase", () => {
    const input = verifyInputFromDraft(
      { ...DRAFT, kind: "server", filePath: undefined, serverCluster: "app-1c", serverDatabase: "trade" },
      undefined,
    )
    expect(input.serverCluster).toBe("app-1c")
    expect(input.serverDatabase).toBe("trade")
  })

  /**
   * The guard against this happening again to a field added later: every
   * property of the draft that the verification input also accepts must be
   * forwarded. Only `id` is deliberately absent -- verification takes values,
   * not an identity.
   */
  test("forwards every draft field that verification accepts", () => {
    // Each exclusion needs a reason. A field added to the draft later will fail
    // this test until someone either forwards it or decides, deliberately, that
    // verification does not need it -- which is exactly the decision that was
    // skipped when workingDirectory was dropped.
    const notNeeded: Record<string, string> = {
      id: "verification takes values, not an identity",
      name: "a label for the user, not a connection parameter",
    }

    const input = verifyInputFromDraft(DRAFT, DRAFT.password) as Record<string, unknown>
    for (const [field, value] of Object.entries(DRAFT)) {
      if (field in notNeeded) continue
      expect(input[field]).toEqual(value)
    }
  })

  test("uses the password it is given rather than the one in the draft", () => {
    // The stored password is supplied by the main process when the user did not
    // retype one, so the caller's value has to win.
    expect(verifyInputFromDraft(DRAFT, "из-хранилища").password).toBe("из-хранилища")
  })
})
