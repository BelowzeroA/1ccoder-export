import { describe, expect, test } from "bun:test"

import { describeJournal, journalLine, journalPath, readJournal, type WriteStarted } from "./journal"
import { markUnansweredQuestion, UNANSWERED_NOTICE, type TransformMessage } from "./questions"

// failures_to_tools.md T4 and T8.

const started = (callID: string, sessionID = "s1"): WriteStarted => ({
  kind: "started",
  callID,
  sessionID,
  at: "2026-01-01T00:00:00.000Z",
  summary: "Новый элемент справочника",
  objects: "Справочник.<Имя>",
  count: 1,
  organisations: "не применимо",
})

describe("the write journal (T4)", () => {
  test("lives in the working directory", () => {
    expect(journalPath("C:/w/task/")).toBe("C:/w/task/.1ccoder/writes.jsonl")
  })

  test("joins each write with its outcome, and keeps an unfinished one as unknown", () => {
    const text = [
      journalLine(started("c1")),
      journalLine({ kind: "finished", callID: "c1", at: "…", failed: false, result: "Создан: 00000000007" }),
      journalLine(started("c2")),
      journalLine(started("c3")),
      journalLine({ kind: "finished", callID: "c3", at: "…", failed: true, result: "Ошибка" }),
      journalLine(started("c4", "other-session")),
      "not json\n",
    ].join("")
    const entries = readJournal(text, "s1")
    expect(entries.map((entry) => [entry.callID, entry.outcome])).toEqual([
      ["c1", "done"],
      ["c2", "unknown"],
      ["c3", "failed"],
    ])

    const described = describeJournal(entries, "C:/w/.1ccoder/writes.jsonl")
    expect(described).toContain("00000000007")
    expect(described).toContain("ИСХОД НЕИЗВЕСТЕН")
    expect(described).toContain("Как откатить")
  })

  test("an empty journal says so rather than listing nothing", () => {
    expect(describeJournal([], "p")).toContain("записей в базу не было")
  })
})

function message(id: string, role: string, parts: unknown[] = []): TransformMessage {
  return { info: { id, sessionID: "s1", role }, parts }
}
const question = (status: string) => ({ type: "tool", tool: "question", state: { status } })

describe("an unanswered question (T8)", () => {
  test("marks the user's reply to an interrupted question", () => {
    const messages = [message("u1", "user"), message("a1", "assistant", [question("running")]), message("u2", "user")]
    expect(markUnansweredQuestion(messages)).toBe(true)
    expect(messages[2]!.parts).toContainEqual(expect.objectContaining({ type: "text", text: UNANSWERED_NOTICE, synthetic: true }))
  })

  test("a rejected question counts as unanswered too", () => {
    const messages = [message("u1", "user"), message("a1", "assistant", [question("error")]), message("u2", "user")]
    expect(markUnansweredQuestion(messages)).toBe(true)
  })

  test("an answered question is left alone", () => {
    const messages = [message("u1", "user"), message("a1", "assistant", [question("completed")]), message("u2", "user")]
    expect(markUnansweredQuestion(messages)).toBe(false)
    expect(messages[2]!.parts).toEqual([])
  })

  // Once the user has replied to it, an old unanswered question is history.
  test("only the turn being replied to counts", () => {
    const messages = [
      message("u1", "user"),
      message("a1", "assistant", [question("running")]),
      message("u2", "user"),
      message("a2", "assistant", [{ type: "text", text: "…" }]),
      message("u3", "user"),
    ]
    expect(markUnansweredQuestion(messages)).toBe(false)
  })
})
