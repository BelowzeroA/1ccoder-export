import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { adoptPreviousDatabase, DATABASE_FILE, serverDataDirectory } from "./database"

const ROOT = mkdtempSync(join(tmpdir(), "1ccoder-db-"))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

function directory(name: string, files: Record<string, string>) {
  const dir = join(ROOT, name)
  mkdirSync(dir, { recursive: true })
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text)
  return dir
}

test("the previous database moves to the fixed name, with its WAL and shared memory", () => {
  const dir = directory("moves", { "opencode-1ccoder.db": "db", "opencode-1ccoder.db-wal": "wal", "opencode-1ccoder.db-shm": "shm" })
  expect(adoptPreviousDatabase(dir)).toBe("opencode-1ccoder.db")
  expect(readFileSync(join(dir, DATABASE_FILE), "utf8")).toBe("db")
  expect(readFileSync(join(dir, `${DATABASE_FILE}-wal`), "utf8")).toBe("wal")
  expect(readFileSync(join(dir, `${DATABASE_FILE}-shm`), "utf8")).toBe("shm")
  expect(existsSync(join(dir, "opencode-1ccoder.db"))).toBe(false)
})

test("once there is a database under the fixed name, nothing is touched", () => {
  const dir = directory("settled", { [DATABASE_FILE]: "current", "opencode-1ccoder.db": "old" })
  expect(adoptPreviousDatabase(dir)).toBeNull()
  expect(readFileSync(join(dir, DATABASE_FILE), "utf8")).toBe("current")
  expect(readFileSync(join(dir, "opencode-1ccoder.db"), "utf8")).toBe("old")
})

test("databases of other channels are not taken", () => {
  const dir = directory("others", { "opencode-main.db": "empty", "opencode-dev.db": "upstream" })
  expect(adoptPreviousDatabase(dir)).toBeNull()
  expect(existsSync(join(dir, DATABASE_FILE))).toBe(false)
})

test("the data directory is the server's: XDG_DATA_HOME, else ~/.local/share, then opencode", () => {
  expect(serverDataDirectory({ XDG_DATA_HOME: "/x" }, "/home/u")).toBe(join("/x", "opencode"))
  expect(serverDataDirectory({}, "/home/u")).toBe(join("/home/u", ".local", "share", "opencode"))
})
