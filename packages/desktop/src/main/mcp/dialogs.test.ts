import { describe, expect, test } from "bun:test"

import { describeDialog, describeDialogs, dialogScript, isBlocking, parseDialogs } from "./dialogs"

// The probe's own output, as PowerShell's ConvertTo-Json prints it: a single
// object is not wrapped in an array, and an empty result prints nothing.
// Texts are real: a platform file error and a rights refusal, both captured
// from live 1C windows.
const FILE_ERROR = {
  pid: 19252,
  title: "1С:Предприятие",
  ownerEnabled: false,
  texts: [
    "К сожалению, возникла ошибка при работе с файлом\n\nКаталог не обнаружен 'C:\\nonexistent\\nothing.epf'.",
    "Сообщения:",
  ],
  buttons: ["OK", "Закрыть"],
}
const RIGHTS = {
  pid: 33948,
  title: "1С:Предприятие",
  ownerEnabled: false,
  texts: ["Текущему пользователю запрещен запуск внешних обработок.", "Сообщения:"],
  buttons: ["OK", "Закрыть"],
}

describe("reading the probe's output", () => {
  test("a single object is still a list, and nothing is no dialogs", () => {
    expect(parseDialogs(JSON.stringify(RIGHTS))).toHaveLength(1)
    expect(parseDialogs(JSON.stringify([RIGHTS, FILE_ERROR]))).toHaveLength(2)
    expect(parseDialogs("")).toEqual([])
    expect(parseDialogs("  \r\n")).toEqual([])
  })

  // A diagnosis must never become a failure of its own.
  test("output that is not JSON reads as no dialogs", () => {
    expect(parseDialogs("Add-Type : Cannot add type")).toEqual([])
  })

  test("a disabled owner is what makes a window modal", () => {
    const [modal] = parseDialogs(JSON.stringify(RIGHTS))
    const [popup] = parseDialogs(JSON.stringify({ ...RIGHTS, ownerEnabled: true }))
    expect(modal!.modal).toBe(true)
    expect(popup!.modal).toBe(false)
  })

  test("a window with neither text nor buttons is not reported", () => {
    expect(parseDialogs(JSON.stringify({ pid: 1, title: "", ownerEnabled: false, texts: [], buttons: [] }))).toEqual([])
  })

  test("one text or one button comes through as a list", () => {
    const [dialog] = parseDialogs(JSON.stringify({ pid: 1, title: "x", ownerEnabled: false, texts: "Один", buttons: "OK" }))
    expect(dialog).toMatchObject({ texts: ["Один"], buttons: ["OK"] })
  })

  test("a huge text is capped", () => {
    const [dialog] = parseDialogs(JSON.stringify({ ...RIGHTS, texts: ["я".repeat(5_000)] }))
    expect(dialog!.texts[0]!.length).toBeLessThan(1_600)
  })
})

describe("which dialogs block", () => {
  const [modal] = parseDialogs(JSON.stringify(RIGHTS))

  test("a modal window asking for an answer blocks", () => {
    expect(isBlocking(modal!)).toBe(true)
  })

  // The splash screen has no buttons; a notification popup leaves its owner enabled.
  test("a modal without buttons, or a window beside an enabled owner, does not", () => {
    expect(isBlocking({ ...modal!, buttons: [] })).toBe(false)
    expect(isBlocking({ ...modal!, modal: false })).toBe(false)
  })
})

describe("what the agent is shown", () => {
  test("the message itself, the process, and the buttons", () => {
    const text = describeDialog(parseDialogs(JSON.stringify(RIGHTS))[0]!)
    expect(text).toContain("Текущему пользователю запрещен запуск внешних обработок.")
    expect(text).toContain("PID 33948")
    expect(text).toContain("модальное")
    expect(text).toContain("Кнопки: OK, Закрыть")
  })

  test("a multi-line message stays on one line", () => {
    const text = describeDialog(parseDialogs(JSON.stringify(FILE_ERROR))[0]!)
    expect(text).toContain("работе с файлом Каталог не обнаружен")
  })

  test("several dialogs are all listed", () => {
    const text = describeDialogs(parseDialogs(JSON.stringify([RIGHTS, FILE_ERROR])))
    expect(text).toContain("PID 33948")
    expect(text).toContain("PID 19252")
  })
})

describe("the probe script", () => {
  test("carries only well-formed process ids", () => {
    const script = dialogScript([12, -1, 3.5, 40])
    expect(script.split("\n")[0]).toBe("$Pids = '12,40'")
  })

  test("with no ids it looks at every 1C process", () => {
    expect(dialogScript([]).split("\n")[0]).toBe("$Pids = ''")
    expect(dialogScript([])).toContain("Name like '1cv8%'")
  })

  // Read-only by construction: nothing in it may click, close or focus.
  test("never acts on a window", () => {
    const script = dialogScript([1])
    for (const verb of ["SetForegroundWindow", "PostMessage", "SendMessage", "InvokePattern", "Stop-Process"]) {
      expect(script).not.toContain(verb)
    }
  })
})
