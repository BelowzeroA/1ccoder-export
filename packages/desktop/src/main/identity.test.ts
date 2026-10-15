import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { adoptPreviousUserData, isDeepLink, toUpstreamDeepLink } from "./identity"

const ROOT = mkdtempSync(join(tmpdir(), "1ccoder-identity-"))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

function directory(name: string, files: Record<string, string>) {
  const dir = join(ROOT, name)
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  mkdirSync(dir, { recursive: true })
  return dir
}

test("the stores, the drafts and the os_crypt key are copied; caches are not", () => {
  const from = directory("old-1", {
    "1ccoder.profiles": "profiles",
    "1ccoder.sessions": "sessions",
    "opencode.settings": "settings",
    "default.dat": "default",
    "drafts.sqlite": "drafts",
    "Local State": "key",
    "Local Storage/leveldb/000003.log": "ls",
    "Cache/data_0": "cache",
    "DevToolsActivePort": "port",
  })
  const to = join(ROOT, "new-1")
  const copied = adoptPreviousUserData(from, to)
  expect(copied.sort()).toEqual(
    ["1ccoder.profiles", "1ccoder.sessions", "Local State", "Local Storage", "default.dat", "drafts.sqlite", "opencode.settings"].sort(),
  )
  expect(readFileSync(join(to, "1ccoder.profiles"), "utf8")).toBe("profiles")
  expect(readFileSync(join(to, "Local Storage", "leveldb", "000003.log"), "utf8")).toBe("ls")
  expect(existsSync(join(to, "Cache"))).toBe(false)
  expect(existsSync(join(to, "DevToolsActivePort"))).toBe(false)
  // A copy: the old folder still works for an older build.
  expect(readFileSync(join(from, "1ccoder.profiles"), "utf8")).toBe("profiles")
})

test("once the new folder has stores of its own, nothing is copied", () => {
  const from = directory("old-2", { "1ccoder.profiles": "old" })
  const to = directory("new-2", { "1ccoder.profiles": "current" })
  expect(adoptPreviousUserData(from, to)).toEqual([])
  expect(readFileSync(join(to, "1ccoder.profiles"), "utf8")).toBe("current")
})

test("a new folder with only Chromium leftovers still adopts", () => {
  const from = directory("old-3", { "1ccoder.profiles": "old" })
  const to = directory("new-3", { "DevToolsActivePort": "x" })
  expect(adoptPreviousUserData(from, to)).toEqual(["1ccoder.profiles"])
})

test("no previous folder, nothing to do", () => {
  expect(adoptPreviousUserData(join(ROOT, "missing"), join(ROOT, "new-4"))).toEqual([])
})

test("1ccoder:// links reach the shared UI as opencode:// links", () => {
  expect(toUpstreamDeepLink("1ccoder://open-project?directory=C%3A%5Cx")).toBe("opencode://open-project?directory=C%3A%5Cx")
  expect(toUpstreamDeepLink("opencode://new-session?directory=x")).toBe("opencode://new-session?directory=x")
  expect(isDeepLink("1ccoder://x")).toBe(true)
  expect(isDeepLink("opencode://x")).toBe(true)
  expect(isDeepLink("--flag")).toBe(false)
})
