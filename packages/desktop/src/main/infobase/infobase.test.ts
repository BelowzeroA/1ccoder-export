import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ProfileStore, type SecretBox, type StoreDeps, type StoredProfile } from "../profiles/profile-store"
import { SessionBindingStore, type BindingStoreDeps, type SessionBinding } from "../profiles/session-binding"
import { platformSpawnOptions, type PlatformRun, type VerifyDeps } from "../profiles/verify"
import { describeProfile, designerBusy, runOperation } from "./executor"
import {
  buildArgs,
  checkPath,
  connectionArg,
  pathSpec,
  EXEC_REQUEST_TIMEOUT_MS,
  OPERATION_TIMEOUT_MS,
  operationTimeout,
  type OperationId,
  checkSecondPath,
  needsExclusiveInfobase,
  requiresSecondPath,
  OPERATIONS,
  type PathProbe,
  requiresPath,
  writesToInfobase,
} from "./operations"

const PROFILE: StoredProfile = {
  id: "p1",
  accountEmail: "user@example.com",
  name: "Бухгалтерия",
  platformPath: "D:\\bin\\1cv8.exe",
  kind: "file",
  filePath: "D:\\Bases\\Acc",
  workingDirectory: "D:\\Work\\Acc",
  userName: "Администратор",
  passwordCipher: "enc:c2VjcmV0",
  createdAt: 1,
  updatedAt: 1,
}

function harness(options: { binding?: SessionBinding | null; run?: PlatformRun } = {}) {
  let profiles: StoredProfile[] = [PROFILE]
  const secrets: SecretBox = {
    available: () => true,
    encrypt: (plain) => `enc:${Buffer.from(plain, "utf8").toString("base64")}`,
    decrypt: (cipher) => (cipher.startsWith("enc:") ? Buffer.from(cipher.slice(4), "base64").toString("utf8") : null),
  }
  const storeDeps: StoreDeps = {
    read: () => profiles.map((row) => ({ ...row })),
    write: (next) => {
      profiles = next
    },
    secrets,
    now: () => 1,
    newId: () => "new",
  }

  const binding =
    options.binding === undefined ? { conversationId: "c1", profileId: "p1", chosenAt: 1 } : options.binding
  let bindings: SessionBinding[] = binding ? [binding] : []
  const bindingDeps: BindingStoreDeps = {
    read: () => bindings.map((row) => ({ ...row })),
    write: (next) => {
      bindings = next
    },
    now: () => 1,
  }

  const launched: Array<{ exe: string; args: string[] }> = []
  const verify: VerifyDeps = {
    runPlatform: async (exe, args) => {
      launched.push({ exe, args })
      return options.run ?? { exitCode: 0, timedOut: false }
    },
    readOut: async () => "Ошибок не обнаружено",
    pathExists: async () => true,
    isFile: async () => true,
    listDir: async () => ["1cv8.exe"],
    probeTcp: async () => true,
    ensureWritableDir: async () => "ok",
    tempDir: async () => "C:\\temp\\op",
    cleanup: async () => undefined,
  }

  return {
    deps: { profiles: new ProfileStore(storeDeps), bindings: new SessionBindingStore(bindingDeps), verify },
    launched,
  }
}

