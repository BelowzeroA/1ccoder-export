import { describe, expect, mock, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"

import type { PlatformDialog } from "./dialogs"
import type { PortState, SupervisorDeps } from "./supervisor"
import type { ProtectionOutcome } from "./unsafe-protection"

// supervisor.ts logs, and logging.ts pulls in electron at module load, which a
// bun test process has no business starting. Only the one function is needed.
const logged: string[] = []
mock.module("../logging", () => ({ write: (_scope: string, message: string) => void logged.push(message) }))

const { DIALOG_FIRST_CHECK_MS, MAX_TOOLKITS, START_TIMEOUT_MS, ToolkitSupervisor } = await import("./supervisor")

const PROFILE = {
  kind: "file" as const,
  filePath: "C:\\Bases\\Acc",
  workingDirectory: "C:\\Work\\Acc\\stage",
  userName: "Администратор",
  platformPath: "C:\\Program Files\\1cv8\\bin\\1cv8.exe",
}

function fakeChild(): ChildProcess {
  return { on() {}, kill() {} } as unknown as ChildProcess
}

function deps(states: PortState[]) {
  const spawned: string[][] = []
  let call = 0
  const supervisor = new ToolkitSupervisor({
    profile: () => PROFILE,
    password: () => "",
    configDir: "C:\\config",
    fileExists: async () => true,
    probeHealth: async () => states[Math.min(call++, states.length - 1)]!,
    spawn: (_exe, args) => {
      spawned.push(args)
      return fakeChild()
    },
    sleep: async () => {},
  } satisfies SupervisorDeps)
  return { supervisor, spawned }
}

// The failure being closed here: the app started a second 1C while the user's
// own toolkit was already serving port 6003. Every branch below is about never
// letting that happen again.
describe("a port that is not provably empty is never launched over", () => {
  test("an answering toolkit is refused, not duplicated", async () => {
    const { supervisor, spawned } = deps(["up"])
    const status = await supervisor.ensure("p1")
    expect(status.state).toBe("failed")
    expect(status).toMatchObject({ reason: "port-taken" })
    expect(spawned).toHaveLength(0)
  })

  // The one that actually bit: a 1C client stuck on a modal dialog holds the
  // port open and answers nothing. That silence used to read as "free".
  test("a silent but open port is refused too", async () => {
    const { supervisor, spawned } = deps(["busy"])
    const status = await supervisor.ensure("p1")
    expect(status).toMatchObject({ reason: "port-taken" })
    expect(spawned).toHaveLength(0)
  })

  test("the refusal says which of the two it was", async () => {
    const answering = await deps(["up"]).supervisor.ensure("p1")
    const silent = await deps(["busy"]).supervisor.ensure("p1")
    expect((answering as { detail?: string }).detail).toContain("отвечает")
    expect((silent as { detail?: string }).detail).toContain("не отвечает")
  })

  test("only a refused connection authorises a launch", async () => {
    const { supervisor, spawned } = deps(["free", "up"])
    const status = await supervisor.ensure("p1")
    expect(status.state).toBe("running")
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.join(" ")).toContain("startup;mode=embedded;port=6003")
  })
})

describe("a toolkit we started", () => {
  test("is not restarted while it is merely busy", async () => {
    // free -> launch, up -> ready, busy -> the window is there, just occupied.
    const { supervisor, spawned } = deps(["free", "up", "busy"])
    expect((await supervisor.ensure("p1")).state).toBe("running")
    expect((await supervisor.ensure("p1")).state).toBe("running")
    expect(spawned).toHaveLength(1)
  })

  // free -> launch, up -> ready, free -> the window is gone, free -> the
  // relaunch re-checks the port before spawning, up -> ready again.
  test("is given up on and relaunched once the port refuses", async () => {
    const { supervisor, spawned } = deps(["free", "up", "free", "free", "up"])
    expect((await supervisor.ensure("p1")).state).toBe("running")
    expect((await supervisor.ensure("p1")).state).toBe("running")
    expect(spawned).toHaveLength(2)
  })
})

