import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"

import { PACKS } from "./packs"

// 2026-09-25, skills_rebuild_plan.md Part 1 / debrief_fix_principles.md.
//
// Every string in these directories can reach the agent: skill bodies, system
// prompts, tool descriptions, refusals. Fixes written from debriefs kept
// carrying the incident into them -- "8 567 счетов, 21 и 23 сентября", "the
// user already said on the 20th" -- which is false on every other install, and
// БП catalog names, which do not exist in УТ. Nine debriefs of prose showed that
// "remember not to" does not hold, so this is a check rather than a guideline.
//
// It reads the source rather than calling the builders, because most of the
// text lives inside closures in plugin.ts and a new string should be covered
// without anyone having to register it. Comments are not strings, so the
// incident history stays where it belongs: in the `//` above the code.

const ROOT = join(import.meta.dir, "..")
const DIRS = ["skills", "skills/packs", "infobase", "mcp"]

/**
 * Names that exist in one configuration family only. They belong in that
 * configuration's pack (skills/packs), not in text every profile session reads.
 * Each pack declares its own; the extras are verified configuration-only names
 * that no pack uses yet (УТ 11.5.7.390, skills_cleansing.md Part 2).
 */
const NOT_IN_A_PACK_YET = ["СчетНаОплатуКлиенту"]
const CONFIGURATION_ONLY: readonly { name: string; home?: string }[] = [
  ...PACKS.flatMap((pack) => pack.identifiers.map((name) => ({ name, home: `skills/packs/${pack.id}.ts` }))),
  ...NOT_IN_A_PACK_YET.map((name) => ({ name })),
]

const MONTHS = "января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря"

const RULES: readonly { name: string; pattern: RegExp; allow?: readonly RegExp[]; home?: string }[] = [
  // A literal that is nothing but a date is an identifier -- the MCP protocol
  // version is "2025-03-26" -- not a sentence about when something happened.
  { name: "calendar date", pattern: /\b20\d\d-\d\d-\d\d\b/, allow: [/^20\d\d-\d\d-\d\d$/] },
  { name: "calendar date", pattern: new RegExp(`\\d{1,2}(?:\\s+и\\s+\\d{1,2})?\\s+(?:${MONTHS})`, "iu") },
  {
    name: "episode counter",
    pattern: /(?<!\p{L})(?:однажды|трижды|оба раза|в прошлый раз|уже оказывал|уже говорил|уже дважды|уже переписал)/iu,
  },
  {
    // «Одинаковая ошибка на одинаковый вызов дважды» is a rule about the
    // current task, not a memory of an old one.
    name: "episode counter",
    pattern: /(?<!\p{L})дважды(?!\p{L})/iu,
    allow: [/вызов дважды/iu, /^дважды и числа разошлись/iu],
  },
  { name: "cost anecdote", pattern: /стоил[оа]?\s[^.]{0,40}(?:сеанс|час|вечер|попытк|диагноз)/iu },
  { name: "skill self-history", pattern: /раньше в этом навыке/iu },
  ...CONFIGURATION_ONLY.map((entry) => ({
    name: `configuration-only name ${entry.name}`,
    pattern: new RegExp(entry.name, "u"),
    home: entry.home,
  })),
]

interface Literal {
  readonly file: string
  readonly line: number
  readonly text: string
}

function sources(): string[] {
  return DIRS.flatMap((dir) =>
    readdirSync(join(ROOT, dir))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => join(ROOT, dir, name)),
  )
}

function literals(path: string): Literal[] {
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true)
  const found: Literal[] = []
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      found.push({
        file: relative(ROOT, path).replaceAll("\\", "/"),
        line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        text: node.text,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

const ALL = sources().flatMap(literals)

function violations(rule: (typeof RULES)[number]): string[] {
  return ALL.filter((literal) => rule.pattern.test(literal.text))
    .filter((literal) => !rule.allow?.some((allow) => allow.test(literal.text)))
    // A pack's own names are at home in its own file, and nowhere else.
    .filter((literal) => literal.file !== rule.home)
    .map((literal) => `${literal.file}:${literal.line}  ${literal.text.trim().slice(0, 100)}`)
}

describe("agent-facing text", () => {
  // A scanner that silently found nothing would pass every rule below.
  test("is actually being read", () => {
    expect(sources().length).toBeGreaterThan(10)
    expect(ALL.length).toBeGreaterThan(1000)
    expect(ALL.some((literal) => literal.file === "infobase/plugin.ts")).toBe(true)
  })

  for (const rule of RULES) {
    test(`carries no ${rule.name} (rule ${RULES.indexOf(rule) + 1})`, () => {
      expect(violations(rule)).toEqual([])
    })
  }
})

describe("the rules themselves", () => {
  const hits = (text: string) => RULES.filter((rule) => rule.pattern.test(text) && !rule.allow?.some((a) => a.test(text)))

  test("catch the text they were written for", () => {
    expect(hits("Такой цикл уже дважды переписал все счета — 21 и 23 сентября.")).not.toEqual([])
    expect(hits("пользователь уже говорил 20 сентября")).not.toEqual([])
    expect(hits("Установлено сравнением выгрузок (2026-09-23)")).not.toEqual([])
    expect(hits("Это стоило трёх сеансов и трёх разных объяснений")).not.toEqual([])
    expect(hits("хотя раньше в этом навыке было написано обратное")).not.toEqual([])
    expect(hits("`Справочник.ЗаголовкиСчетовПокупателям` — данные")).not.toEqual([])
  })

  test("leave rules about the current task alone", () => {
    expect(hits("Одинаковая ошибка на одинаковый вызов дважды — сигнал идти за фактами")).toEqual([])
    expect(hits("Запись в рабочую базу — решение пользователя, а не твоё.")).toEqual([])
  })
})
