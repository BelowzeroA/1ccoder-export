// Finds what 1C is already installed on this machine, so a developer profile
// can be created by picking from a list instead of typing paths.
//
// Discovery is a convenience and never a gate: every field it fills in stays
// editable, and a machine where it finds nothing must still let a profile be
// entered by hand.
//
// Where platforms are found, in order of how much they can be trusted:
//
//  1. InstalledLocation lines in 1CEStart.cfg. The one source that worked on
//     the development machine, where the platform sits on a second drive.
//  2. InstallLocation from the Windows uninstall registry. Finds editions the
//     cfg misses -- the training build was listed here and nowhere else.
//  3. %PROGRAMFILES%\1cv8 and its (x86) twin. A fallback, listed last on
//     purpose: on the development machine that directory holds only the
//     1cestart launcher, and HKLM\SOFTWARE\1C\1Cv8 -- the key the obvious
//     design would have read -- does not exist at all.

import { execFile } from "node:child_process"
import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import {
  decodeConfigText,
  parseCommonInfoBases,
  parseInfobaseList,
  parseInstalledLocations,
  type DiscoveredInfobase,
  type SkippedInfobase,
} from "./v8i"

const execFileAsync = promisify(execFile)

export type PlatformEdition = "standard" | "training"

export interface DiscoveredPlatform {
  /** The version directory's own name, e.g. "8.3.27.2342". */
  readonly version: string
  readonly versionDir: string
  readonly binDir: string
  /** Absolute path to the thick client, or null when only a thin client is installed. */
  readonly thickClient: string | null
  readonly edition: PlatformEdition
  /** Which discovery sources reported this one. Kept for diagnostics. */
  readonly sources: readonly string[]
}

export interface DiscoveryResult {
  readonly platforms: readonly DiscoveredPlatform[]
  /** Where new profiles are offered a working directory, e.g. C:\Users\me\1CCoder. */
  readonly workspaceRoot: string
  readonly infobases: readonly DiscoveredInfobase[]
  readonly skippedInfobases: readonly SkippedInfobase[]
  /** Files that were read successfully. Shown when the result is empty and the user asks why. */
  readonly sourcesRead: readonly string[]
  readonly problems: readonly string[]
}

/** Version directories look like 8.3.27.2342; two- and three-part names also exist in the wild. */
const VERSION_DIR = /^\d+\.\d+(\.\d+){0,2}$/

// The thick client is what a profile needs: it is the binary that can run
// DESIGNER and batch operations. It is NOT always 1cv8.exe -- the training
// edition ships 1cv8t.exe -- so match a family, not a filename.
const CLIENTS: ReadonlyArray<{ exe: string; edition: PlatformEdition }> = [
  { exe: "1cv8.exe", edition: "standard" },
  { exe: "1cv8t.exe", edition: "training" },
]

/**
 * Classifies a bin directory from its file listing. Pure, so the
 * standard-versus-training distinction is testable without an installation.
 */
export function classifyBinDir(files: readonly string[]): { thickClient: string; edition: PlatformEdition } | null {
  const lower = new Set(files.map((file) => file.toLowerCase()))
  for (const { exe, edition } of CLIENTS) {
    if (lower.has(exe)) return { thickClient: exe, edition }
  }
  return null
}

function appData(): string | undefined {
  return process.env.APPDATA
}

function programData(): string | undefined {
  return process.env.ALLUSERSPROFILE ?? process.env.ProgramData
}

/** The two 1CEStart directories: the signed-in user's, and the machine-wide one. */
export function startDirs(): string[] {
  const dirs: string[] = []
  const user = appData()
  if (user) dirs.push(join(user, "1C", "1CEStart"))
  const common = programData()
  if (common) dirs.push(join(common, "1C", "1CEStart"))
  return dirs
}

