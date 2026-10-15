import { describe, expect, mock, test } from "bun:test"
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// index.ts logs, and logging.ts imports electron at module load, which a bun
// test process has no business starting. Only `write` is reached from here.
mock.module("../logging", () => ({ write: () => {} }))

const { installSkills, SKILLS_DIR_NAME, VENDOR_REFERENCE_DIR_NAME } = await import("./index")

// 2026-09-21, debrief6.md §9 C1. The MXL skills come from cc-1c-skills, whose
// SKILL.md files invoke their scripts through `${CLAUDE_SKILL_DIR}` -- a
// variable Claude Code defines and this fork does not. Left alone, every
// command they document is a path that resolves to `/scripts/mxl-info.ps1`.
// The installer rewrites it while copying; these tests are what stops a future
// re-copy from upstream reintroducing the placeholder silently.

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "1ccoder-install-"))
  const configDir = join(root, "config")
  const vendorSource = join(root, "vendor")
  const templatesSource = join(root, "templates")
  await mkdir(configDir, { recursive: true })
  await mkdir(templatesSource, { recursive: true })
  await mkdir(join(vendorSource, "skills", "mxl-info", "scripts"), { recursive: true })
  await mkdir(join(vendorSource, "reference"), { recursive: true })

  await writeFile(
    join(vendorSource, "skills", "mxl-info", "SKILL.md"),
    ['---', "name: mxl-info", "---", "", 'powershell.exe -File "${CLAUDE_SKILL_DIR}/scripts/mxl-info.ps1"'].join("\n"),
    "utf8",
  )
  await writeFile(join(vendorSource, "skills", "mxl-info", "scripts", "mxl-info.ps1"), "param()\n", "utf8")
  await writeFile(join(vendorSource, "reference", "1c-spreadsheet-spec.md"), "# MXL\n", "utf8")
  await writeFile(join(vendorSource, "LICENSE"), "MIT\n", "utf8")

  const cliSource = join(root, "v8pack-cli.mjs")
  const pluginSource = join(root, "1ccoder-plugin.mjs")
  await writeFile(cliSource, "// cli\n", "utf8")
  await writeFile(pluginSource, "// plugin\n", "utf8")

  return {
    root,
    skillsDir: join(configDir, SKILLS_DIR_NAME),
    input: {
      configDir,
      cliSource,
      pluginSource,
      templatesSource,
      vendorSource,
      electronPath: join(root, "electron.exe"),
    },
  }
}

describe("vendored MXL skills", () => {
  test("are installed beside our own", async () => {
    const { input, skillsDir } = await fixture()
    const result = await installSkills(input)

    expect(result.vendored).toEqual(["mxl-info"])
    expect(await readdir(join(skillsDir, "mxl-info"))).toContain("SKILL.md")
    expect(await readdir(join(skillsDir, "mxl-info", "scripts"))).toContain("mxl-info.ps1")
  })

  // The whole reason the vendoring needed code rather than a copy.
  test("have CLAUDE_SKILL_DIR rewritten to where they actually landed", async () => {
    const { input, skillsDir } = await fixture()
    await installSkills(input)

    const body = await readFile(join(skillsDir, "mxl-info", "SKILL.md"), "utf8")
    expect(body).not.toContain("CLAUDE_SKILL_DIR")
    expect(body).toContain(join(skillsDir, "mxl-info"))
  })

  test("carry the format specs and the licence into a reference directory", async () => {
    const { input, skillsDir } = await fixture()
    const result = await installSkills(input)

    expect(result.referenceDir).toBe(join(skillsDir, VENDOR_REFERENCE_DIR_NAME))
    const files = await readdir(result.referenceDir)
    expect(files).toContain("1c-spreadsheet-spec.md")
    expect(files).toContain("LICENSE")
  })

  // A convenience must not be able to stop the app starting -- same rule the
  // .epf templates follow.
  test("a missing vendor tree is survived, not thrown", async () => {
    const { input } = await fixture()
    const result = await installSkills({ ...input, vendorSource: join(input.configDir, "nope") })

    expect(result.vendored).toEqual([])
    expect(result.skills.length).toBeGreaterThan(0)
  })

  // Without the tree, the print-forms skill must not advertise tools that are
  // not there -- a skill naming a command that does not exist is worse than a
  // skill that says nothing.
  test("the print-forms skill names the toolkit only when it is present", async () => {
    const { input, skillsDir } = await fixture()

    await installSkills(input)
    const withTools = await readFile(join(skillsDir, "1ccoder-ib-print-forms", "SKILL.md"), "utf8")
    expect(withTools).toContain("1c-spreadsheet-spec.md")

    await installSkills({ ...input, vendorSource: join(input.configDir, "nope") })
    const without = await readFile(join(skillsDir, "1ccoder-ib-print-forms", "SKILL.md"), "utf8")
    expect(without).not.toContain("1c-spreadsheet-spec.md")
    // 2026-09-23, debrief9.md §9.8. `1c_mxl_info` is a plugin tool, not a
    // vendored script, so it is named whether or not the tree installed -- and
    // the vendored `/mxl-info` is no longer offered beside it, because two
    // routes to one answer is how the worse route gets taken.
    expect(without).toContain("1c_mxl_info")
    expect(without).not.toContain("/mxl-info")
  })
})
