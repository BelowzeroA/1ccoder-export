import { describe, expect, test } from "bun:test"

import { sanitizeSegment, suggestWorkingDirectory } from "./client"

describe("sanitizeSegment", () => {
  test("keeps an ordinary Russian infobase name", () => {
    expect(sanitizeSegment("Бухгалтерия")).toBe("Бухгалтерия")
  })

  test("replaces characters Windows refuses in a path", () => {
    // Spaces survive -- they are legal in a directory name; only the reserved
    // characters are replaced.
    expect(sanitizeSegment('Учёт: "торговля"')).toBe("Учёт_ _торговля_")
  })

  test("strips a trailing dot, which the filesystem drops silently", () => {
    expect(sanitizeSegment("Отчёт...")).toBe("Отчёт")
  })

  test("falls back rather than producing an empty segment", () => {
    expect(sanitizeSegment("   ")).toBe("profile")
  })

  test("a name made only of reserved characters still yields a usable segment", () => {
    expect(sanitizeSegment("///")).toBe("___")
  })
})

describe("suggestWorkingDirectory", () => {
  test("appends the sanitised name to the root", () => {
    expect(suggestWorkingDirectory("C:\\Users\\me\\1CCoder", "Acc best 2")).toBe("C:\\Users\\me\\1CCoder\\Acc best 2")
  })

  test("does not double a trailing separator", () => {
    expect(suggestWorkingDirectory("C:\\Users\\me\\1CCoder\\", "Учёт")).toBe("C:\\Users\\me\\1CCoder\\Учёт")
  })

  test("uses forward slashes when the root does", () => {
    expect(suggestWorkingDirectory("/home/me/1ccoder", "Учёт")).toBe("/home/me/1ccoder/Учёт")
  })

  test("suggests nothing when there is no root to suggest from", () => {
    expect(suggestWorkingDirectory("", "Учёт")).toBe("")
  })
})