describe("health", () => {
  test("is true only when the server actually answers", async () => {
    expect(await deps(["up"]).supervisor.health()).toBe(true)
    expect(await deps(["busy"]).supervisor.health()).toBe(false)
    expect(await deps(["free"]).supervisor.health()).toBe(false)
  })
})

// 2026-09-21, debrief5.md §8.4. The supervisor logged the stops it performed
// and nothing else, so a toolkit that died on its own left `state: "running"`
// behind indefinitely. On 2026-09-20 it was gone by 17:33 with no entry in
// mcp.log and the status still reading `running`, and the agent met that three
// separate times as a bare `fetch failed` from MCP tools this process does not
// sit in the path of. It cannot fix those tools' error text; it can stop the
// app asserting something false about them.
describe("a toolkit that dies on its own is noticed", () => {
  // A mutable port state rather than a scripted sequence: the point of these
  // tests is what happens AFTER a successful start, and the number of probes a
  // start consumes is an implementation detail that should not be encoded here.
  function live() {
    let state: PortState = "free"
    const supervisor = new ToolkitSupervisor({
      profile: () => PROFILE,
      password: () => "",
      configDir: "C:\\config",
      fileExists: async () => true,
      probeHealth: async () => state,
      spawn: () => {
        // The launch is what makes the port answer, so flip it here.
        state = "up"
        return fakeChild()
      },
      sleep: async () => {},
    } satisfies SupervisorDeps)
    return { supervisor, kill: () => (state = "free"), busy: () => (state = "busy") }
  }

  // A 1C client serves one request at a time, so a toolkit inside a long call
  // leaves the port open and silent. That is not a death, and recording one
  // would invite a second launch beside a live toolkit.
  test("a busy port is not recorded as a death", async () => {
    const { supervisor, busy } = live()
    await supervisor.ensure("p1")
    busy()
    expect(await supervisor.observeHealth()).toBe(false)
    expect(supervisor.current().state).toBe("running")
  })

  test("running plus a silent port becomes died, not running", async () => {
    const { supervisor, kill } = live()
    await supervisor.ensure("p1")
    expect(supervisor.current().state).toBe("running")

    kill()
    expect(await supervisor.observeHealth()).toBe(false)

    const status = supervisor.current()
    expect(status.state).toBe("died")
    expect(status).toMatchObject({ profileId: "p1" })
  })

  test("an answering toolkit is left alone", async () => {
    const { supervisor } = live()
    await supervisor.ensure("p1")
    expect(await supervisor.observeHealth()).toBe(true)
    expect(supervisor.current().state).toBe("running")
  })

  // "stopped" and "failed" are already honest about not serving; only a claim
  // of `running` can be contradicted by a silent port.
  test("a state that never claimed to be up is not rewritten", async () => {
    const { supervisor } = live()
    expect(supervisor.current().state).toBe("stopped")
    expect(await supervisor.observeHealth()).toBe(false)
    expect(supervisor.current().state).toBe("stopped")
  })
})

