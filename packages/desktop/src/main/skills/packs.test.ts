import { describe, expect, test } from "bun:test"

import { overwriteRefusal } from "../infobase/writes"
import { PACK_SKILL_PREFIX, PACKS, packFor, packHint } from "./packs"

// 2026-09-25, skills_rebuild_plan.md Part 2.4 / step 6.

const context = { v8pack: "v8pack", templatesDir: "t", templates: [], referenceDir: "r", vendored: [] }

describe("pack lookup", () => {
  test("finds the pack by the configuration's metadata name", () => {
    expect(packFor("БухгалтерияПредприятия")?.id).toBe("bp30")
  })

  test("finds nothing for a configuration without one, or none at all", () => {
    expect(packFor("УправлениеТорговлей")).toBeUndefined()
    expect(packFor(undefined)).toBeUndefined()
  })

  test("pack ids are unique, so agent and skill names cannot collide", () => {
    const ids = PACKS.map((pack) => pack.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  // A pack without a verified release is a pack of guesses.
  test("every pack names the releases it was checked on", () => {
    for (const pack of PACKS) expect(pack.verifiedOn.length).toBeGreaterThan(0)
  })
})

describe("guard hints", () => {
  const bp30 = packFor("БухгалтерияПредприятия")!

  test("are appended under the configuration's name", () => {
    const hint = packHint(bp30, "overwrite")
    expect(hint).toContain("Для этой конфигурации (Бухгалтерия предприятия 3.0)")
    expect(hint).toContain("ЗаголовокСчетаПоУмолчанию")
  })

  test("add nothing when there is no pack", () => {
    expect(packHint(undefined, "overwrite")).toBe("")
  })

  // The generic refusal stays generic; the pack's names arrive only with the pack.
  test("the refusal without a pack names no БП object, with it names the route", () => {
    const verdict = { overwrites: true, elements: ["Счет-договор"] }
    expect(overwriteRefusal(verdict)).not.toContain("ЗаголовокСчетаПоУмолчанию")
    expect(overwriteRefusal(verdict) + packHint(bp30, "overwrite")).toContain("ЗаголовокСчетаПоУмолчанию")
  })

  // A hint that sends the agent to a skill it cannot load is a dead end.
  test("a hint that names a skill names one the pack actually ships", () => {
    for (const pack of PACKS) {
      const names = pack.skills(context).map((skill) => skill.name)
      for (const hint of Object.values(pack.hints)) {
        for (const named of hint?.match(new RegExp(`${PACK_SKILL_PREFIX}[\\w-]+`, "g")) ?? []) {
          expect(names).toContain(named)
        }
      }
    }
  })
})
