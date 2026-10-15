// Readers for 1C's own on-disk lists: ibases.v8i (registered infobases) and
// 1CEStart.cfg (installed platform roots).
//
// Everything here is pure -- bytes and strings in, plain objects out -- so the
// format quirks can be tested against captured fixtures without a 1C
// installation. What lives in discovery.ts is the part that touches the disk.
//
// Three quirks drive the shape of this file, all observed on a real 8.3.27
// machine and none of them guessable:
//
//  1. Encoding is per file, not per directory. ibases.v8i is UTF-8 with a BOM;
//     1CEStart.cfg sitting beside it is UTF-16LE. Both have CRLF endings.
//  2. Keys repeat. 1CEStart.cfg lists one InstalledLocation line per install
//     root and one ConfigurationTemplatesLocation per template dir, so a
//     key -> value map would silently keep only the last of each.
//  3. Sections are not all infobases. The tree's folders are sections too --
//     they carry Folder= and OrderInTree= and have no Connect= at all.

/** A key/value pair. Order is preserved and keys may repeat. */
export type IniEntry = readonly [key: string, value: string]

export interface IniSection {
  readonly name: string
  readonly entries: readonly IniEntry[]
}

export interface IniFile {
  /** Entries appearing before the first [section] header. 1CEStart.cfg is entirely this. */
  readonly globals: readonly IniEntry[]
  readonly sections: readonly IniSection[]
}

/**
 * Decodes a 1C config file, honouring its BOM.
 *
 * Falls back to a NUL-density heuristic when there is no BOM: a UTF-16LE file
 * written without one is mostly zero bytes in the high half of each unit, and
 * decoding it as UTF-8 would yield convincing-looking garbage rather than an
 * error we could catch.
 */
export function decodeConfigText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2))
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = new Uint8Array(bytes.length - 2)
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      swapped[i - 2] = bytes[i + 1]
      swapped[i - 1] = bytes[i]
    }
    return new TextDecoder("utf-16le").decode(swapped)
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3))
  }

  const probe = bytes.subarray(0, Math.min(bytes.length, 128))
  let nulls = 0
  for (const byte of probe) if (byte === 0) nulls++
  if (probe.length >= 4 && nulls > probe.length / 4) {
    return new TextDecoder("utf-16le").decode(bytes)
  }

  return new TextDecoder("utf-8").decode(bytes)
}

/**
 * Parses the INI-ish format both files use. Tolerant by design: a line that
 * makes no sense is dropped rather than failing the file, because one bad
 * entry must never cost the user their whole infobase list.
 */
export function parseIni(text: string): IniFile {
  const globals: IniEntry[] = []
  const sections: { name: string; entries: IniEntry[] }[] = []
  let current: { name: string; entries: IniEntry[] } | null = null

  // A stray BOM can survive decoding when the file was written with one under
  // a UTF-16 encoding; strip it so the first section header still matches.
  for (const rawLine of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith(";")) continue

    if (line.startsWith("[") && line.endsWith("]")) {
      current = { name: line.slice(1, -1).trim(), entries: [] }
      sections.push(current)
      continue
    }

    const eq = line.indexOf("=")
    if (eq <= 0) continue
    const entry: IniEntry = [line.slice(0, eq).trim(), line.slice(eq + 1).trim()]
    if (current) current.entries.push(entry)
    else globals.push(entry)
  }

  return { globals, sections }
}

/** All values for a key, case-insensitively. Used for the repeated keys in 1CEStart.cfg. */
export function iniValues(entries: readonly IniEntry[], key: string): string[] {
  const wanted = key.toLowerCase()
  return entries.filter(([k]) => k.toLowerCase() === wanted).map(([, v]) => v)
}

/** The first value for a key, or undefined. */
export function iniValue(entries: readonly IniEntry[], key: string): string | undefined {
  return iniValues(entries, key)[0]
}

/**
 * Splits a 1C connection string into its parts.
 *
 * The grammar is `Key="value";Key=value;` where a quoted value escapes an inner
 * quote by doubling it. Keys come back lower-cased because 1C's own casing is
 * not consistent between the versions that write these files.
 */