// 2026-09-27, tasks/task8. A launch on a base whose user may not open external
// processings: the 1C window came up, a modal refused to run the toolkit, and
// the supervisor waited out the whole timeout and reported "timeout" -- while
// the reason sat on screen. These tests pin the three things that changed: the
// dialog is read and reported as the reason, the wait ends when it is found,
// and a retry waits on the same 1C instead of opening a second one.
describe("a dialog blocking the launch", () => {
  const RIGHTS: PlatformDialog = {
    pid: 777,
    title: "1С:Предприятие",
    texts: ["Текущему пользователю запрещен запуск внешних обработок."],
    buttons: ["OK"],
    modal: true,
  }

  /**
   * A clock that moves a second per look, a port in whatever state the test
   * sets, and a probe that returns whatever dialogs the test puts on screen.
   */
  function blocked(onScreen: PlatformDialog[]) {
    let clock = 0
    let state: PortState = "free"
    const probed: (readonly number[])[] = []
    const spawned: string[][] = []
    const supervisor = new ToolkitSupervisor({
      profile: () => PROFILE,
      password: () => "",
      configDir: "C:\\config",
      fileExists: async () => true,
      probeHealth: async () => state,
      spawn: (_exe, args) => {
        spawned.push(args)
        state = "busy"
        return { on() {}, kill() {}, pid: 777 } as unknown as ChildProcess
      },
      sleep: async () => {},
      now: () => (clock += 1_000),
      dialogs: async (pids) => {
        probed.push(pids)
        return onScreen
      },
    } satisfies SupervisorDeps)
    return {
      supervisor,
      spawned,
      probed,
      setPort: (next: PortState) => (state = next),
      elapsed: () => clock,
      screen: onScreen,
    }
  }

  test("is reported as the reason, with the window's own text", async () => {
    const { supervisor, spawned } = blocked([RIGHTS])
    const status = await supervisor.ensure("p1")
    expect(status).toMatchObject({ state: "failed", reason: "dialog" })
    expect((status as { detail?: string }).detail).toContain("запрещен запуск внешних обработок")
    expect(spawned).toHaveLength(1)
  })

  test("ends the wait instead of running out the timeout", async () => {
    const { supervisor, elapsed } = blocked([RIGHTS])
    await supervisor.ensure("p1")
    expect(elapsed()).toBeLessThan(START_TIMEOUT_MS / 2)
  })

  // The splash screen and the platform's startup windows come and go; judging
  // them in the first seconds would fail launches that were about to succeed.
  test("is not looked for in the first seconds, and only in the launched process", async () => {
    const { supervisor, probed, elapsed } = blocked([RIGHTS])
    await supervisor.ensure("p1")
    expect(probed).toEqual([[777]])
    expect(elapsed()).toBeGreaterThanOrEqual(DIALOG_FIRST_CHECK_MS)
  })

  test("a retry waits on the same 1C rather than opening a second", async () => {
    const run = blocked([RIGHTS])
    await run.supervisor.ensure("p1")
    // The user answered the window; the toolkit comes up.
    run.screen.length = 0
    run.setPort("up")
    expect((await run.supervisor.ensure("p1")).state).toBe("running")
    expect(run.spawned).toHaveLength(1)
  })

  test("a non-modal window does not end the wait, but is named when it times out", async () => {
    const run = blocked([{ ...RIGHTS, modal: false, texts: ["Напоминание"] }])
    const status = await run.supervisor.ensure("p1")
    expect(status).toMatchObject({ reason: "timeout" })
    expect((status as { detail?: string }).detail).toContain("Напоминание")
  })

  test("without a probe, a blocked start is the bare timeout it always was", async () => {
    let clock = 0
    // Free before the launch (a silent port then would be port-taken), silent after.
    let launched = false
    const supervisor = new ToolkitSupervisor({
      profile: () => PROFILE,
      password: () => "",
      configDir: "C:\\config",
      fileExists: async () => true,
      probeHealth: async () => (launched ? "busy" : "free"),
      spawn: () => {
        launched = true
        return { on() {}, kill() {}, pid: 777 } as unknown as ChildProcess
      },
      sleep: async () => {},
      now: () => (clock += 1_000),
    } satisfies SupervisorDeps)
    const status = await supervisor.ensure("p1")
    expect(status).toMatchObject({ reason: "timeout" })
    expect((status as { detail?: string }).detail).toBeUndefined()
  })

  test("a silent port before any launch names the modal holding it", async () => {
    const run = blocked([RIGHTS])
    run.setPort("busy")
    const status = await run.supervisor.ensure("p1")
    expect(status).toMatchObject({ reason: "port-taken" })
    expect((status as { detail?: string }).detail).toContain("запрещен запуск внешних обработок")
    expect(run.spawned).toHaveLength(0)
    // Who holds the port is unknown, so every 1C is looked at.
    expect(run.probed[0]).toEqual([])
  })
})

