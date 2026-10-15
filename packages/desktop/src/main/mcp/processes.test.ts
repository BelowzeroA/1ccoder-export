import { describe, expect, test } from "bun:test"

import { closable, closeDialog, describeProcesses, opensInfobase, parseProcessList, roleOf } from "./processes"

// failures_to_tools.md T5.

const SELF = 4242

const listing = JSON.stringify([
  {
    pid: 100,
    parent: SELF,
    cmd: String.raw`"C:\Program Files\1cv8\bin\1cv8.exe" ENTERPRISE /F"C:\Bases\acc" /Execute "C:\t\MCP_Toolkit.epf" /C"port=6003"`,
    started: "2026-01-01T10:00:00",
    title: "Тулкит",
  },
  {
    pid: 200,
    parent: SELF,
    // Not String.raw: bun's transpiler rewrites Cyrillic in a raw template as
    // \uXXXX escapes, and the raw string then carries the escape text.
    cmd: '"C:\\Program Files\\1cv8\\bin\\1cv8.exe" ENTERPRISE /F"C:\\Bases\\acc" /Execute "C:\\w\\Деактивация.epf"',
    title: "Деактивация остатков",
  },
  { pid: 300, parent: 1, cmd: String.raw`1cv8.exe ENTERPRISE /F"C:\Bases\acc"`, title: "[КОПИЯ] База" },
  { pid: 400, parent: SELF, cmd: String.raw`1cv8.exe DESIGNER /F"C:\Bases\other" /DumpCfg x.cf`, title: "" },
])

describe("the 1C processes on this infobase", () => {
  const profile = { kind: "file" as const, filePath: "C:/Bases/acc/" }
  const ours = parseProcessList(listing).filter((process) => opensInfobase(process.commandLine, profile))

  test("only processes on the profile's base are listed", () => {
    expect(ours.map((process) => process.pid)).toEqual([100, 200, 300])
  })

  test("a single object from ConvertTo-Json is still a list", () => {
    expect(parseProcessList(JSON.stringify({ pid: 5, parent: 1, cmd: "1cv8.exe" }))).toHaveLength(1)
    expect(parseProcessList("")).toEqual([])
  })

  test("each is labelled by who started it and what it runs", () => {
    expect(ours.map((process) => roleOf(process, SELF))).toEqual(["toolkit", "operation", "user"])
    const text = describeProcesses(ours, SELF)
    expect(text).toContain("Деактивация.epf")
    expect(text).toContain("открыт пользователем")
  })

  test("the user's own 1C is never closable; ours are", () => {
    expect(closable(ours, 300, SELF)).toMatchObject({ ok: false, reason: "not-ours" })
    expect(closable(ours, 200, SELF)).toEqual({ ok: true, role: "operation" })
    expect(closable(ours, 100, SELF)).toEqual({ ok: true, role: "toolkit" })
    // On another base: not in this list at all.
    expect(closable(ours, 400, SELF)).toMatchObject({ ok: false, reason: "not-found" })
  })

  // debrief15.md §15.2: the startup window that blocked the toolkit, as the probe read it.
  describe("closing a blocking window (1c_close_dialog)", () => {
    const window = {
      pid: 100,
      title: "",
      texts: ["Интернет-поддержка пользователей", "Подключитесь к Интернет-поддержке пользователей для работы с сервисами 1С."],
      buttons: ["Меню", "Развернуть", "Закрыть", "Подключить"],
      modal: false,
    }
    function deps(open: boolean[]) {
      const pressed: { pid: number; button: string }[] = []
      return {
        pressed,
        deps: {
          selfPid: SELF,
          dialogs: async () => (open.shift() ? [window] : []),
          press: async (pid: number, button: string) => {
            pressed.push({ pid, button })
            return { pressed: true, how: "wm_close", title: "", error: "" }
          },
        },
      }
    }

    test("presses the named button in a window of a process the app started, and says the session is free", async () => {
      const { deps: d, pressed } = deps([true, false])
      const outcome = await closeDialog(ours, 100, "закрыть", d, 0)
      expect(pressed).toEqual([{ pid: 100, button: "закрыть" }])
      expect(outcome).toMatchObject({ ok: true })
      expect(outcome.ok && outcome.text).toContain("Интернет-поддержка пользователей")
      expect(outcome.ok && outcome.text).toContain("сеанс свободен")
    })

    test("never in the user's own 1C", async () => {
      const { deps: d, pressed } = deps([true])
      expect(await closeDialog(ours, 300, "Закрыть", d, 0)).toMatchObject({ ok: false, reason: "not-ours" })
      expect(pressed).toEqual([])
    })

    test("a button the window doesn't have is not pressed, and the windows are shown", async () => {
      const { deps: d, pressed } = deps([true])
      const outcome = await closeDialog(ours, 100, "ОК", d, 0)
      expect(outcome).toMatchObject({ ok: false, reason: "no-button" })
      expect(outcome.ok ? "" : outcome.detail).toContain("Подключить")
      expect(pressed).toEqual([])
    })

    // debrief18.md: a security question that returned after every press was
    // reported as pressed 20+ times.
    test("a window still there after the press is not reported as pressed; the second time says stop", async () => {
      const { deps: d } = deps([true, true, true, true])
      const first = await closeDialog(ours, 100, "Закрыть", d, 0)
      expect(first).toMatchObject({ ok: false, reason: "still-open" })
      expect(first.ok ? "" : first.detail).toContain("окно осталось или появилось снова")
      const second = await closeDialog(ours, 100, "Закрыть", d, 0)
      expect(second.ok ? "" : second.detail).toContain("Больше не нажимай")
    })

    test("the guidance says to close it, not to restart or change settings", () => {
      const text = describeProcesses(ours, SELF, [window])
      expect(text).toContain("1c_close_dialog")
      expect(text).toContain("не меняй и настройки")
    })
  })

  test("a server base is matched by its database name", () => {
    expect(
      opensInfobase(String.raw`1cv8.exe ENTERPRISE /S"srv\buh"`, { kind: "server", serverCluster: "srv", serverDatabase: "buh" }),
    ).toBe(true)
    expect(
      opensInfobase(String.raw`1cv8.exe ENTERPRISE /S"srv\buh2"`, { kind: "server", serverCluster: "srv", serverDatabase: "buh" }),
    ).toBe(false)
  })

  test("a file base is not confused with one whose path it prefixes", () => {
    expect(opensInfobase(String.raw`1cv8.exe ENTERPRISE /F"C:\Bases\acc2"`, profile)).toBe(false)
    expect(opensInfobase(String.raw`1cv8.exe ENTERPRISE /F"C:\Bases\acc\"`, profile)).toBe(true)
  })

  // 2026-09-27, tasks/task8: the main window's title looked normal while a
  // modal on top of it held the session.
  test("a dialog on one of these processes is shown with its text; others are not", () => {
    const dialog = (pid: number) => ({ pid, title: "1С:Предприятие", texts: [`Окно ${pid}`], buttons: ["OK"], modal: true })
    const text = describeProcesses(ours, SELF, [dialog(300), dialog(400)])
    expect(text).toContain("Окно 300")
    // 400 is on another base: not this session's business.
    expect(text).not.toContain("Окно 400")
    expect(describeProcesses(ours, SELF)).not.toContain("диалог")
  })
})
