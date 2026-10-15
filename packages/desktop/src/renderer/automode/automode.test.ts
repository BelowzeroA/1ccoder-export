import { describe, expect, test } from "bun:test"

import { decodeDirectory, projectName } from "./directory"
import { autoModeDict, en, ru } from "./i18n"

describe("decodeDirectory", () => {
  // Must stay byte-compatible with @opencode-ai/core/util/encode's
  // base64Encode, which the router uses to put a directory in the URL: URL-safe
  // alphabet, no padding, UTF-8 payload.
  const encode = (value: string) =>
    btoa(Array.from(new TextEncoder().encode(value), (b) => String.fromCharCode(b)).join(""))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "")

  test("round-trips a Windows path", () => {
    const directory = "D:\\Work\\Projects\\1ccoder"
    expect(decodeDirectory(encode(directory))).toBe(directory)
  })

  test("round-trips a path with Cyrillic characters", () => {
    const directory = "D:\\Работа\\БазаКлиента"
    expect(decodeDirectory(encode(directory))).toBe(directory)
  })

  test("returns undefined for missing or malformed input", () => {
    expect(decodeDirectory(undefined)).toBeUndefined()
    expect(decodeDirectory("")).toBeUndefined()
    expect(decodeDirectory("!!!not base64!!!")).toBeUndefined()
  })
})

describe("projectName", () => {
  test("uses the last path segment, on either separator", () => {
    expect(projectName("D:\\Work\\Projects\\1ccoder")).toBe("1ccoder")
    expect(projectName("/home/dev/projects/retail-base")).toBe("retail-base")
  })

  test("tolerates a trailing separator", () => {
    expect(projectName("D:\\Work\\Projects\\1ccoder\\")).toBe("1ccoder")
  })
})

describe("automode dictionary", () => {
  test("Russian is the default for every locale except an explicit English", () => {
    expect(autoModeDict("ru")).toBe(ru)
    expect(autoModeDict(undefined)).toBe(ru)
    expect(autoModeDict("de")).toBe(ru)
    expect(autoModeDict("en")).not.toBe(ru)
    expect(autoModeDict("en")["automode.mode.auto"]).toBe(en["automode.mode.auto"])
  })

  test("every English key has a non-empty Russian translation", () => {
    // Widened views so the keys can be iterated without an unsafe assertion.
    const enStrings: Record<string, string> = en
    const ruStrings: Record<string, string> = ru
    for (const key of Object.keys(enStrings)) {
      expect(ruStrings[key]?.length ?? 0).toBeGreaterThan(0)
    }
  })
})
