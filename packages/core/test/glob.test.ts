import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { Glob } from "../src/util/glob"

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "glob-cwd-"))
  await mkdir(path.join(root, "one"), { recursive: true })
  await writeFile(path.join(root, "one", "SKILL.md"), "---\nname: one\n---\n")
  return root
}

describe("Glob.scan", () => {
  // node-glob reads the cwd as a glob-flavoured path, so a Windows path built
  // with path.join matches nothing at all -- no error, just an empty result.
  // That is how the bundled skills directory stopped being discovered: every
  // caller that forgets to convert loses a whole scan silently.
  test("finds files under a cwd written with the platform's own separator", async () => {
    const root = await fixture()
    const native = path.join(root, "one")
    expect(await Glob.scan("*.md", { cwd: native, absolute: true })).toHaveLength(1)
  })

  test("a forward-slash cwd keeps working, since most callers already build one", async () => {
    const root = await fixture()
    const posix = `${root.replace(/\\/g, "/")}/one`
    expect(await Glob.scan("*.md", { cwd: posix, absolute: true })).toHaveLength(1)
  })

  test("scanSync agrees with scan, since discovery uses both", async () => {
    const root = await fixture()
    const native = path.join(root, "one")
    expect(Glob.scanSync("**/SKILL.md", { cwd: native }).length).toBe(
      (await Glob.scan("**/SKILL.md", { cwd: native })).length,
    )
  })
})
