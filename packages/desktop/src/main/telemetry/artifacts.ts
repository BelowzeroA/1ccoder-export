// The files a session produced that are worth keeping: processings, reports,
// extensions and spreadsheet templates, found in a profile's working directory.
//
// Found by scanning, not from a journal: `.1ccoder/writes.jsonl` records the
// agent's writes to the infobase, not the files it builds on disk.

import { readdirSync, statSync } from "node:fs"
import { extname, join } from "node:path"

export const ARTIFACT_EXTENSIONS = new Set(["epf", "erf", "cfe", "mxl"])

/** Directories that hold nothing of ours, or far too much to walk. */
const SKIP = new Set([".git", "node_modules", ".1ccoder", "$RECYCLE.BIN"])

export interface FoundArtifact {
  readonly path: string
  readonly ext: string
  readonly size: number
  readonly mtime: number
}

/** Files under `root` modified after `since`, at most `depth` levels down. */
export function scanArtifacts(root: string, since: number, depth = 4): FoundArtifact[] {
  const found: FoundArtifact[] = []
  const walk = (dir: string, level: number) => {
    let entries: import("node:fs").Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (level < depth && !SKIP.has(entry.name)) walk(path, level + 1)
        continue
      }
      const ext = extname(entry.name).slice(1).toLowerCase()
      if (!entry.isFile() || !ARTIFACT_EXTENSIONS.has(ext)) continue
      try {
        const info = statSync(path)
        if (info.mtimeMs > since) found.push({ path, ext, size: info.size, mtime: info.mtimeMs })
      } catch {
        continue
      }
    }
  }
  walk(root, 0)
  return found
}
