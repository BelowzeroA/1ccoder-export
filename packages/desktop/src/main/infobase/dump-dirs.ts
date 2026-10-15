// The configuration dumps the agent reads, outside its working directory.
//
// 2026-09-27, debrief15.md §15.4. The dump of the profile's configuration sits
// beside the base, outside the session's working directory, and opencode asks
// `external_directory` for every new folder read there -- one prompt per
// CommonModules/<Модуль>. One of them waited, unseen, for two hours with the
// session stopped. Reading that dump is the job, not a decision: the agent's
// config allows it (skills/agents.ts), and writes into a dump are refused by
// the plugin (`insideDump`), since opencode's permission can't tell a read from
// a write.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"

import { dumpNearby, type DumpProbe } from "./dumps"

export const nodeDumpProbe: DumpProbe = {
  readText: (path) => {
    try {
      return readFileSync(path, "utf8")
    } catch {
      return null
    }
  },
  isFile: (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
  mtimeMs: (path) => {
    try {
      return statSync(path).mtimeMs
    } catch {
      return null
    }
  },
  list: (path) => {
    try {
      return readdirSync(path)
    } catch {
      return null
    }
  },
}

export interface ProfileLocations {
  readonly workingDirectory: string
  readonly kind: "file" | "server"
  readonly filePath?: string
  readonly configuration?: { readonly name?: string }
}

/**
 * The dump of each profile's configuration: found beside a file base or in the
 * working directory, as `1c_new_extension` finds it. Deduplicated, in the
 * forward-slash form a permission pattern takes.
 */
export function profileDumpDirectories(profiles: readonly ProfileLocations[], probe: DumpProbe = nodeDumpProbe): string[] {
  const roots = profiles.flatMap((profile) => {
    const base = profile.kind === "file" && profile.filePath ? dirname(profile.filePath.replace(/[\\/]+$/, "")) : ""
    const dump = dumpNearby([profile.workingDirectory, base], probe, profile.configuration?.name)
    return dump ? [dump.root.replace(/\\/g, "/")] : []
  })
  return [...new Set(roots)]
}

/** The root of the configuration dump `path` lies in, or null. A dump root holds Configuration.xml and ConfigDumpInfo.xml. */
export function insideDump(path: string, probe: DumpProbe = nodeDumpProbe): string | null {
  let dir = dirname(path)
  for (let depth = 0; depth < 12; depth++) {
    if (probe.isFile(join(dir, "ConfigDumpInfo.xml")) && probe.isFile(join(dir, "Configuration.xml"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

export function dumpWriteRefusal(target: string, root: string): string {
  return [
    `Отклонено: ${target} — внутри выгрузки конфигурации (${root}).`,
    "",
    "Выгрузка — справочник для чтения: её не правят. Свои файлы (расширение, обработку, заметки) клади в",
    "рабочий каталог профиля; новую выгрузку делает 1c_dump_config_to_files.",
  ].join("\n")
}