// debrief15.md §15.15: toolkits that closed themselves five minutes after every
// start were forgotten without a line in the log, and the agent read the silence
// as a start that never happened.
describe("a toolkit that ends on its own", () => {
  /** `exitsAfterMs`: the process ends on its own that long after the launch, before answering. */
  function run(states: PortState[], exitsAfterMs?: number) {
    const children: EventEmitter[] = []
    let clock = 1_000_000
    let call = 0
    const supervisor = new ToolkitSupervisor({
      profile: () => PROFILE,
      password: () => "",
      configDir: "C:\\config",
      fileExists: async () => true,
      probeHealth: async () => states[Math.min(call++, states.length - 1)]!,
      spawn: () => {
        const child = Object.assign(new EventEmitter(), { kill() {}, pid: 4242 })
        children.push(child)
        // After the supervisor has attached its listener, before its first poll.
        if (exitsAfterMs !== undefined) {
          queueMicrotask(() => {
            clock += exitsAfterMs
            child.emit("close", 1, null)
          })
        }
        return child as unknown as ChildProcess
      },
      // Time passes while the start waits, so a start that misses the exit
      // runs into its timeout rather than spinning forever.
      sleep: async (ms) => void (clock += ms),
      now: () => clock,
    } satisfies SupervisorDeps)
    return { supervisor, children, advance: (ms: number) => (clock += ms) }
  }

  test("is recorded as died, with its exit code and lifetime, and logged", async () => {
    const { supervisor, children, advance } = run(["free", "up"])
    expect((await supervisor.ensure("p1")).state).toBe("running")
    logged.length = 0
    advance(317_000)
    children[0]!.emit("close", 1, null)
    expect(supervisor.current()).toMatchObject({ state: "died", exit: { code: 1, signal: null, lifetimeMs: 317_000 } })
    expect(logged).toContain("toolkit exited on its own")
  })

  test("a stop the app asked for is not one", async () => {
    const { supervisor, children } = run(["free", "up"])
    await supervisor.ensure("p1")
    logged.length = 0
    await supervisor.stop()
    children[0]!.emit("close", null, "SIGTERM")
    expect(supervisor.current().state).toBe("stopped")
    expect(logged).not.toContain("toolkit exited on its own")
  })

  test("before it ever answered, the start fails at once instead of waiting out the timeout", async () => {
    const { supervisor } = run(["free", "busy"], 9_000)
    const status = await supervisor.ensure("p1")
    expect(status).toMatchObject({ state: "failed", reason: "launch-failed" })
    expect((status as { detail?: string }).detail).toContain("завершился через 9 с")
  })
})

// A fresh install has no copy anywhere the user would put one; the one the
// installer ships is what runs, and only then.
describe("the bundled toolkit", () => {
  const BUNDLED = "C:\\Program Files\\1CCoder\\resources\\toolkit\\MCP_Toolkit.epf"

  function withFiles(present: string[]) {
    const spawned: string[][] = []
    const supervisor = new ToolkitSupervisor({
      profile: () => PROFILE,
      password: () => "",
      configDir: "C:\\config",
      bundledToolkit: BUNDLED,
      fileExists: async (path) => present.includes(path),
      probeHealth: async () => (spawned.length ? "up" : "free"),
      spawn: (_exe, args) => {
        spawned.push(args)
        return fakeChild()
      },
      sleep: async () => {},
    } satisfies SupervisorDeps)
    return { supervisor, spawned }
  }

  test("starts when no other copy exists", async () => {
    const { supervisor, spawned } = withFiles([BUNDLED])
    expect((await supervisor.ensure("p1")).state).toBe("running")
    expect(spawned[0]).toContain(`"${BUNDLED}"`)
  })

  test("yields to a copy the user put in the config directory", async () => {
    const own = "C:\\config\\1ccoder-mcp\\MCP_Toolkit.epf"
    const { supervisor, spawned } = withFiles([own, BUNDLED])
    await supervisor.ensure("p1")
    expect(spawned[0]).toContain(`"${own}"`)
  })
})

