import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join, relative } from "node:path"

// No customer, profile or infobase name may appear anywhere in the product --
// code, comments, test fixtures, skills, the built bundle. They belong in the
// development notes only. Fixtures use neutral placeholders (C:\Bases\Acc,
// «Организация»).
//
// The forbidden words are stored as hashes, so this file does not itself name
// anybody. Text is split into words (letters and digits); each word,
// lower-cased, is hashed and looked up. A new name goes in with:
//   bun -e 'console.log(require("node:crypto").createHash("sha256").update("<слово>").digest("hex").slice(0, 16))'
const FORBIDDEN = new Set([
  "c9688c2c67d8952f",
  "0fc0c769508e73cd",
  "b30312d2e9576a6a",
  "c2200c621d7deaa8",
  "d4683674078f3255",
  "5026c8d976cf8177",
  "892a7dc2beab6428",
  "14b2bc39bf7c0167",
  "262225cb0fb53e92",
  "defae9e59c2014f9",
  "8be01c3f3b970d82",
  "813709135b9b87a5",
  "9d09a9ed2c2005ae",
  "8d8c40366c8e0964",
  "cdedf3284dbcb976",
  "32d09d75959c3b9e",
  "22bdb15e5027bf18",
])

const REPO = join(import.meta.dir, "..", "..", "..", "..")
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", ".turbo", ".sst", "target"])
const TEXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".mdx", ".txt", ".bsl", ".xml", ".ps1", ".yml", ".yaml", ".html", ".css"])

function* textFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path, { throwIfNoEntry: false })
    if (!stat) continue
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* textFiles(path)
      continue
    }
    // Lock files are hashes of packages; a 3-letter word can't be told from a slice of one.
    if (TEXT.has(extname(name)) && !name.endsWith(".lock") && stat.size < 8 * 1024 * 1024) yield path
  }
}

const hash = (word: string) => createHash("sha256").update(word).digest("hex").slice(0, 16)

describe("the product names no customer, profile or infobase", () => {
  test("no forbidden word in any text file of the repository", () => {
    const hits = [...textFiles(REPO)].flatMap((path) =>
      [...new Set(readFileSync(path, "utf8").toLowerCase().split(/[^\p{L}\p{N}]+/u))]
        .filter((word) => word.length > 2 && FORBIDDEN.has(hash(word)))
        .map((word) => `${relative(REPO, path)}: ${word}`),
    )
    expect(hits).toEqual([])
    // Thousands of files: ~2 s warm, past bun's default 5 s on a cold disk cache.
  }, 60_000)
})