export function parseConnectionString(value: string): Map<string, string> {
  const parts = new Map<string, string>()
  let i = 0

  while (i < value.length) {
    while (i < value.length && (value[i] === ";" || /\s/.test(value[i]!))) i++
    if (i >= value.length) break

    let key = ""
    while (i < value.length && value[i] !== "=" && value[i] !== ";") key += value[i++]
    if (i >= value.length || value[i] !== "=") {
      // No '=' before the end or before the next separator: malformed tail.
      while (i < value.length && value[i] !== ";") i++
      continue
    }
    i++

    let raw = ""
    if (value[i] === '"') {
      i++
      while (i < value.length) {
        if (value[i] === '"') {
          if (value[i + 1] === '"') {
            raw += '"'
            i += 2
            continue
          }
          i++
          break
        }
        raw += value[i++]
      }
    } else {
      while (i < value.length && value[i] !== ";") raw += value[i++]
      raw = raw.trim()
    }

    const name = key.trim().toLowerCase()
    if (name) parts.set(name, raw)
  }

  return parts
}

export type InfobaseTarget =
  | { readonly kind: "file"; readonly filePath: string }
  | { readonly kind: "server"; readonly serverCluster: string; readonly serverDatabase: string }

export interface DiscoveredInfobase {
  /** The display name, i.e. the section header. */
  readonly name: string
  /** Where it lives in 1C's own folder tree, when it says. Purely cosmetic. */
  readonly folder?: string
  readonly connect: string
  readonly target: InfobaseTarget
  /** A user name 1C had remembered for this base. Never a password -- 1C does not store one here. */
  readonly suggestedUser?: string
}

export interface SkippedInfobase {
  readonly name: string
  /** Why it is not offered: a tree folder, or a connection kind we cannot drive. */
  readonly reason: "folder" | "unsupported-connection"
  readonly connect?: string
}

export interface InfobaseListing {
  readonly infobases: readonly DiscoveredInfobase[]
  readonly skipped: readonly SkippedInfobase[]
}

/** Turns a parsed connection string into a target, or null when we cannot drive it. */
export function connectionTarget(parts: Map<string, string>): InfobaseTarget | null {
  const file = parts.get("file")
  if (file) return { kind: "file", filePath: file }

  const cluster = parts.get("srvr")
  const database = parts.get("ref")
  if (cluster && database) return { kind: "server", serverCluster: cluster, serverDatabase: database }

  // `ws=` (a published web infobase) parses fine but cannot be opened by a
  // thick client, which is what a developer profile needs. Reported as skipped
  // rather than silently dropped.
  return null
}

/**
 * Reads a registered-infobase list.
 *
 * Sections without a Connect= line are the tree's folders, not infobases; they
 * are reported as skipped so the UI can explain a short list rather than appear
 * to have lost something.
 */
export function parseInfobaseList(text: string): InfobaseListing {
  const infobases: DiscoveredInfobase[] = []
  const skipped: SkippedInfobase[] = []

  for (const section of parseIni(text).sections) {
    const name = section.name
    if (!name) continue

    const connect = iniValue(section.entries, "Connect")
    if (!connect) {
      skipped.push({ name, reason: "folder" })
      continue
    }

    const parts = parseConnectionString(connect)
    const target = connectionTarget(parts)
    if (!target) {
      skipped.push({ name, reason: "unsupported-connection", connect })
      continue
    }

    const folder = iniValue(section.entries, "Folder")
    const suggestedUser = parts.get("usr")
    infobases.push({
      name,
      ...(folder ? { folder } : {}),
      connect,
      target,
      ...(suggestedUser ? { suggestedUser } : {}),
    })
  }

  return { infobases, skipped }
}

/**
 * Install roots listed by 1CEStart.cfg.
 *
 * This is the discovery source that actually works: on the development machine
 * the platform is installed on another drive entirely, `HKLM\SOFTWARE\1C\1Cv8`
 * does not exist, and %PROGRAMFILES%\1cv8 holds only the launcher -- but the
 * common 1CEStart.cfg lists every root, one InstalledLocation line each.
 */
export function parseInstalledLocations(text: string): string[] {
  const file = parseIni(text)
  const values = [
    ...iniValues(file.globals, "InstalledLocation"),
    ...file.sections.flatMap((section) => iniValues(section.entries, "InstalledLocation")),
  ]
  return dedupe(values.map((value) => value.trim()).filter(Boolean))
}

/** The common infobase list location, when a cfg names one. */
export function parseCommonInfoBases(text: string): string[] {
  const file = parseIni(text)
  const values = [
    ...iniValues(file.globals, "CommonInfoBases"),
    ...file.sections.flatMap((section) => iniValues(section.entries, "CommonInfoBases")),
  ]
  return dedupe(values.map((value) => value.trim()).filter(Boolean))
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}
