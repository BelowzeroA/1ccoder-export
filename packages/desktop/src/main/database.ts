// The server's database file: one name, whatever the build.
//
// opencode names its database after the build's channel (core/src/database/
// database.ts: `opencode-<channel>.db`), and a local build takes the channel
// from the current git branch. 2026-09-27: renaming the branch from `1ccoder`
// to `main` put the app on a new, empty `opencode-main.db`, and every session
// seemed gone. The name is now fixed and passed to the server as OPENCODE_DB.

import { existsSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const DATABASE_FILE = "1ccoder.db"

/** Where the channel-named databases lived; the newest carries the sessions until now. */
const PREVIOUS_FILES = ["opencode-1ccoder.db"]

/** The server's data directory, resolved as core/src/global.ts does (xdg-basedir, then `opencode`). */
export function serverDataDirectory(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode")
}

/**
 * Moves the previous database to the fixed name, once: only when the fixed one
 * doesn't exist yet. Its `-wal` and `-shm` files go with it, since SQLite keeps
 * recent writes there. Must run before the server starts, while nothing holds
 * the files. Returns the file it moved, or null.
 */
export function adoptPreviousDatabase(directory: string): string | null {
  if (existsSync(join(directory, DATABASE_FILE))) return null
  const previous = PREVIOUS_FILES.find((name) => existsSync(join(directory, name)))
  if (!previous) return null
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = join(directory, previous + suffix)
    if (existsSync(from)) renameSync(from, join(directory, DATABASE_FILE + suffix))
  }
  return previous
}
