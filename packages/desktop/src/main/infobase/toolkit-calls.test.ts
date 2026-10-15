import { describe, expect, test } from "bun:test"

import {
  appendToResult,
  describeExit,
  executeCodeUnavailable,
  gateRefusal,
  isFailure,
  isToolkitTool,
  maskedNote,
  maskedTokenRefusal,
  referenceHint,
  RepeatedFailures,
  resultText,
} from "./toolkit-calls"
import { EXPECTED_PLUGIN_TOOLS } from "./registration"
import { InfobasePlugin } from "./plugin"

// failures_to_tools.md G5 and G8. The toolkit's own tools are the one part of
// the agent's reach the app cannot change the text of; these are the facts
// the plugin can put around them.

const mcpResult = (text: string, isError = false) => ({ content: [{ type: "text", text }], isError })

describe("which tools are the toolkit's", () => {
  test("toolkit tools are, the plugin's own are not", () => {
    expect(isToolkitTool("1c_execute_code", EXPECTED_PLUGIN_TOOLS)).toBe(true)
    expect(isToolkitTool("1c_get_metadata", EXPECTED_PLUGIN_TOOLS)).toBe(true)
    expect(isToolkitTool("1c_write_code", EXPECTED_PLUGIN_TOOLS)).toBe(false)
    expect(isToolkitTool("1c_toolkit_start", EXPECTED_PLUGIN_TOOLS)).toBe(false)
    expect(isToolkitTool("bash", EXPECTED_PLUGIN_TOOLS)).toBe(false)
  })
})

describe("the gate before a toolkit call (G5)", () => {
  test("a refused port says the toolkit is not running, and what to call", () => {
    const refusal = gateRefusal({ designerBusy: false, port: "free", state: "died" })
    expect(refusal).toContain("1c_toolkit_start")
    expect(refusal).toContain("fetch failed")
  })

  test("a configurator run holding the base is named as the cause", () => {
    expect(gateRefusal({ designerBusy: true, port: "free", state: "stopped" })).toContain("конфигуратора")
  })

  // A busy toolkit may be finishing another request; its own answer is better
  // evidence than a guess from outside.
  test("a busy or answering port lets the call through", () => {
    expect(gateRefusal({ designerBusy: false, port: "busy", state: "running" })).toBeNull()
    expect(gateRefusal({ designerBusy: false, port: "up", state: "running" })).toBeNull()
  })

  // Two sessions with different profiles in one folder share the folder's one
  // MCP client; the call would reach the other profile's base.
  test("a folder linked to another profile's toolkit refuses, even with the port answering", () => {
    const refusal = gateRefusal({ designerBusy: false, port: "up", state: "running", linkedTo: "КА 2 (демо)" })
    expect(refusal).toContain("«КА 2 (демо)»")
    expect(refusal).toContain("свой рабочий каталог")
  })
})

// debrief15.md §15.15: a toolkit that closed itself read as one that never started.
describe("a toolkit's own exit, told to the agent", () => {
  const EXIT = { code: 1, signal: null, lifetimeMs: 317_400 }

  test("says it ended by itself, and after how long", () => {
    const text = describeExit(EXIT)
    expect(text).toContain("завершился сам через 5 мин 17 с")
    expect(text).toContain("код 1")
    expect(text).toContain("не закрывали")
  })

  test("the gate before a toolkit call carries it", () => {
    expect(gateRefusal({ designerBusy: false, port: "free", state: "died", exit: EXIT })).toContain("5 мин 17 с")
    expect(gateRefusal({ designerBusy: false, port: "free", state: "died" })).not.toContain("завершился сам")
  })
})

// debrief15.md §15.14 item 6, §15.18: `1c_write_code` sent the agent, three
// times in one run, to a tool that had left its list with the toolkit.
describe("where 1c_write_code sends the agent when 1c_execute_code is gone", () => {
  test("a dead port: says the tool is not in the list, and to start the toolkit", () => {
    const text = executeCodeUnavailable({ designerBusy: false, port: "free", state: "died" })!
    expect(text).toContain("нет в твоём списке")
    expect(text).toContain("1c_toolkit_start")
    expect(text).toContain("Повторный вызов 1c_write_code")
  })

  test("with the exit, when the toolkit ended on its own", () => {
    const text = executeCodeUnavailable({
      designerBusy: false,
      port: "free",
      state: "died",
      exit: { code: 1, signal: null, lifetimeMs: 320_000 },
    })!
    expect(text).toContain("завершился сам через 5 мин 20 с")
  })

  test("a configurator run: wait for it, then start", () => {
    expect(executeCodeUnavailable({ designerBusy: true, port: "free", state: "stopped" })).toContain("конфигуратора")
  })

  test("a live or busy toolkit, or no answer from the app: nothing to add", () => {
    expect(executeCodeUnavailable({ designerBusy: false, port: "up", state: "running" })).toBeNull()
    expect(executeCodeUnavailable({ designerBusy: false, port: "busy", state: "running" })).toBeNull()
    expect(executeCodeUnavailable(undefined)).toBeNull()
  })
})

