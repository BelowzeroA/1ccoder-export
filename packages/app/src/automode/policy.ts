// 1CCoder AutoMode policy — which permission requests may be answered for the
// user, and which three classes must always stop and ask a human.
//
// Why this lives on the client rather than in an opencode `permission` config
// block: the block can say "ask" or "allow" per tool and per pattern, but
// AutoMode is not a config value — it is a *decision about how to answer the
// prompts the server raises*, remembered per project. The server-side rules
// cannot express "auto-approve everything in this project except these
// patterns, while a different project keeps prompting", because the global
// config file has no per-project dimension and writing into the user's own
// project config would mean editing their repository. So the profile is applied
// at the only point that actually decides: the auto-responder.
//
// This file is fork-local and imported from exactly one upstream file
// (context/permission-auto-respond.ts), to keep rebases cheap.

/**
 * The three classes of request that keep asking even in AutoMode. Kept as a
 * union rather than a boolean so the UI can name the reason: "AutoMode is on,
 * but this deletes files" is far less alarming than an unexplained prompt.
 */
export type AlwaysAskReason = "destructive_shell" | "git_history" | "infobase_write"

/**
 * The shape the auto-responder has on hand. Both fields are optional because
 * the same predicate is used for mode queries that carry no request at all
 * (`isAutoAccepting(sessionID)`), which must not be treated as always-ask.
 */
export interface ClassifiableRequest {
  readonly permission?: string
  readonly patterns?: readonly string[]
}

/**
 * Permission action for writes to a bound 1C infobase. Phase 7 introduces the
 * operations; the key and its always-ask classification are defined here so the
 * policy is not retro-fitted around them later. Anything under the `infobase_`
 * prefix that is not an explicit read is treated as a write, so a new operation
 * added in Phase 7 fails safe (asks) rather than silently auto-approving.
 */
export const INFOBASE_ACTION_PREFIX = "infobase_"
const INFOBASE_READ_ACTIONS = new Set(["infobase_read", "infobase_list", "infobase_metadata"])

/** Wrappers that delegate to another command; the real verb is what follows. */
const PASSTHROUGH = new Set(["sudo", "doas", "env", "nohup", "time", "command", "nice", "ionice", "exec", "builtin"])

/** Shells whose `-c` / `/c` payload is itself a command line to classify. */
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "cmd", "powershell", "pwsh"])

/**
 * Splits a command line into the commands it will actually run. Deliberately
 * conservative: an operator inside quotes is not an operator, but anything else
 * that separates commands is treated as one, so `git status && rm -rf build`
 * is classified on its second half rather than its first.
 */
export function commandSegments(command: string): string[] {
  const out: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined

  const flush = () => {
    const value = current.trim()
    if (value) out.push(value)
    current = ""
  }

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (quote) {
      if (char === quote) quote = undefined
      current += char
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }

    if (char === "\\" && i + 1 < command.length && (command[i + 1] === "\n" || command[i + 1] === "\r")) {
      // A line continuation joins two halves of one command.
      i++
      continue
    }

    if (char === "\n" || char === "\r" || char === ";") {
      flush()
      continue
    }

    if (char === "&" || char === "|") {
      // Covers &&, ||, single & (background) and a pipe.
      flush()
      if (command[i + 1] === char) i++
      continue
    }

    current += char
  }

  flush()
  return out
}

/** Tokenizes one command, dropping the quotes but keeping quoted content whole. */
export function tokenize(segment: string): string[] {
  const out: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  let quoted = false

  const flush = () => {
    if (current || quoted) out.push(current)
    current = ""
    quoted = false
  }

  for (const char of segment) {
    if (quote) {
      if (char === quote) {
        quote = undefined
        continue
      }
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      quoted = true
      continue
    }
    if (char === " " || char === "\t") {
      flush()
      continue
    }
    current += char
  }

  flush()
  return out
}

/** `/usr/bin/rm` and `C:\Windows\System32\cmd.exe` both reduce to a bare verb. */
function verb(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "")
}

function isAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
}

function hasFlag(tokens: readonly string[], match: (flag: string) => boolean): boolean {
  return tokens.some((token) => token.startsWith("-") && match(token.toLowerCase()))
}

/**
 * True for a clustered short flag such as `-rf` containing the given letter.
 * Matching is case-insensitive on purpose: PowerShell's `-Recurse` and POSIX
 * `-r` should both count, and no rule here depends on `-d` versus `-D`.
 */
function shortFlag(tokens: readonly string[], letter: string): boolean {
  return hasFlag(tokens, (flag) => /^-[a-z]+$/i.test(flag) && flag.slice(1).includes(letter.toLowerCase()))
}

/** True for a long flag, matched on a prefix so `-Recurse` and `-rec` both hit. */
function longFlag(tokens: readonly string[], ...names: string[]): boolean {
  return hasFlag(tokens, (flag) => {
    const name = flag.replace(/^-+/, "").split(/[:=]/)[0]
    if (!name) return false
    return names.some((candidate) => candidate.startsWith(name) && name.length >= 3)
  })
}

