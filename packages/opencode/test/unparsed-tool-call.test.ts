import { describe, expect, test } from "bun:test"

// The detector is not exported -- it is three lines inside processor.ts, which
// drags in half the runtime. Kept in step with the copy there; the point of
// these cases is the boundary, and that is what would drift.
const UNPARSED_TOOL_CALL = /<\/(?:tool_call|function_call|invoke|antml:invoke)>\s*$/
const unparsedToolCall = (text: string) => UNPARSED_TOOL_CALL.test(text.trimEnd())

describe("spotting a tool call that was left in the text", () => {
  // Verbatim from the run that prompted this: the agent said what it was about
  // to do, the call was not parsed, and the turn ended looking finished.
  test("catches the real one", () => {
    const text =
      "Проверю, появились ли инструменты тулкита — сделаю пробный вызов синтакс-помощника для спорного API." +
      "</arg_key><arg_value>WriteJSON</arg_value></tool_call>"
    expect(unparsedToolCall(text)).toBe(true)
  })

  test("tolerates trailing whitespace and newlines", () => {
    expect(unparsedToolCall("что-то</tool_call>\n\n  ")).toBe(true)
  })

  test("catches the other common closers", () => {
    expect(unparsedToolCall("x</function_call>")).toBe(true)
    expect(unparsedToolCall("x</invoke>")).toBe(true)
  })

  // The tell-tale is a reply that breaks off mid-call. A model explaining tool
  // syntax and then carrying on has not failed at anything.
  test("ignores the markup when the reply continues past it", () => {
    expect(unparsedToolCall("Формат такой: <tool_call>…</tool_call>, и дальше обычный текст.")).toBe(false)
  })

  test("ignores ordinary replies", () => {
    expect(unparsedToolCall("Готово, обработка собрана.")).toBe(false)
    expect(unparsedToolCall("")).toBe(false)
  })

  test("ignores an opening tag with nothing closing it", () => {
    expect(unparsedToolCall("<tool_call>")).toBe(false)
  })
})
