// Installing the 1CCoder skill set and its v8pack launcher.
//
// Everything is written next to opencode's own config, on every launch, for
// three reasons:
//
//   The sidecar reads skills from disk, so they cannot live inside the asar.
//   The skills need absolute paths that are only known at runtime.
//   Paths differ between a dev run and an installed one, so a stale copy from
//   a previous launch would point at a binary that has moved.
//
// The launcher is what makes v8pack runnable without assuming the user has
// Node: it invokes Electron's own binary with ELECTRON_RUN_AS_NODE=1, which
// turns it into a plain Node runtime.

import { chmod, copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { write as writeLog } from "../logging"
import { skillFiles } from "./content"

export { mergeAgentConfig, NOPROFILE_AGENT, PROFILE_AGENT } from "./agents"

export const SKILLS_DIR_NAME = "1ccoder-skills"
export const TEMPLATES_DIR_NAME = "templates"
/** Where the vendored format specs land, next to the skills that use them. */
export const VENDOR_REFERENCE_DIR_NAME = "1ccoder-mxl-reference"

export interface InstallInput {
  /** opencode's config directory; the skills go in a subdirectory of it. */
  readonly configDir: string
  /** Absolute path to the bundled v8pack-cli.mjs. */
  readonly cliSource: string
  /** Absolute path to the bundled infobase plugin. */
  readonly pluginSource: string
  /** Directory holding the bundled .epf starting points. */
  readonly templatesSource: string
  /** Directory holding the vendored cc-1c-skills tree. */
  readonly vendorSource: string
  /** Electron's own executable, used as a Node runtime. */
  readonly electronPath: string
}

/**
 * Quotes a path for the shell the launcher will run under. Windows paths are
 * full of spaces, and an unquoted "C:\Program Files\..." is the classic way to
 * ship something that works on the developer's machine only.
 */
function quote(path: string): string {
  return `"${path}"`
}

function launcherName(): string {
  return process.platform === "win32" ? "v8pack.cmd" : "v8pack.sh"
}

function launcherBody(electronPath: string, cliPath: string): string {
  if (process.platform === "win32") {
    return [
      "@echo off",
      "rem 1CCoder: runs the bundled v8pack CLI through Electron's own Node runtime,",
      "rem so no separate Node installation is needed.",
      "setlocal",
      "set ELECTRON_RUN_AS_NODE=1",
      `${quote(electronPath)} ${quote(cliPath)} %*`,
      "",
    ].join("\r\n")
  }
  return [
    "#!/bin/sh",
    "# 1CCoder: runs the bundled v8pack CLI through Electron's own Node runtime,",
    "# so no separate Node installation is needed.",
    `ELECTRON_RUN_AS_NODE=1 exec ${quote(electronPath)} ${quote(cliPath)} "$@"`,
    "",
  ].join("\n")
}

export interface InstallResult {
  readonly skillsDir: string
  readonly launcher: string
  readonly pluginPath: string
  readonly templatesDir: string
  readonly templates: readonly string[]
  readonly skills: readonly string[]
  /** Names of the vendored skills that were installed alongside ours. */
  readonly vendored: readonly string[]
  /** Where the vendored MXL format specs landed. */
  readonly referenceDir: string
}

/**
 * Copies the bundled .epf starting points next to the skills.
 *
 * A missing or unreadable directory is not fatal: the templates are a
 * convenience, and an app that refuses to start because one .epf went missing
 * would be worse than one whose agent builds a processing from scratch.
 */
async function installTemplates(source: string, skillsDir: string): Promise<{ dir: string; names: string[] }> {
  const dir = join(skillsDir, TEMPLATES_DIR_NAME)
  await mkdir(dir, { recursive: true })
  let names: string[] = []
  try {
    names = (await readdir(source)).filter((name) => name.toLowerCase().endsWith(".epf")).sort()
  } catch (error) {
    writeLog("skills", "templates unreadable", { source, error: String(error) }, "warn")
    return { dir, names: [] }
  }
  for (const name of names) await copyFile(join(source, name), join(dir, name))
  return { dir, names }
}

/**
 * Copies the vendored cc-1c-skills tree in beside our own skills.
 *
 * 2026-09-21, debrief6.md §9 C1. One substitution happens here and nowhere
 * else: upstream SKILL.md files call their scripts through
 * `${CLAUDE_SKILL_DIR}`, which nothing in this fork defines, so every command
 * they document would fail. Rewriting it at copy time -- rather than patching
 * the vendored files -- keeps them re-copyable from upstream unmodified.
 *
 * Like the templates, a failure here is logged and survived: the MXL toolkit is
 * a convenience, and `1ccoder-ib-print-forms` §5 is what actually keeps the
 * agent out of the XML.
 */
async function installVendoredSkills(source: string, skillsDir: string): Promise<string[]> {
  const root = join(source, "skills")
  let names: string[] = []
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    writeLog("skills", "vendored skills unreadable", { source: root, error: String(error) }, "warn")
    return []
  }

  for (const name of names) {
    const target = join(skillsDir, name)
    await copyTree(join(root, name), target, target)
  }

  // The two format specs, which no SKILL.md references by path -- they are read
  // when `1ccoder-ib-print-forms` points at them.
  try {
    const referenceDir = join(skillsDir, VENDOR_REFERENCE_DIR_NAME)
    await mkdir(referenceDir, { recursive: true })
    for (const file of await readdir(join(source, "reference"))) {
      await copyFile(join(source, "reference", file), join(referenceDir, file))
    }
    for (const file of ["LICENSE", "PROVENANCE.md"]) {
      await copyFile(join(source, file), join(referenceDir, file)).catch(() => undefined)
    }
  } catch (error) {
    writeLog("skills", "vendored reference unreadable", { source, error: String(error) }, "warn")
  }

  return names
}