// 2026-10-06, SERVER_ST: the toolkit's 1C sat maximized over half the screen
// for the whole session. It is moved aside once it serves -- and only then,
// because before that its window may be asking the user something.
describe("the toolkit's window", () => {
  function launch(answers: PortState[], park = mock(async (_pids: readonly number[]) => ["Организация"])) {
    let call = 0
    const supervisor = new ToolkitSupervisor({
      profile: () => PROFILE,
      password: () => "",
      configDir: "C:\config",
      fileExists: async () => true,
      probeHealth: async () => answers[Math.min(call++, answers.length - 1)]!,
      spawn: () => ({ on() {}, kill() {}, pid: 777 }) as unknown as ChildProcess,
      sleep: async () => {},
      park,
    } satisfies SupervisorDeps)
    return { supervisor, park }
  }

  test("is moved aside once the toolkit answers, for the launched process only", async () => {
    const { supervisor, park } = launch(["free", "up"])
    expect((await supervisor.ensure("p1")).state).toBe("running")
    expect(park.mock.calls).toEqual([[[777]]])
  })

  test("is left alone when the start fails", async () => {
    let clock = 0
    const park = mock(async () => [])
    const supervisor = new ToolkitSupervisor({
      profile: () => PROFILE,
      password: () => "",
      configDir: "C:\config",
      fileExists: async () => true,
      probeHealth: async () => (clock === 0 ? "free" : "busy"),
      spawn: () => ({ on() {}, kill() {}, pid: 777 }) as unknown as ChildProcess,
      sleep: async () => {},
      now: () => (clock += 10_000),
      park,
    } satisfies SupervisorDeps)
    expect((await supervisor.ensure("p1")).state).toBe("failed")
    expect(park).not.toHaveBeenCalled()
  })

  test("a toolkit the app did not start is not touched", async () => {
    const { supervisor, park } = launch(["up"])
    await supervisor.ensure("p1")
    expect(park).not.toHaveBeenCalled()
  })

  test("a failure to move it does not fail the start", async () => {
    const { supervisor } = launch(["free", "up"], mock(async () => Promise.reject(new Error("no powershell"))))
    expect((await supervisor.ensure("p1")).state).toBe("running")
  })
})

// 2026-10-13, debrief18.md. With the user's «Защита от опасных действий» on,
// the platform asked «Разрешить открывать данный файл?» on every toolkit launch.
describe("unsafe-action protection", () => {
  const QUESTION: PlatformDialog = {
    pid: 777,
    title: "1С:Предприятие",
    texts: ["Предупреждение безопасности. Разрешить открывать данный файл?"],
    buttons: ["Да", "Нет"],
    modal: true,
  }

  function guarded(outcome: ProtectionOutcome, onScreen: PlatformDialog[] = []) {
    let clock = 0
    let state: PortState = "free"
    const order: string[] = []
    const supervisor = new ToolkitSupervisor({
      profile: () => PROFILE,
      password: () => "",
      configDir: "C:\config",
      fileExists: async () => true,
      probeHealth: async () => state,
      spawn: () => {
        order.push("spawn")
        state = onScreen.length ? "busy" : "up"
        return { on() {}, kill() {}, pid: 777 } as unknown as ChildProcess
      },
      sleep: async () => {},
      now: () => (clock += 1_000),
      dialogs: async () => onScreen,
      unsafeProtection: async (input) => {
        order.push(`check ${input.profile.userName}`)
        return outcome
      },
    } satisfies SupervisorDeps)
    return { supervisor, order, kill: () => (state = "free") }
  }

  test("is checked before the launch, and once per profile", async () => {
    const run = guarded({ state: "turned-off", detail: "Администратор" })
    expect((await run.supervisor.ensure("p1")).state).toBe("running")
    run.kill()
    await run.supervisor.ensure("p1")
    expect(run.order).toEqual(["check Администратор", "spawn", "spawn"])
  })

  test("a flag it could not clear is named next to the platform's question", async () => {
    const status = await guarded({ state: "no-rights" }, [QUESTION]).supervisor.ensure("p1")
    expect(status).toMatchObject({ state: "failed", reason: "dialog" })
    const detail = (status as { detail?: string }).detail ?? ""
    expect(detail).toContain("Разрешить открывать данный файл?")
    expect(detail).toContain("«Защита от опасных действий»")
    expect(detail).toContain("нет права «Администрирование»")
  })

  test("a cleared flag adds nothing to a dialog's report", async () => {
    const status = await guarded({ state: "off" }, [QUESTION]).supervisor.ensure("p1")
    expect((status as { detail?: string }).detail).not.toContain("Защита от опасных действий")
  })
})