describe("operation table", () => {
  // The read/write split is what the whole gate rests on. If an operation is
  // misclassified here, it is either gated when it need not be or -- far worse
  // -- writes to live business data without asking.
  // 2026-09-23, debrief7.md §8.7 / D12. Both conventions were established by
  // trial over ~70 minutes; encoding them means the next caller does not repeat
  // that. Load in particular is counter-intuitive: XML first, and the target
  // container must already exist.
  // debrief14.md §14.7: the objects of a selective dump go through a list file.
  test("a listed dump passes -listFile after the directory", () => {
    expect(OPERATIONS.dump_config_to_files.args({ path: "C:\\out", listFile: "C:\\t\\objects.txt" })).toEqual([
      "/DumpConfigToFiles",
      '"C:\\out"',
      "-listFile",
      '"C:\\t\\objects.txt"',
    ])
  })

  test("the executor writes the listed objects one per line and passes the file", async () => {
    const { deps, launched } = harness()
    const dir = mkdtempSync(join(tmpdir(), "1ccoder-list-"))
    try {
      const result = await runOperation(
        { conversationId: "c1", operation: "dump_config_to_files", path: "C:\\w\\base_facts", objects: ["Configuration", "Language.Русский"] },
        { ...deps, verify: { ...deps.verify, tempDir: async () => dir, cleanup: async () => undefined } },
      )
      expect(result.ok).toBe(true)
      const args = launched[0]!.args
      expect(args.slice(args.indexOf("-listFile"), args.indexOf("-listFile") + 2)).toEqual(["-listFile", `"${join(dir, "objects.txt")}"`])
      expect(readFileSync(join(dir, "objects.txt"), "utf8")).toBe("Configuration\nLanguage.Русский\n")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the .epf round-trip operations carry the platform's argument order", () => {
    expect(OPERATIONS.dump_epf_to_files.args({ path: "C:\\out", secondPath: "C:\\a.epf" })).toEqual([
      "/DumpExternalDataProcessorOrReportToFiles",
      '"C:\\out"',
      '"C:\\a.epf"',
    ])
    expect(
      OPERATIONS.load_epf_from_files.args({ path: "C:\\out.xml", secondPath: "C:\\a.epf" }),
    ).toEqual(["/LoadExternalDataProcessorOrReportFromFiles", '"C:\\out.xml"', '"C:\\a.epf"'])
  })

  test("both .epf operations are guarded DESIGNER reads", () => {
    for (const id of ["dump_epf_to_files", "load_epf_from_files"] as const) {
      expect(OPERATIONS[id].mode).toBe("DESIGNER")
      expect(writesToInfobase(id)).toBe(false)
      expect(needsExclusiveInfobase(id)).toBe(true)
    }
  })

  test("classifies reads and writes explicitly", () => {
    expect(writesToInfobase("check")).toBe(false)
    expect(writesToInfobase("dump_config")).toBe(false)
    expect(writesToInfobase("dump_config_to_files")).toBe(false)
    expect(writesToInfobase("load_config")).toBe(true)
    expect(writesToInfobase("update_db")).toBe(true)
    expect(writesToInfobase("execute")).toBe(true)
  })

  // 2026-09-21, debrief6.md §8.1. The point of adding it was to bring the
  // readable dump INSIDE the guard: three sessions drove /DumpConfigToFiles
  // through `bash` instead, which takes none of the toolkit precautions.
  test("the readable dump is a guarded DESIGNER read", () => {
    expect(OPERATIONS.dump_config_to_files.mode).toBe("DESIGNER")
    expect(needsExclusiveInfobase("dump_config_to_files")).toBe(true)
    expect(OPERATIONS.dump_config_to_files.args({ path: "C:\\out" })).toEqual([
      "/DumpConfigToFiles",
      '"C:\\out"',
    ])
  })

  test("every operation declares a mode and a summary", () => {
    for (const definition of Object.values(OPERATIONS)) {
      expect(["DESIGNER", "ENTERPRISE"]).toContain(definition.mode)
      expect(definition.summary.length).toBeGreaterThan(0)
    }
  })

  test("running code in the base is an ENTERPRISE operation and a write", () => {
    expect(OPERATIONS.execute.mode).toBe("ENTERPRISE")
    expect(OPERATIONS.execute.writes).toBe(true)
  })

  test("knows which operations need a path", () => {
    expect(requiresPath("execute")).toBe(true)
    expect(requiresPath("check")).toBe(false)
  })
})

// 2026-09-21, debrief5.md §8.1. windowsVerbatimArguments tells libuv not to
// quote anything -- including the executable it puts at the front of the
// command line. 1C lives in "C:\Program Files\...", so the command line split
// at that space and the platform read `Files\1cv8\...\1cv8.exe` as its start
// mode; DESIGNER was never seen.
//
// Every DESIGNER operation failed with «Неопределен режим запуска» for days
// (1c_check_config, 1c_dump_config) while ENTERPRISE ones looked fine, because
// Enterprise is the platform's default when the mode argument is unrecognised.
// A working tool masked two broken ones, and the error text blamed the wrong
// layer. Verified by running both operations before and after the fix.
describe("platform spawn options", () => {
  const exe = "C:\\Program Files\\1cv8\\8.5.1.1529\\bin\\1cv8.exe"

  test("quotes argv0 on Windows so a spaced executable path stays one token", () => {
    const opts = platformSpawnOptions(exe, true)
    expect(opts.windowsVerbatimArguments).toBe(true)
    expect(opts.argv0).toBe(`"${exe}"`)
  })

  test("leaves argv0 alone off Windows, where verbatim does not apply", () => {
    const opts = platformSpawnOptions(exe, false)
    expect(opts.windowsVerbatimArguments).toBe(false)
    expect(opts.argv0).toBeUndefined()
  })

  // The pairing is the bug: verbatim without a quoted argv0 is what broke
  // DESIGNER. Neither half is safe to change without the other.
  test("verbatim and a quoted argv0 are set together or not at all", () => {
    for (const onWindows of [true, false]) {
      const opts = platformSpawnOptions(exe, onWindows)
      expect(opts.windowsVerbatimArguments).toBe(opts.argv0 !== undefined)
    }
  })
})

// 2026-09-20, debrief4.md §3.2. The ordering below is the entire fix, and it
// is invisible at both call sites -- which is why it is asserted here rather
// than trusted to a comment. With the transport deadline shorter than the
// process deadline (the accidental state: no signal on the fetch, so undici's
// 300s default against a 600s process timeout), a long operation reports a
// transport error while the platform is still running, nothing is cleaned up,
// and the agent retries into a second launch.
describe("timeout ordering", () => {
  // Per operation now, since the slow ones declare their own deadline: the
  // invariant has to hold for the slowest, not for the default.
  const slowest = Math.max(...Object.keys(OPERATIONS).map((id) => operationTimeout(id as OperationId)))

  test("the relay request outlives the process it is waiting for", () => {
    expect(EXEC_REQUEST_TIMEOUT_MS).toBeGreaterThan(slowest)
  })

  test("with enough margin to carry the executor's own answer back", () => {
    expect(EXEC_REQUEST_TIMEOUT_MS - slowest).toBeGreaterThanOrEqual(30_000)
  })

  test("a full configuration unpack is not cut off at the default", () => {
    // Measured at 17.5 minutes on a БП-sized configuration.
    expect(operationTimeout("dump_config_to_files")).toBeGreaterThan(18 * 60 * 1000)
    expect(operationTimeout("check")).toBe(OPERATION_TIMEOUT_MS)
  })
})

describe("re-dumping over an earlier dump", () => {
  test("adds -update only when asked", () => {
    const base = { id: "dump_config_to_files" as const, connection: '/F"b"', userName: "u", password: "", outPath: "o" }
    expect(buildArgs({ ...base, path: "C:/w/cfg", update: true })).toContain("-update")
    expect(buildArgs({ ...base, path: "C:/w/cfg" })).not.toContain("-update")
  })
})

// 2026-09-20, debrief4.md §2.2 and §3. Nine .epf-launcher calls exist in the
// app's whole history; six of them could not possibly have worked -- an empty
// path, `C:\nonexistent`, `C:\nonexistent.epf` twice, and a real but unrelated
// .epf the agent had itself dismissed hours earlier. All six launched
// 1cv8.exe. The nonexistent ones raised a MODAL error dialog despite
// /DisableStartupMessages, which disables the entire 1C client and therefore
// the MCP Toolkit running inside it, for the length of the timeout.
//
// These tests exist so that a path which cannot work never reaches the
// platform, whatever made the agent produce it.
describe("path guard", () => {
  const nothingExists: PathProbe = { isFile: () => false, isDirectory: () => false }
  const everythingExists: PathProbe = { isFile: () => true, isDirectory: () => true }

  test("operations without a path argument are unaffected", () => {
    expect(checkPath("check", undefined, nothingExists)).toBeNull()
    expect(checkPath("update_db", undefined, nothingExists)).toBeNull()
  })

  test("refuses the empty path that was actually sent", () => {
    expect(checkPath("execute", "", everythingExists)).not.toBeNull()
    expect(checkPath("execute", "   ", everythingExists)).not.toBeNull()
    expect(checkPath("execute", undefined, everythingExists)).not.toBeNull()
  })

  test("refuses the two nonexistent paths that were actually sent", () => {
    expect(checkPath("execute", "C:\\nonexistent", nothingExists)).not.toBeNull()
    expect(checkPath("execute", "C:\\nonexistent.epf", nothingExists)).not.toBeNull()
  })

  // The wrong tool is the likely cause, so the refusal names the right one --
  // being told "no" without being told what to call instead is what produced
  // three identical retries.
  test("points a misdirected caller at the code tool", () => {
    expect(checkPath("execute", "", everythingExists)).toContain("1c_execute_code")
    expect(checkPath("execute", "C:\\report.txt", everythingExists)).toContain("1c_execute_code")
  })

  test("accepts a real .epf and .erf", () => {
    expect(checkPath("execute", "C:\\work\\report.epf", everythingExists)).toBeNull()
    expect(checkPath("execute", "C:\\work\\REPORT.ERF", everythingExists)).toBeNull()
  })

  // dump_config writes its file, so requiring it to exist would break the
  // normal case; only the directory it lands in is checked.
  test("an output path is checked by its directory, not its own existence", () => {
    expect(checkPath("dump_config", "C:\\out\\cfg.cf", { isFile: () => false, isDirectory: () => true })).toBeNull()
    expect(checkPath("dump_config", "C:\\missing\\cfg.cf", nothingExists)).not.toBeNull()
  })

  // 2026-09-21, debrief6.md §8.1 / C2. A dump target is a folder, and the
  // executor creates it -- so "not there yet" has to be acceptable while a
  // parent that does not exist must not be, or a typo costs a ten-minute
  // configurator run before anyone finds out.
  describe("a dump-to-files directory", () => {
    const onlyDirs: PathProbe = { isFile: () => false, isDirectory: () => true }
    const onlyParent: PathProbe = {
      isFile: () => false,
      isDirectory: (path) => path === "C:\\out",
    }

    test("is accepted when it already exists", () => {
      expect(checkPath("dump_config_to_files", "C:\\out\\cfg", onlyDirs)).toBeNull()
    })

    test("is accepted when only its parent exists, since it gets created", () => {
      expect(checkPath("dump_config_to_files", "C:\\out\\cfg", onlyParent)).toBeNull()
    })

    test("is refused when the parent is not there either", () => {
      expect(checkPath("dump_config_to_files", "C:\\typo\\cfg", nothingExists)).not.toBeNull()
    })

    // The one case that would silently do the wrong thing: /DumpConfigToFiles
    // pointed at a file. (A real path is never both, so the probe says file
    // only -- `everythingExists` would answer "directory" first and pass.)
    test("is refused when the path is an existing file", () => {
      const aFile: PathProbe = { isFile: () => true, isDirectory: (p) => p === "C:\\out" }
      expect(checkPath("dump_config_to_files", "C:\\out\\cfg.cf", aFile)).toContain("каталог")
    })

    // Any extension is fine for a folder name, unlike every other path spec.
    test("carries no extension requirement", () => {
      expect(checkPath("dump_config_to_files", "C:\\out\\anything.at.all", onlyDirs)).toBeNull()
    })
  })

  // 2026-09-23, debrief7.md §8.7 / D12. The second argument has its own rules,
  // and load's refusal has to teach the non-obvious half -- an empty stub is not
  // a container -- because that cost 25 minutes and two wrong hypotheses.
  describe("the second path of the .epf operations", () => {
    test("is required, and named when missing", () => {
      expect(requiresSecondPath("load_epf_from_files")).toBe(true)
      expect(requiresSecondPath("dump_config")).toBe(false)
      expect(checkSecondPath("load_epf_from_files", undefined, everythingExists)).toContain(".epf")
    })

    test("accepts a real .epf and refuses a wrong extension", () => {
      expect(checkSecondPath("dump_epf_to_files", "C:\\a.epf", everythingExists)).toBeNull()
      expect(checkSecondPath("dump_epf_to_files", "C:\\a.xml", everythingExists)).not.toBeNull()
    })

    // debrief16.md §16.3: on 8.5.1 the load creates a missing target; only its
    // directory has to exist. The old refusal sent agents to copy another task's .epf.
    test("load builds into a new file, and needs only its directory", () => {
      const onlyDirectories = { isFile: () => false, isDirectory: () => true }
      expect(checkSecondPath("load_epf_from_files", "C:\\work\\new.erf", onlyDirectories)).toBeNull()
      expect(checkSecondPath("load_epf_from_files", "C:\\gone\\new.epf", nothingExists)).toContain("Нет каталога")
      // Dump still reads an existing file.
      expect(checkSecondPath("dump_epf_to_files", "C:\\gone.epf", nothingExists)).toContain("Файла обработки нет")
    })
  })

  test("an input path must exist", () => {
    expect(checkPath("load_config", "C:\\in\\cfg.cf", nothingExists)).not.toBeNull()
    expect(checkPath("load_config", "C:\\in\\cfg.cf", everythingExists)).toBeNull()
  })

  test("extensions are enforced per operation", () => {
    expect(checkPath("load_config", "C:\\in\\proc.epf", everythingExists)).not.toBeNull()
    expect(checkPath("execute", "C:\\in\\cfg.cf", everythingExists)).not.toBeNull()
  })
})

describe("argument building", () => {
  test("quotes the value rather than the whole argument", () => {
    expect(connectionArg({ kind: "file", filePath: "D:\\Bases\\Acc" })).toBe('/F"D:\\Bases\\Acc"')
    expect(connectionArg({ kind: "server", serverCluster: "app-1c", serverDatabase: "trade" })).toBe(
      '/S"app-1c\\trade"',
    )
  })

  test("always carries a command and a log path", () => {
    const args = buildArgs({
      id: "check",
      connection: '/F"D:\\Bases\\Acc"',
      userName: "Админ",
      password: "x",
      outPath: "C:\\out.log",
    })
    expect(args[0]).toBe("DESIGNER")
    expect(args).toContain("/CheckConfig")
    expect(args.some((arg) => arg.startsWith("/Out"))).toBe(true)
  })
})

// 2026-09-20, debrief4.md §3.1. The MCP Toolkit runs inside a 1C client
// session, so an .epf that opens a modal form -- or a missing one, which raises
// the platform's own error dialog -- disables the client and takes the 1c_*
// tools with it. Nothing said so at the time: the tools simply stopped
// answering, which reads like a network fault, and the agent retried into a
// second and third blocked window. Comparing liveness before and after the run
// is the only way the app can notice at all.
describe("self-block detection", () => {
  function withToolkit(alive: boolean[], run?: PlatformRun) {
    const base = harness({ run })
    let call = 0
    return {
      ...base,
      deps: {
        ...base.deps,
        toolkit: {
          snapshot: async () => ({ port: 6003, state: "running", alive: alive[Math.min(call++, alive.length - 1)]! }),
          stop: async () => undefined,
        },
      },
    }
  }

  test("reports the toolkit going away across an ENTERPRISE run", async () => {
    const { deps } = withToolkit([true, false])
    const result = await runOperation(
      { conversationId: "c1", operation: "execute", path: "C:\\p.epf", permitted: true },
      deps,
    )
    expect(result).toMatchObject({ toolkitBlocked: true })
  })

  // 2026-09-27, tasks/task8. The notice guessed at a modal; the window's own
  // text says what it is and what the user has to do.
  test("carries the text of the window now holding the session", async () => {
    const base = withToolkit([true, false])
    let asked = 0
    const deps = {
      ...base.deps,
      toolkit: {
        ...base.deps.toolkit,
        dialogs: async () => {
          asked++
          return "Окно «1С:Предприятие» (PID 5), модальное:\nКаталог не обнаружен"
        },
      },
    }
    const result = await runOperation(
      { conversationId: "c1", operation: "execute", path: "C:\\p.epf", permitted: true },
      deps,
    )
    expect(result).toMatchObject({ toolkitBlocked: true })
    expect((result as { blockingDialogs?: string }).blockingDialogs).toContain("Каталог не обнаружен")
    expect(asked).toBe(1)
  })

  test("does not read the screen when the toolkit survived", async () => {
    const base = withToolkit([true, true])
    let asked = 0
    const deps = { ...base.deps, toolkit: { ...base.deps.toolkit, dialogs: async () => (asked++, "x") } }
    const result = await runOperation(
      { conversationId: "c1", operation: "execute", path: "C:\\p.epf", permitted: true },
      deps,
    )
    expect((result as { blockingDialogs?: string }).blockingDialogs).toBeUndefined()
    expect(asked).toBe(0)
  })

  test("says nothing when the toolkit survives the run", async () => {
    const { deps } = withToolkit([true, true])
    const result = await runOperation(
      { conversationId: "c1", operation: "execute", path: "C:\\p.epf", permitted: true },
      deps,
    )
    expect(result.toolkitBlocked).toBe(false)
  })

  // Not this run's doing, so not this run's to report -- blaming it would send
  // the agent after the wrong cause.
  test("does not blame the run when the toolkit was already down", async () => {
    const { deps } = withToolkit([false, false])
    const result = await runOperation(
      { conversationId: "c1", operation: "execute", path: "C:\\p.epf", permitted: true },
      deps,
    )
    expect(result.toolkitBlocked).toBe(false)
  })

  // A DESIGNER run closes the toolkit on purpose; that is already reported as
  // toolkitStopped, and reporting it twice under a scarier name would be worse
  // than saying nothing.
  test("a deliberate close is not reported as a self-block", async () => {
    const { deps } = withToolkit([true, false])
    const result = await runOperation({ conversationId: "c1", operation: "update_db", permitted: true }, deps)
    expect(result).toMatchObject({ toolkitStopped: true })
    expect(result.toolkitBlocked).toBe(false)
  })

  // 2026-09-21, debrief5.md §8.2. A DESIGNER run closes the toolkit before it
  // starts, and the toolkit costs ~3 minutes to bring back. When the platform
  // never launched at all, the base was never touched and that price was paid
  // for nothing -- so the executor hands it back, and says so instead of
  // telling the agent the toolkit is down.
  //
  // Only this branch: a run that DID start and then failed leaves the agent
  // likely to retry, and restarting between configurator operations would
  // thrash. That is why toolkitStopped stays set everywhere else.
  test("hands the toolkit back when the platform never launched", async () => {
    let started = 0
    const base = harness({ run: { exitCode: null, timedOut: false, spawnError: "ENOENT" } })
    const deps = {
      ...base.deps,
      toolkit: {
        snapshot: async () => ({ port: 6003, state: "running", alive: true }),
        stop: async () => undefined,
        start: async () => {
          started += 1
        },
      },
    }
    const result = await runOperation({ conversationId: "c1", operation: "check" }, deps)
    expect(result).toMatchObject({ ok: false, reason: "launch-failed", toolkitRestored: true })
    // Not also reported as stopped: it is coming back, and saying both would
    // send the agent to 1c_toolkit_start for a toolkit already starting.
    expect((result as { toolkitStopped?: boolean }).toolkitStopped).toBe(false)
    expect(started).toBe(1)
  })

  test("leaves the toolkit down when the run actually happened", async () => {
    let started = 0
    const base = harness({ run: { exitCode: 1, timedOut: false } })
    const deps = {
      ...base.deps,
      toolkit: {
        snapshot: async () => ({ port: 6003, state: "running", alive: true }),
        stop: async () => undefined,
        start: async () => {
          started += 1
        },
      },
    }
    const result = await runOperation({ conversationId: "c1", operation: "check" }, deps)
    expect(result).toMatchObject({ ok: true, toolkitStopped: true })
    expect(started).toBe(0)
  })

  // The case that actually happened: the call timed out AND left a modal
  // behind. Both facts have to reach the agent, or it retries.
  test("reports the block even when the run itself failed", async () => {
    const { deps } = withToolkit([true, false], { exitCode: null, timedOut: true })
    const result = await runOperation(
      { conversationId: "c1", operation: "execute", path: "C:\\p.epf", permitted: true },
      deps,
    )
    expect(result).toMatchObject({ ok: false, reason: "timed-out", toolkitBlocked: true })
  })
})

describe("runOperation", () => {
  test("runs a read without any permission being granted", async () => {
    const { deps, launched } = harness()
    const result = await runOperation({ conversationId: "c1", operation: "check" }, deps)
    expect(result.ok).toBe(true)
    expect(launched).toHaveLength(1)
  })

  // The gate. A write reaching the platform without the permission having been
  // granted is the exact failure this phase exists to prevent.
  test("refuses a write when permission was not granted, and launches nothing", async () => {
    const { deps, launched } = harness()
    const result = await runOperation({ conversationId: "c1", operation: "update_db" }, deps)
    expect(result).toMatchObject({ ok: false, reason: "not-permitted" })
    expect(launched).toHaveLength(0)
  })

  test("runs a write once permission was granted", async () => {
    const { deps, launched } = harness()
    const result = await runOperation({ conversationId: "c1", operation: "update_db", permitted: true }, deps)
    expect(result.ok).toBe(true)
    expect(launched).toHaveLength(1)
  })

  // A session that chose "без профиля" has no infobase by construction, so
  // this must fail even if the caller claims permission.
  test("refuses everything for a profile-less session", async () => {
    const { deps, launched } = harness({ binding: { conversationId: "c1", profileId: null, chosenAt: 1 } })
    const result = await runOperation({ conversationId: "c1", operation: "check", permitted: true }, deps)
    expect(result).toMatchObject({ ok: false, reason: "no-profile" })
    expect(launched).toHaveLength(0)
  })

  test("refuses for a session that has not chosen at all", async () => {
    const { deps } = harness({ binding: null })
    const result = await runOperation({ conversationId: "c1", operation: "check" }, deps)
    expect(result).toMatchObject({ ok: false, reason: "no-profile" })
  })

  test("refuses an operation it does not know", async () => {
    const { deps, launched } = harness()
    const result = await runOperation({ conversationId: "c1", operation: "rm -rf", permitted: true }, deps)
    expect(result).toMatchObject({ ok: false, reason: "unknown-operation" })
    expect(launched).toHaveLength(0)
  })

  test("refuses an operation that needs a path without one", async () => {
    const { deps } = harness()
    const result = await runOperation({ conversationId: "c1", operation: "execute", permitted: true }, deps)
    expect(result).toMatchObject({ ok: false, reason: "path-required" })
  })

  test("passes the decrypted password to the platform and never returns it", async () => {
    const { deps, launched } = harness()
    const result = await runOperation({ conversationId: "c1", operation: "check" }, deps)
    expect(launched[0]!.args).toContain('/P"secret"')
    expect(JSON.stringify(result)).not.toContain("secret")
  })

  test("reports a timeout rather than pretending the operation succeeded", async () => {
    const { deps } = harness({ run: { exitCode: null, timedOut: true } })
    const result = await runOperation({ conversationId: "c1", operation: "check" }, deps)
    expect(result).toMatchObject({ ok: false, reason: "timed-out" })
  })

  test("reports a failure to launch", async () => {
    const { deps } = harness({ run: { exitCode: null, timedOut: false, spawnError: "ENOENT" } })
    const result = await runOperation({ conversationId: "c1", operation: "check" }, deps)
    expect(result).toMatchObject({ ok: false, reason: "launch-failed" })
  })
})

describe("describeProfile", () => {
  // debrief15.md: the plugin decides on the asks from this answer.
  test("carries the standing permission to write without confirmation, and only when set", async () => {
    const { deps } = harness()
    expect(await describeProfile({ conversationId: "c1" }, deps)).not.toHaveProperty("allowWriteWithoutConfirmation")
    const store = deps.profiles
    const allowing = {
      ...deps,
      profiles: { get: (id: string) => ({ ...store.get(id)!, allowWriteWithoutConfirmation: true }) } as unknown as typeof store,
    }
    expect(await describeProfile({ conversationId: "c1" }, allowing)).toMatchObject({ ok: true, allowWriteWithoutConfirmation: true })
  })

  test("tells the agent where the platform and the infobase are", async () => {
    const { deps } = harness()
    const result = await describeProfile({ conversationId: "c1" }, deps)
    expect(result).toMatchObject({
      ok: true,
      name: "Бухгалтерия",
      platformPath: "D:\\bin\\1cv8.exe",
      kind: "file",
      infobase: "D:\\Bases\\Acc",
      workingDirectory: "D:\\Work\\Acc",
      userName: "Администратор",
    })
  })

  // The one field that must never travel. The agent is told whether a password
  // exists, because that decides whether it may launch the platform itself.
  test("says a password exists without ever carrying it", async () => {
    const { deps } = harness()
    const result = await describeProfile({ conversationId: "c1" }, deps)
    expect(result).toMatchObject({ ok: true, hasPassword: true })
    expect(JSON.stringify(result)).not.toContain("secret")
  })

  test("includes the toolkit's state, which is half the question being asked", async () => {
    const { deps } = harness()
    const result = await describeProfile(
      { conversationId: "c1" },
      { ...deps, toolkit: async () => ({ port: 6003, state: "failed", alive: false, reason: "no-toolkit" }) },
    )
    expect(result).toMatchObject({ ok: true, toolkit: { port: 6003, alive: false, reason: "no-toolkit" } })
  })

  // A toolkit probe that hangs or throws must not take the answer with it: the
  // platform path is useful on its own.
  test("still answers when the toolkit cannot be probed", async () => {
    const { deps } = harness()
    const result = await describeProfile(
      { conversationId: "c1" },
      {
        ...deps,
        toolkit: () => Promise.reject(new Error("no supervisor")),
      },
    )
    expect(result).toMatchObject({ ok: true, name: "Бухгалтерия" })
  })

  test("a session without a profile is told so, not handed someone else's", async () => {
    const { deps } = harness({ binding: null })
    expect(await describeProfile({ conversationId: "c1" }, deps)).toMatchObject({ ok: false, reason: "no-profile" })
  })

  // 2026-09-25, skills_rebuild_plan.md Part 2.2 / step 6.
  describe("the configuration", () => {
    const detected = { name: "БухгалтерияПредприятия", version: "3.0.205.22", source: "toolkit" as const, detectedAt: 1 }
    const up = async () => ({ port: 6003, state: "running", alive: true })

    test("is detected when the toolkit is up and nothing is recorded yet", async () => {
      const { deps } = harness()
      let asked = 0
      const result = await describeProfile(
        { conversationId: "c1" },
        { ...deps, toolkit: up, detectConfiguration: async () => (asked++, detected) },
      )
      expect(asked).toBe(1)
      expect(result).toMatchObject({ ok: true, configuration: { name: "БухгалтерияПредприятия" } })
    })

    // The guards look the pack up on the refusal path; a refusal must never
    // wait on a toolkit that may be busy.
    test("is never asked for with detect: false", async () => {
      const { deps } = harness()
      let asked = 0
      await describeProfile(
        { conversationId: "c1", detect: false },
        { ...deps, toolkit: up, detectConfiguration: async () => (asked++, detected) },
      )
      expect(asked).toBe(0)
    })

    test("is not asked for again once recorded", async () => {
      const { deps } = harness()
      deps.profiles.recordConfiguration("p1", detected)
      let asked = 0
      const result = await describeProfile(
        { conversationId: "c1" },
        { ...deps, toolkit: up, detectConfiguration: async () => (asked++, undefined) },
      )
      expect(asked).toBe(0)
      expect(result).toMatchObject({ ok: true, configuration: { version: "3.0.205.22" } })
    })
  })
})


// debrief13.md §13.12: a dump made with `extension` put the extension's name in
// the profile as the base's configuration, and the next session lost its pack.
describe("the configuration a dump records", () => {
  const main = "<MetaDataObject><Configuration><Properties><Name>БухгалтерияПредприятия</Name><Version>3.0.205.22</Version></Properties></Configuration></MetaDataObject>"
  const readDump = { read: async (path: string) => (path.endsWith("Configuration.xml") ? main : null) }

  test("a main configuration dump records it", async () => {
    const { deps } = harness()
    await runOperation(
      { conversationId: "c1", operation: "dump_config_to_files", path: "C:\\w\\cfg", permitted: true },
      { ...deps, readDump },
    )
    expect(deps.profiles.get("p1")?.configuration?.name).toBe("БухгалтерияПредприятия")
  })

  test("an extension's dump records nothing", async () => {
    const { deps } = harness()
    await runOperation(
      { conversationId: "c1", operation: "dump_config_to_files", path: "C:\\w\\ext", extension: "EXT", permitted: true },
      { ...deps, readDump },
    )
    expect(deps.profiles.get("p1")?.configuration).toBeUndefined()
  })
})

describe("designer runs do not share the infobase", () => {
  // 2026-09-16: a batch DESIGNER launch against a base the MCP Toolkit was
  // holding truncated RuntimeCacheStorage to 20 bytes and killed the toolkit.
  // The recovery -- three 1c_execute calls failing with EMPTY error strings
  // (686s of pure retry), a process hunt, a port probe, a cache cleanup and a
  // 444s restart -- was the single largest time sink in that session.

  /** A toolkit that reports itself alive and records whether it was stopped. */
  function fakeToolkit(options: { alive?: boolean; snapshotThrows?: boolean } = {}) {
    const stops: number[] = []
    return {
      stops,
      dep: {
        snapshot: async () => {
          if (options.snapshotThrows) throw new Error("port probe failed")
          return { port: 6003, state: "running", alive: options.alive ?? true }
        },
        stop: async () => {
          stops.push(1)
        },
      },
    }
  }

  test("every DESIGNER operation is exclusive, and no ENTERPRISE one is", () => {
    // Derived from mode on purpose, so a DESIGNER operation added later
    // inherits the guard rather than having to remember it.
    for (const definition of Object.values(OPERATIONS)) {
      expect(needsExclusiveInfobase(definition.id)).toBe(definition.mode === "DESIGNER")
    }
  })

  test("a live toolkit is closed before the configurator runs", async () => {
    const { deps, launched } = harness()
    const toolkit = fakeToolkit({ alive: true })
    const result = await runOperation(
      { conversationId: "c1", operation: "check" },
      { ...deps, toolkit: toolkit.dep },
    )
    expect(toolkit.stops).toHaveLength(1)
    expect(launched).toHaveLength(1)
    expect(result.ok).toBe(true)
    expect(result.ok && result.toolkitStopped).toBe(true)
  })

  test("a toolkit that is not running is left alone", async () => {
    const { deps } = harness()
    const toolkit = fakeToolkit({ alive: false })
    const result = await runOperation(
      { conversationId: "c1", operation: "check" },
      { ...deps, toolkit: toolkit.dep },
    )
    expect(toolkit.stops).toHaveLength(0)
    expect(result.ok && result.toolkitStopped).toBe(false)
  })

  test("an ENTERPRISE run does not close the toolkit", async () => {
    // The toolkit IS an ENTERPRISE session. Treating those as exclusive would
    // forbid the normal workflow rather than protect it.
    const { deps } = harness()
    const toolkit = fakeToolkit({ alive: true })
    const result = await runOperation(
      { conversationId: "c1", operation: "execute", path: "D:\\x.epf", permitted: true },
      { ...deps, toolkit: toolkit.dep },
    )
    expect(toolkit.stops).toHaveLength(0)
    expect(result.ok).toBe(true)
  })

  test("a refused operation does not close the toolkit as a side effect", async () => {
    // The stop has to sit after every refusal: losing a running toolkit to an
    // operation that was never going to run is pure damage.
    const { deps, launched } = harness()
    const toolkit = fakeToolkit({ alive: true })
    const result = await runOperation(
      { conversationId: "c1", operation: "update_db" },
      { ...deps, toolkit: toolkit.dep },
    )
    expect(result.ok).toBe(false)
    expect(toolkit.stops).toHaveLength(0)
    expect(launched).toHaveLength(0)
  })

  test("an unknown operation does not close the toolkit either", async () => {
    const { deps } = harness()
    const toolkit = fakeToolkit({ alive: true })
    await runOperation(
      { conversationId: "c1", operation: "rm -rf", permitted: true },
      { ...deps, toolkit: toolkit.dep },
    )
    expect(toolkit.stops).toHaveLength(0)
  })

  test("a session with no profile does not close the toolkit", async () => {
    const { deps } = harness({ binding: null })
    const toolkit = fakeToolkit({ alive: true })
    await runOperation({ conversationId: "c1", operation: "check" }, { ...deps, toolkit: toolkit.dep })
    expect(toolkit.stops).toHaveLength(0)
  })

  test("an unreachable health probe is not treated as a live session", async () => {
    // The guard prevents damage; failing to reach a port is not evidence of a
    // live session worth killing a legitimate operation over.
    const { deps, launched } = harness()
    const toolkit = fakeToolkit({ snapshotThrows: true })
    const result = await runOperation(
      { conversationId: "c1", operation: "check" },
      { ...deps, toolkit: toolkit.dep },
    )
    expect(toolkit.stops).toHaveLength(0)
    expect(launched).toHaveLength(1)
    expect(result.ok).toBe(true)
  })

  test("the executor still works with no toolkit wired at all", async () => {
    const { deps, launched } = harness()
    const result = await runOperation({ conversationId: "c1", operation: "check" }, deps)
    expect(result.ok).toBe(true)
    expect(result.ok && result.toolkitStopped).toBe(false)
    expect(launched).toHaveLength(1)
  })

  test("the caller is told even when the operation itself then fails", async () => {
    // Otherwise the agent loses the toolkit and is never told why its next
    // 1c_* call cannot reach the base.
    const { deps } = harness({ run: { exitCode: 1, timedOut: true } })
    const toolkit = fakeToolkit({ alive: true })
    const result = await runOperation(
      { conversationId: "c1", operation: "check" },
      { ...deps, toolkit: toolkit.dep },
    )
    expect(result.ok).toBe(false)
    expect(result.toolkitStopped).toBe(true)
  })
})

// 2026-09-25. A session diagnosing an error inside a vendor extension composed
// the right command itself -- `/DumpConfigToFiles <dir> -Extension EF_00_…` --
// was refused by the shell guard, redirected to `1c_dump_config_to_files`, which
// could only dump the MAIN configuration, and dumped 97 000 files of it for an
// answer that is not there: an extension's modules are not part of the
// configuration dump. The guard blocked the only route to the work.
describe("scoping a configurator command to an extension", () => {
  test("the dump that had no guarded route now has one", () => {
    expect(OPERATIONS.dump_config_to_files.args({ path: "C:\out", extension: "EF_00_00927613_4" })).toEqual([
      "/DumpConfigToFiles",
      '"C:\out"',
      "-Extension",
      "EF_00_00927613_4",
    ])
  })

  test("the modifier follows its command, before -update", () => {
    expect(
      OPERATIONS.dump_config_to_files.args({ path: "C:\out", extension: "Ext", update: true }),
    ).toEqual(["/DumpConfigToFiles", '"C:\out"', "-Extension", "Ext", "-update"])
  })

  test("loading and updating an extension carry it too", () => {
    expect(OPERATIONS.load_config.args({ path: "C:\p.cfe", extension: "Ext" })).toEqual([
      "/LoadCfg",
      '"C:\p.cfe"',
      "-Extension",
      "Ext",
    ])
    expect(OPERATIONS.update_db.args({ extension: "Ext" })).toEqual(["/UpdateDBCfg", "-Extension", "Ext"])
  })

  // Absent or blank means the main configuration, exactly as before.
  test("without it the command is unchanged", () => {
    expect(OPERATIONS.update_db.args({})).toEqual(["/UpdateDBCfg"])
    expect(OPERATIONS.update_db.args({ extension: "   " })).toEqual(["/UpdateDBCfg"])
    expect(OPERATIONS.load_config.args({ path: "C:\c.cf" })).toEqual(["/LoadCfg", '"C:\c.cf"'])
  })

  // The extension container was rejected by the path spec, which made the
  // guarded route unusable even once the modifier existed.
  test("a .cfe is an acceptable input for loading", () => {
    expect(pathSpec("load_config")?.extensions).toContain(".cfe")
    expect(pathSpec("load_config")?.extensions).toContain(".cf")
  })
})

// 2026-09-25. `extension` existed on the request type, on the tool, and in every
// operation's argument builder -- and the executor never passed it to buildArgs.
// Typecheck was clean (the field is optional) and 747 tests passed, because they
// all asserted `OPERATIONS.<id>.args(...)` rather than the path a tool call
// actually takes. Same shape as debrief8 §E7: three green checks, dead feature.
// This one goes through runOperation and reads the real command line.
describe("the extension scope reaches the platform", () => {
  test("runOperation puts -Extension on the command line", async () => {
    const { deps, launched } = harness()
    await runOperation(
      {
        conversationId: "c1",
        operation: "dump_config_to_files",
        path: "C:\out",
        extension: "EF_00_00927613_4",
      },
      deps,
    )
    expect(launched.length).toBe(1)
    const args = launched[0]!.args
    expect(args).toContain("-Extension")
    expect(args[args.indexOf("-Extension") + 1]).toBe("EF_00_00927613_4")
  })

  test("and leaves it off when the caller did not ask for one", async () => {
    const { deps, launched } = harness()
    await runOperation({ conversationId: "c1", operation: "dump_config_to_files", path: "C:\out" }, deps)
    expect(launched[0]!.args).not.toContain("-Extension")
  })
})

// 2026-10-13: toolkits are per profile now, so a configurator run on one base
// must not refuse another session's toolkit on another base.
describe("the configurator lock is per profile", () => {
  test("held for the run's own profile only, and released after", async () => {
    const { deps } = harness()
    const seen: boolean[] = []
    const verify = {
      ...deps.verify,
      runPlatform: async (exe: string, args: string[]) => {
        seen.push(designerBusy("p1"), designerBusy("other"), designerBusy())
        return deps.verify.runPlatform(exe, args)
      },
    }
    const result = await runOperation({ conversationId: "c1", operation: "check" }, { ...deps, verify })
    expect(result.ok).toBe(true)
    expect(seen).toEqual([true, false, true])
    expect([designerBusy("p1"), designerBusy()]).toEqual([false, false])
  })
})