/**
 * Recursive copy, rewriting `${CLAUDE_SKILL_DIR}` in text files to `skillDir`.
 *
 * Only the four text extensions the tree actually contains are rewritten;
 * anything else is copied byte for byte, so adding a binary upstream cannot be
 * corrupted by a well-meaning string replace.
 */
async function copyTree(from: string, to: string, skillDir: string): Promise<void> {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) {
      await copyTree(source, target, skillDir)
      continue
    }
    if (/\.(md|ps1|json|txt)$/i.test(entry.name)) {
      const text = await readFile(source, "utf8")
      await writeFile(target, text.replaceAll("${CLAUDE_SKILL_DIR}", skillDir), "utf8")
      continue
    }
    await copyFile(source, target)
  }
}

export async function installSkills(input: InstallInput): Promise<InstallResult> {
  const skillsDir = join(input.configDir, SKILLS_DIR_NAME)
  await mkdir(skillsDir, { recursive: true })

  const cliPath = join(skillsDir, "v8pack-cli.mjs")
  await copyFile(input.cliSource, cliPath)

  // Beside the skills, and on disk rather than in the asar: the sidecar loads
  // it as a separate process and cannot read inside the archive.
  const pluginPath = join(skillsDir, "1ccoder-plugin.mjs")
  await copyFile(input.pluginSource, pluginPath)

  const launcher = join(skillsDir, launcherName())
  await writeFile(launcher, launcherBody(input.electronPath, cliPath), "utf8")
  if (process.platform !== "win32") await chmod(launcher, 0o755)

  const templates = await installTemplates(input.templatesSource, skillsDir)
  const vendored = await installVendoredSkills(input.vendorSource, skillsDir)
  const referenceDir = join(skillsDir, VENDOR_REFERENCE_DIR_NAME)

  const files = skillFiles({
    v8pack: quote(launcher),
    templatesDir: templates.dir,
    templates: templates.names,
    referenceDir,
    vendored,
  })
  for (const skill of files) {
    // opencode discovers skills as <dir>/<name>/SKILL.md.
    const dir = join(skillsDir, skill.name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "SKILL.md"), skill.body, "utf8")
  }

  return {
    skillsDir,
    launcher,
    pluginPath,
    templatesDir: templates.dir,
    templates: templates.names,
    skills: files.map((skill) => skill.name),
    vendored,
    referenceDir,
  }
}

/**
 * Where the bundled CLI sits. In a packaged app it is a real file under
 * resources; in development it is in the package's own resources directory.
 */
export function resolveBundledResource(
  name: string,
  options: { packaged: boolean; resourcesPath: string; appPath: string },
): string {
  return options.packaged ? join(options.resourcesPath, name) : join(options.appPath, "resources", name)
}

/** Installs, logging rather than throwing: a missing skill set must not stop the app starting. */
export async function installSkillsSafely(input: InstallInput): Promise<InstallResult | null> {
  try {
    const result = await installSkills(input)
    writeLog("skills", "installed", { dir: result.skillsDir, skills: result.skills, templates: result.templates })
    return result
  } catch (error) {
    writeLog("skills", "install failed", { error: String(error) }, "error")
    return null
  }
}