// 2026-10-13: one port for every profile made two sessions on different bases
// stop each other's toolkit whenever either touched its base -- eight
// handovers in ninety minutes, each 40-70 s of 1C startup.
describe("toolkits for different profiles run side by side", () => {
  // Each profile on its own port; launching on a port makes it answer, and
  // killing the child closes it again.
  function several(options: { now?: () => number; portFor?: (id: string) => number } = {}) {
    const ports: Record<string, number> = { a: 7001, b: 7002, c: 7003, d: 7004 }
    const states = new Map<number, PortState>()
    const killed: number[] = []
    const supervisor = new ToolkitSupervisor({
      portFor: options.portFor ?? ((id) => ports[id]!),
      profile: () => PROFILE,
      password: () => "",
      configDir: "C:\config",
      fileExists: async () => true,
      probeHealth: async (port) => states.get(port) ?? "free",
      spawn: (_exe, args) => {
        const port = Number(/port=(\d+)/.exec(args.join(" "))![1])
        states.set(port, "up")
        return {
          on() {},
          kill() {
            killed.push(port)
            states.set(port, "free")
          },
        } as unknown as ChildProcess
      },
      sleep: async () => {},
      ...(options.now ? { now: options.now } : {}),
    } satisfies SupervisorDeps)
    return { supervisor, states, killed }
  }

  test("starting one profile's toolkit leaves the other's running", async () => {
    const { supervisor, killed } = several()
    expect(await supervisor.ensure("a")).toMatchObject({ state: "running", port: 7001 })
    expect(await supervisor.ensure("b")).toMatchObject({ state: "running", port: 7002 })
    expect(killed).toEqual([])
    expect(supervisor.current("a").state).toBe("running")
    expect(supervisor.current("b").state).toBe("running")
    expect([supervisor.owner(7001), supervisor.owner(7002)]).toEqual(["a", "b"])
  })

  test("each profile's health is its own port's", async () => {
    const { supervisor, states } = several()
    await supervisor.ensure("a")
    await supervisor.ensure("b")
    states.set(7001, "free")
    expect(await supervisor.observeHealth("a")).toBe(false)
    expect(supervisor.current("a").state).toBe("died")
    expect(await supervisor.observeHealth("b")).toBe(true)
    expect(supervisor.current("b").state).toBe("running")
  })

  test("stopping one profile stops only its toolkit; no profile stops all", async () => {
    const { supervisor, killed } = several()
    await supervisor.ensure("a")
    await supervisor.ensure("b")
    await supervisor.stop("a")
    expect(killed).toEqual([7001])
    expect(supervisor.current("b").state).toBe("running")
    await supervisor.stop()
    expect(killed).toEqual([7001, 7002])
  })

  test(`past ${MAX_TOOLKITS} running, the least recently used one makes room`, async () => {
    let clock = 0
    const { supervisor, killed } = several({ now: () => clock })
    for (const id of ["a", "b", "c"]) {
      clock += 10
      await supervisor.ensure(id)
    }
    clock += 10
    await supervisor.ensure("a") // a used again: b is now the oldest
    clock += 10
    expect((await supervisor.ensure("d")).state).toBe("running")
    expect(killed).toEqual([7002])
    expect(supervisor.current("b").state).toBe("stopped")
  })

  test("two profiles that share a port still hand it over, as before", async () => {
    const { supervisor: shared, killed } = several({ portFor: () => 7001 })
    await shared.ensure("a")
    expect((await shared.ensure("b")).state).toBe("running")
    expect(killed).toEqual([7001])
    expect(shared.owner(7001)).toBe("b")
  })
})