async function readDecoded(path: string): Promise<string | null> {
  try {
    return decodeConfigText(await readFile(path))
  } catch {
    return null
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}

/**
 * Install roots named by the uninstall registry.
 *
 * `reg query /s` over each uninstall hive is one spawn per hive, which is worth
 * it: enumerating subkeys and querying each would be hundreds. Both hives are
 * read because the 64-bit and 32-bit products register in different ones.
 */
async function registryInstallLocations(): Promise<string[]> {
  if (process.platform !== "win32") return []

  const hives = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ]

  // Concurrently: each hive takes well over a second to dump on a normal
  // machine, and running them in sequence was most of discovery's wall clock.
  const dumps = await Promise.all(
    hives.map(async (hive) => {
      try {
        const result = await execFileAsync("reg", ["query", hive, "/s"], {
          maxBuffer: 32 * 1024 * 1024,
          windowsHide: true,
        })
        return result.stdout
      } catch {
        return ""
      }
    }),
  )

  return dumps.flatMap(parseUninstallDump)
}

/**
 * Pulls InstallLocation out of a `reg query /s` dump, keeping only products
 * whose DisplayName looks like 1C's.
 *
 * Exported for testing, and because the matching deserves to be looked at: the
 * name may be written with a Cyrillic С, which is a different character from
 * the Latin C and compares unequal.
 */
export function parseUninstallDump(stdout: string): string[] {
  const results: string[] = []
  let displayName: string | null = null
  let installLocation: string | null = null

  const flush = () => {
    if (displayName && installLocation && looksLike1C(displayName)) results.push(installLocation)
    displayName = null
    installLocation = null
  }

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.startsWith("HKEY_")) {
      flush()
      continue
    }

    const match = /^(\S+)\s+REG_[A-Z_]+\s+(.*)$/.exec(line)
    if (!match) continue
    const [, name, value] = match
    if (name === "DisplayName") displayName = value ?? null
    else if (name === "InstallLocation") installLocation = (value ?? "").trim() || null
  }
  flush()

  return results
}

function looksLike1C(displayName: string): boolean {
  const lower = displayName.toLowerCase()
  // "1С:Предприятие" may carry a Cyrillic С; match both alphabets.
  return lower.includes("1c:enterprise") || lower.includes("1с:") || lower.includes("1c:") || lower.includes("1cv8")
}

function defaultRoots(): string[] {
  const roots: string[] = []
  for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
    if (!base) continue
    roots.push(join(base, "1cv8"), join(base, "1cv8t"))
  }
  return roots
}

/**
 * Turns a candidate directory into platforms.
 *
 * A candidate may be an install *root* holding version directories, or a
 * version directory itself -- the registry reports the latter
 * (`D:\Programs\1cv8t\8.3.27.2342\`) while 1CEStart.cfg reports the former.
 */
async function platformsUnder(candidate: string, source: string): Promise<DiscoveredPlatform[]> {
  const trimmed = candidate.replace(/[\\/]+$/, "")
  if (!trimmed) return []

  const direct = await platformAt(trimmed, source)
  if (direct) return [direct]

  const found: DiscoveredPlatform[] = []
  for (const entry of await listDir(trimmed)) {
    if (!VERSION_DIR.test(entry)) continue
    const platform = await platformAt(join(trimmed, entry), source)
    if (platform) found.push(platform)
  }
  return found
}

async function platformAt(versionDir: string, source: string): Promise<DiscoveredPlatform | null> {
  const binDir = join(versionDir, "bin")
  if (!(await isDir(binDir))) return null

  const classified = classifyBinDir(await listDir(binDir))
  if (!classified) return null

  const version = versionDir.split(/[\\/]/).pop() ?? versionDir
  return {
    version,
    versionDir,
    binDir,
    thickClient: join(binDir, classified.thickClient),
    edition: classified.edition,
    sources: [source],
  }
}

function mergePlatforms(platforms: DiscoveredPlatform[]): DiscoveredPlatform[] {
  const byBin = new Map<string, DiscoveredPlatform>()
  for (const platform of platforms) {
    const key = platform.binDir.toLowerCase()
    const existing = byBin.get(key)
    if (!existing) {
      byBin.set(key, platform)
      continue
    }
    byBin.set(key, { ...existing, sources: [...new Set([...existing.sources, ...platform.sources])] })
  }
  // Newest first, so the list opens on the version a developer most likely wants.
  return [...byBin.values()].sort((a, b) => compareVersions(b.version, a.version))
}

