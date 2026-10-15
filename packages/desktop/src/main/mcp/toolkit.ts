// Where MCP_Toolkit.epf lives, and how the platform is told to run it.
//
// MCP Toolkit is an external data processor that, once open in 1C:Enterprise,
// runs an MCP server inside the 1C client process. That is what makes it worth
// the trouble: its tools execute queries and 1C code in the *session's own*
// infobase, with the profile's own credentials, rather than through another
// batch launch of the platform.
//
// It ships with the app, as a separate program under its own licence: GPL-3.0,
// upstream github.com/ROCTUP/1c-mcp-toolkit v1.8.0, with one change of ours
// (resources/toolkit/NOTICE.md says what and why). The bundled copy is the
// last place looked, so a copy the user drops in the config directory -- a
// newer upstream build, say -- still wins, and a fresh install can no longer
// end up with no toolkit at all.
//
// Pure: no Electron, no child processes, no filesystem. The candidate list, the
// launch parameter and the argument vector are all decisions that can be read
// and tested without a 1C installation. Everything that actually runs lives in
// supervisor.ts.

import { connectionArg } from "../infobase/operations"

/** The port the toolkit's embedded HTTP server listens on. */
export const MCP_PORT = 6003

/** The MCP endpoint, once the server is up. */
export const mcpUrl = (port: number = MCP_PORT) => `http://127.0.0.1:${port}/mcp`

/** Its liveness endpoint, which answers before any MCP session exists. */
export const healthUrl = (port: number = MCP_PORT) => `http://127.0.0.1:${port}/health`

export const TOOLKIT_FILE_NAME = "MCP_Toolkit.epf"

/** Where a user-supplied copy is expected to be dropped. */
export const TOOLKIT_DIR_NAME = "1ccoder-mcp"

/** The bundled copy's directory under resources/, beside its LICENSE and NOTICE. */
export const BUNDLED_TOOLKIT_DIR = "toolkit"

/** The upstream release the bundled copy is built from (resources/toolkit/NOTICE.md). */
export const BUNDLED_TOOLKIT_VERSION = "1.8.0+1ccoder.1"

/** The name opencode gives the server; its tools are then `1c_<tool>`. */
export const MCP_CLIENT_NAME = "1c"

export interface ToolkitProfile {
  readonly kind: "file" | "server"
  readonly filePath?: string
  readonly serverCluster?: string
  readonly serverDatabase?: string
  readonly workingDirectory: string
  readonly userName: string
}

function parentOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "")
  const cut = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"))
  return cut > 0 ? trimmed.slice(0, cut) : ""
}

function joinPath(dir: string, name: string): string {
  const separator = dir.includes("/") && !dir.includes("\\") ? "/" : "\\"
  return `${dir.replace(/[\\/]+$/, "")}${separator}${name}`
}

/**
 * Every place we are willing to find the toolkit, best first.
 *
 * The config directory comes first because it is the one location that is ours
 * to describe: a copy put there serves every profile. After that we look where
 * a 1C developer would already have put it -- beside the infobase they work in,
 * or in the profile's own working directory. The copy the app ships with comes
 * last: it is the fallback that is always there, not a reason to ignore one
 * the user chose.
 */
export function toolkitCandidates(input: {
  configDir: string
  profile: ToolkitProfile
  /** The bundled .epf's full path, when the app has one. */
  bundled?: string
}): string[] {
  const directories = [
    joinPath(input.configDir, TOOLKIT_DIR_NAME),
    input.profile.workingDirectory,
    ...(input.profile.kind === "file" && input.profile.filePath
      ? [input.profile.filePath, parentOf(input.profile.filePath)]
      : []),
  ]
  const found = directories.filter(Boolean).map((dir) => joinPath(dir, TOOLKIT_FILE_NAME))
  return [...new Set(input.bundled ? [...found, input.bundled] : found)]
}

/**
 * The `/C` value intended to make the toolkit start serving as it opens.
 *
 * Read in ПриОткрытии -- not ПриСозданииНаСервере, as an earlier comment here
 * claimed. The form parses `startup` optionally followed by `;key=value` pairs,
 * applies and persists them, then calls Подключиться() itself. `mode=embedded`
 * selects the in-process HTTP server over the proxy transport, and `port` is
 * saved, so a later manual launch keeps the same one. Unknown keys are logged
 * and ignored; a malformed value aborts the whole startup rather than applying
 * half of it.
 *
 * Older builds ignore all of this: the parsing arrived upstream long after the
 * copies that circulate beside infobases were cut, and in those the embedded
 * server starts only when a person presses "Подключиться". A launch that opens
 * a window and never answers on the port almost always means such a build was
 * picked up -- toolkitCandidates() decides which file that is, and the config
 * directory outranks everything else precisely so a known-good copy can be put
 * there.
 */
export function startupParameter(port: number = MCP_PORT): string {
  return `startup;mode=embedded;port=${port}`
}

/**
 * One platform launch that opens the toolkit and leaves it open.
 *
 * Unlike every operation in infobase/operations.ts this is not a batch run: the
 * process IS the server and must keep running. There is deliberately no
 * `/Out` -- nothing writes a final log because nothing finishes.
 *
 * Quoting follows the same rule as the rest of the fork: the quotes go around
 * the VALUE, and the caller spawns with windowsVerbatimArguments so Node does
 * not add its own.
 */
export function buildToolkitArgs(input: {
  profile: ToolkitProfile
  password: string
  toolkitPath: string
  port?: number
}): string[] {
  return [
    "ENTERPRISE",
    connectionArg(input.profile),
    `/N"${input.profile.userName}"`,
    // An empty /P makes the platform raise the login dialog even when the user
    // has no password -- emit /P only when there is one.
    ...(input.password ? [`/P"${input.password}"`] : []),
    "/Execute",
    `"${input.toolkitPath}"`,
    `/C"${startupParameter(input.port ?? MCP_PORT)}"`,
    "/DisableStartupDialogs",
    "/DisableStartupMessages",
    // 2026-09-23/24, debrief9.md §9.9c. The toolkit session formats dates and
    // amounts in English -- `Формат(Дата, "ДФ='дд ММММ гггг'")` gives
    // "24 September 2026" where the user's own session gives "24 сентября 2026",
    // and `СформироватьСуммуПрописью` spells the amount in English too. Every
    // control print the agent inspects therefore differs from what production
    // renders, which invites both false positives and false negatives; on 09-23
    // and 09-24 the agent had to reason its way to "this is the harness, not my
    // defect", and got it right both times without help.
    //
    // The value is attached to the switch, like /N, /P and /C above: the process
    // is spawned with windowsVerbatimArguments, so a separate "ru" argument
    // reaches the platform as a stray token and the flag does nothing. That was
    // the first version of this line, and the 00:15 run proved it inert.
    //
    // UNVERIFIED whether this is sufficient. `/L` sets the interface language;
    // number and date formatting may instead follow the infobase's regional
    // settings or the session language, in which case a launch flag cannot fix
    // it and the fix belongs elsewhere. Check the control print's month on the
    // next run before believing this.
    "/Lru",
  ]
}