/** Windows-style `/s`, `/q` switches, which are not POSIX flags. */
function slashSwitch(tokens: readonly string[], ...names: string[]): boolean {
  return tokens.some((token) => {
    if (!token.startsWith("/")) return false
    const name = token.slice(1).toLowerCase()
    return names.includes(name)
  })
}

/**
 * Whole-disk and mass-delete verbs. These need no flag analysis: running them
 * at all is the kind of thing a person should be looking at.
 */
const DESTRUCTIVE_VERBS = new Set([
  "mkfs",
  "diskpart",
  "fdisk",
  "parted",
  "sfdisk",
  "shred",
  "wipefs",
  "format",
  "format-volume",
  "clear-disk",
  "initialize-disk",
  "remove-partition",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "restart-computer",
  "stop-computer",
])

function destructiveShell(tokens: readonly string[]): boolean {
  const head = verb(tokens[0] ?? "")
  const rest = tokens.slice(1)

  if (DESTRUCTIVE_VERBS.has(head)) return true
  if (head.startsWith("mkfs.")) return true

  // `git clean -fdx` is a mass delete of untracked files, so it belongs to the
  // destructive class rather than the git-history one: nothing leaves the
  // machine, but the work it removes was never committed and cannot come back.
  if (head === "git" && gitSubcommand(rest).sub === "clean") {
    const args = gitSubcommand(rest).args
    return shortFlag(args, "f") || shortFlag(args, "x") || longFlag(args, "force")
  }

  switch (head) {
    case "rm":
    case "remove-item":
    case "ri":
      // A plain `rm file.ts` is ordinary work. Recursive or forced deletion is
      // the case the user asked to be stopped for.
      return shortFlag(rest, "r") || shortFlag(rest, "f") || longFlag(rest, "recurse", "recursive", "force")
    case "rmdir":
    case "rd":
      return slashSwitch(rest, "s") || shortFlag(rest, "r") || longFlag(rest, "recurse", "recursive")
    case "del":
    case "erase":
      return slashSwitch(rest, "s", "q") || rest.some((token) => token.includes("*"))
    case "dd":
      return rest.some((token) => token.toLowerCase().startsWith("of="))
    default:
      return false
  }
}

/**
 * Git operations that either reach other people or rewrite history. Every
 * `git push` is included, not only `--force`: pushing the wrong branch is the
 * mistake this class exists to catch, and a non-forced push is still visible to
 * everyone else the moment it lands.
 */
const GIT_HISTORY_SUBCOMMANDS = new Set(["push", "rebase", "filter-branch", "filter-repo"])

/** Finds the subcommand past git's own options, so `git -C dir push` still hits. */
function gitSubcommand(rest: readonly string[]): { sub: string; args: string[] } {
  let index = 0
  while (index < rest.length) {
    const token = rest[index]
    if (!token.startsWith("-")) break
    // `-C <path>` and `-c <name=value>` take a separate value.
    if (token === "-C" || token === "-c") index += 2
    else index += 1
  }
  return { sub: (rest[index] ?? "").toLowerCase(), args: rest.slice(index + 1) }
}

function gitHistory(tokens: readonly string[]): boolean {
  if (verb(tokens[0] ?? "") !== "git") return false
  const { sub, args } = gitSubcommand(tokens.slice(1))

  if (GIT_HISTORY_SUBCOMMANDS.has(sub)) return true
  if (sub === "reset") return longFlag(args, "hard")
  return false
}

function infobaseWrite(action: string): boolean {
  if (!action.startsWith(INFOBASE_ACTION_PREFIX)) return false
  return !INFOBASE_READ_ACTIONS.has(action)
}

/**
 * Classifies a pending permission request. `undefined` means AutoMode may
 * answer it; anything else names why a human has to.
 */
export function alwaysAskReason(request: ClassifiableRequest): AlwaysAskReason | undefined {
  const action = request.permission
  if (!action) return undefined

  if (infobaseWrite(action)) return "infobase_write"
  if (action !== "bash") return undefined

  for (const pattern of request.patterns ?? []) {
    for (const segment of commandSegments(pattern)) {
      // Only *leading* assignments are an env prefix (`FOO=1 rm -rf x`). Later
      // ones are arguments, and stripping those would hide `dd of=/dev/sdb`.
      let tokens = tokenize(segment)
      while (tokens.length && isAssignment(tokens[0])) tokens = tokens.slice(1)

      // Unwrap `sudo`, `env FOO=1`, and friends until a real verb is in front.
      while (tokens.length > 1 && PASSTHROUGH.has(verb(tokens[0]))) tokens = tokens.slice(1)
      if (!tokens.length) continue

      // `bash -c "rm -rf build"` is classified on its payload, not on `bash`.
      if (SHELLS.has(verb(tokens[0]))) {
        const payload = tokens.slice(1).find((token) => !token.startsWith("-") && !token.startsWith("/"))
        const nested = payload ? alwaysAskReason({ permission: "bash", patterns: [payload] }) : undefined
        if (nested) return nested
      }

      if (destructiveShell(tokens)) return "destructive_shell"
      if (gitHistory(tokens)) return "git_history"
    }
  }

  return undefined
}

/** Convenience predicate for the auto-responder's hot path. */
export function isAlwaysAsk(request: ClassifiableRequest): boolean {
  return alwaysAskReason(request) !== undefined
}