/** Compares dotted version strings numerically; 8.3.27.2342 sorts above 8.3.9.100. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0)
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export async function discoverPlatforms(): Promise<{ platforms: DiscoveredPlatform[]; sourcesRead: string[] }> {
  const sourcesRead: string[] = []
  const candidates: { path: string; source: string }[] = []

  for (const dir of startDirs()) {
    const cfgPath = join(dir, "1CEStart.cfg")
    const text = await readDecoded(cfgPath)
    if (text === null) continue
    sourcesRead.push(cfgPath)
    for (const root of parseInstalledLocations(text)) candidates.push({ path: root, source: cfgPath })
  }

  for (const location of await registryInstallLocations()) {
    candidates.push({ path: location, source: "uninstall-registry" })
  }

  for (const root of defaultRoots()) candidates.push({ path: root, source: "program-files" })

  const platforms: DiscoveredPlatform[] = []
  for (const candidate of candidates) {
    platforms.push(...(await platformsUnder(candidate.path, candidate.source)))
  }

  return { platforms: mergePlatforms(platforms), sourcesRead }
}

/** Every ibases.v8i worth reading: the per-user and common ones, plus any the cfgs point at. */
export async function infobaseListPaths(): Promise<string[]> {
  const paths: string[] = []
  for (const dir of startDirs()) {
    paths.push(join(dir, "ibases.v8i"))
    const text = await readDecoded(join(dir, "1CEStart.cfg"))
    if (text === null) continue
    paths.push(...parseCommonInfoBases(text))
  }

  const seen = new Set<string>()
  return paths.filter((path) => {
    const key = path.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function discoverInfobases(): Promise<{
  infobases: DiscoveredInfobase[]
  skipped: SkippedInfobase[]
  sourcesRead: string[]
}> {
  const infobases: DiscoveredInfobase[] = []
  const skipped: SkippedInfobase[] = []
  const sourcesRead: string[] = []
  const seen = new Set<string>()

  for (const path of await infobaseListPaths()) {
    const text = await readDecoded(path)
    if (text === null) continue
    sourcesRead.push(path)

    const listing = parseInfobaseList(text)
    for (const infobase of listing.infobases) {
      // The same base often appears in both the user and common lists.
      const key = `${infobase.name}\u0000${infobase.connect}`.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      infobases.push(infobase)
    }
    skipped.push(...listing.skipped)
  }

  infobases.sort((a, b) => a.name.localeCompare(b.name, "ru"))
  return { infobases, skipped, sourcesRead }
}

/**
 * The root under which a new profile's working directory is suggested. Only a
 * suggestion -- the field stays editable and may point anywhere.
 */
export function defaultWorkspaceRoot(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ""
  return home ? join(home, "1CCoder") : "1CCoder"
}

export async function discover(): Promise<DiscoveryResult> {
  const problems: string[] = []

  const [platformResult, infobaseResult] = await Promise.all([
    discoverPlatforms().catch((error) => {
      problems.push(`platform discovery failed: ${String(error)}`)
      return { platforms: [] as DiscoveredPlatform[], sourcesRead: [] as string[] }
    }),
    discoverInfobases().catch((error) => {
      problems.push(`infobase discovery failed: ${String(error)}`)
      return { infobases: [] as DiscoveredInfobase[], skipped: [] as SkippedInfobase[], sourcesRead: [] as string[] }
    }),
  ])

  return {
    workspaceRoot: defaultWorkspaceRoot(),
    platforms: platformResult.platforms,
    infobases: infobaseResult.infobases,
    skippedInfobases: infobaseResult.skipped,
    sourcesRead: [...platformResult.sourcesRead, ...infobaseResult.sourcesRead],
    problems,
  }
}