describe("reading and extending a tool result", () => {
  test("both shapes: an MCP result and a plugin result", () => {
    const mcp = mcpResult("один")
    appendToResult(mcp, "два")
    expect(resultText(mcp)).toBe("один\nдва")

    const plugin = { output: "один" }
    appendToResult(plugin, "два")
    expect(plugin.output).toBe("один\n\nдва")
  })

  test("a failure reported inside a successful reply is a failure", () => {
    expect(isFailure(mcpResult('{"success": false, "error": "…"}'))).toBe(true)
    expect(isFailure(mcpResult("anything", true))).toBe(true)
    expect(isFailure(mcpResult('{"success": true, "data": "ok"}'))).toBe(false)
  })
})

describe("naming the reference at a name error (G8)", () => {
  test("a missing query field names the table it was looked for in", () => {
    const hint = referenceHint(mcpResult('{"success": false, "error": "Поле не найдено \\"Т.Назначение\\""}'), {
      query: "ВЫБРАТЬ Т.Назначение ИЗ Справочник.ДополнительныеОтчетыИОбработки КАК Т",
    })
    expect(hint).toContain("Справочник.ДополнительныеОтчетыИОбработки")
    expect(hint).toContain("1c_get_metadata")
  })

  test("a missing property of an object points at syntax help first", () => {
    const hint = referenceHint(mcpResult('{"success": false, "error": "Поле объекта не обнаружено (Низ)"}'), { code: "…" })
    expect(hint).toContain("Низ")
    expect(hint).toContain("1c_get_bsl_syntax_help")
  })

  test("other failures get no hint", () => {
    expect(referenceHint(mcpResult('{"success": false, "error": "Деление на 0"}'), {})).toBeNull()
  })
})

describe("the same failure twice (G8, C3)", () => {
  test("counts only exact repeats, per session", () => {
    const failures = new RepeatedFailures()
    const error = mcpResult('{"success": false, "error": "Поле объекта не обнаружено (Низ)"}')
    expect(failures.record("s1", "1c_execute_code", { code: "А" }, error)).toBe(1)
    expect(failures.record("s1", "1c_execute_code", { code: "Б" }, error)).toBe(1)
    expect(failures.record("s2", "1c_execute_code", { code: "А" }, error)).toBe(1)
    expect(failures.record("s1", "1c_execute_code", { code: "А" }, error)).toBe(2)
  })

  // debrief14.md §14.5: the toolkit answers in indented JSON, whose first line is
  // `{`. The same check, re-run after each fix, was told «второй раз» for four
  // different errors.
  const indented = (message: string) =>
    mcpResult(`{\n    "success": false,\n    "error": ${JSON.stringify(message)}\n}`)

  test("different errors on the same call are not a repeat", () => {
    const failures = new RepeatedFailures()
    const call = { code: "Отчет = Отчеты.Имя.Создать();" }
    expect(failures.record("s", "1c_execute_code", call, indented("Параметр не найден \"Срок\""))).toBe(1)
    expect(failures.record("s", "1c_execute_code", call, indented("Синтаксическая ошибка \"ТекущаяДатаСеанса\""))).toBe(1)
    expect(failures.record("s", "1c_execute_code", call, indented("Синтаксическая ошибка \"ТекущаяДатаСеанса\""))).toBe(2)
  })

  test("a result that isn't JSON is keyed on its whole text", () => {
    const failures = new RepeatedFailures()
    expect(failures.record("s", "t", {}, mcpResult("Ошибка:\nпервая"))).toBe(1)
    expect(failures.record("s", "t", {}, mcpResult("Ошибка:\nвторая"))).toBe(1)
  })

  test("through the plugin: the notice only on the same error again", async () => {
    // oxlint-disable-next-line typescript/no-explicit-any -- the plugin input is unused on this path
    const hooks = await InfobasePlugin({} as any, {})
    const after = async (message: string) => {
      const output = indented(message)
      // oxlint-disable-next-line typescript/no-explicit-any -- the after hook reads tool, sessionID, callID and args
      await hooks["tool.execute.after"]!({ tool: "1c_execute_code", sessionID: "s", callID: "c", args: { code: "К" } } as any, output as any)
      return resultText(output)
    }
    expect(await after("Параметр не найден")).not.toContain("второй раз")
    expect(await after("Синтаксическая ошибка")).not.toContain("второй раз")
    expect(await after("Синтаксическая ошибка")).toContain("второй раз")
  })
})

// debrief16.md §16.1: the toolkit's masking read as data.
describe("masking tokens in toolkit replies", () => {
  const reply = { content: [{ type: "text", text: '{"success": true, "data": "Комбайн [SWIFT-00002]  A77 4C | 4122.5"}' }] }

  test("a reply with a token gets a note naming it", () => {
    expect(maskedNote(reply)).toContain("[SWIFT-00002]")
    expect(maskedNote(reply)).toContain("Это не данные")
    expect(maskedNote(reply)).toContain("1c_submit_for_deanonymization")
    expect(maskedNote(reply)).not.toContain("в файл")
  })

  test("a reply without one gets none", () => {
    expect(maskedNote({ content: [{ type: "text", text: '{"success": true, "data": "Комбайн A77"}' }] })).toBeNull()
  })

  test("a query that carries a token back is refused, other text is not", () => {
    expect(maskedTokenRefusal({ query: 'ВЫБРАТЬ 1 ГДЕ Н.Наименование ПОДОБНО "%[SWIFT-00002]%"' })).toContain("[SWIFT-00002]")
    expect(maskedTokenRefusal({ code: 'Н = "Комбайн A77";' })).toBeNull()
    expect(maskedTokenRefusal({ query: "ВЫБРАТЬ Т.Поле[1] ИЗ Т" })).toBeNull()
  })
})
