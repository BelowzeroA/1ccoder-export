import { describe, expect, test } from "bun:test"

import { InfobasePlugin } from "./plugin"
import {
  awaitsHuman,
  classifyError,
  announcedStep,
  endedEmpty,
  RESUME_LIMIT,
  RESUME_WINDOW_MS,
  ResumeBudget,
  resumeText,
  userSpokeAfterFailure,
  type MessageLike,
} from "./auto-resume"
import { ACCOUNT_BLOCKED_MESSAGE, retriesStoppedMessage, TRANSIENT_FAILURE_LIMIT } from "../llm/relay"

// debrief14.md §14.4: a broken stream ended the turn and the session sat idle
// until the user typed «продолжай».

describe("which errors are resumed", () => {
  test("the one that ended the session: the gateway's in-band error", () => {
    expect(classifyError({ name: "UnknownError", data: { message: '{"message":"Upstream provider error"}' } })).toEqual({ resume: true })
  })

  test("a server failure, a rate limit, an answer cut for length", () => {
    expect(classifyError({ name: "APIError", data: { message: "The model service failed (502)", statusCode: 502 } }).resume).toBe(true)
    expect(classifyError({ name: "APIError", data: { message: "rate limit" } }).resume).toBe(true)
    expect(classifyError({ name: "MessageOutputLengthError", data: {} }).resume).toBe(true)
  })

  test("never what a person has to settle", () => {
    expect(classifyError({ name: "MessageAbortedError", data: {} }).resume).toBe(false)
    expect(classifyError({ name: "ProviderAuthError", data: { message: "bad key" } }).resume).toBe(false)
    expect(classifyError({ name: "UnknownError", data: { message: "1CCoder is not signed in" } }).resume).toBe(false)
    expect(classifyError({ name: "APIError", data: { message: "insufficient balance" } }).resume).toBe(false)
    expect(classifyError({ name: "UnknownError", data: { message: "The user rejected permission to use this tool" } }).resume).toBe(false)
    expect(classifyError(undefined).resume).toBe(false)
  })

  test("never the relay's stop after answers kept breaking: resuming would undo it", () => {
    // As opencode records it: the message of the relay's in-band error.
    const verdict = classifyError({ name: "APIError", data: { message: retriesStoppedMessage(TRANSIENT_FAILURE_LIMIT) } })
    expect(verdict.resume).toBe(false)
  })

  test("never a blocked account: only the operator can lift it", () => {
    expect(classifyError({ name: "APIError", data: { message: ACCOUNT_BLOCKED_MESSAGE } }).resume).toBe(false)
  })
})

const assistant = (parts: unknown[]): MessageLike => ({ info: { role: "assistant" }, parts })
const user = (text: string): MessageLike => ({ info: { role: "user" }, parts: [{ type: "text", text }] })

describe("when a human is waited on", () => {
  test("a question tool call left open", () => {
    expect(awaitsHuman([user("go"), assistant([{ type: "tool", tool: "question", state: { status: "running" } }])])).toBe(true)
  })

  test("text that ends by asking", () => {
    expect(awaitsHuman([user("go"), assistant([{ type: "text", text: "Какой вариант выбрать?" }])])).toBe(true)
  })

  test("work in progress is not waiting", () => {
    expect(awaitsHuman([user("go"), assistant([{ type: "text", text: "Изучаю регистры." }, { type: "tool", tool: "bash", state: { status: "completed" } }])])).toBe(false)
  })

  test("a user message after the failure means someone has taken over", () => {
    expect(userSpokeAfterFailure([user("go"), assistant([]), user("стоп")])).toBe(true)
    expect(userSpokeAfterFailure([user("go"), assistant([])])).toBe(false)
  })
})

describe("the budget", () => {
  test("three resumes an hour, with growing pauses, then none", () => {
    let now = 0
    const budget = new ResumeBudget(() => now)
    const delays = Array.from({ length: RESUME_LIMIT }, () => {
      const next = budget.next("s")!
      budget.record("s")
      return next.delayMs
    })
    expect(delays).toEqual([60_000, 300_000, 900_000])
    expect(budget.next("s")).toBeNull()
    now += RESUME_WINDOW_MS + 1
    expect(budget.next("s")?.attempt).toBe(1)
  })

  test("sessions have their own budgets", () => {
    const budget = new ResumeBudget(() => 0)
    for (let i = 0; i < RESUME_LIMIT; i++) budget.record("a")
    expect(budget.next("a")).toBeNull()
    expect(budget.next("b")?.attempt).toBe(1)
  })
})

test("the resume message is visible, numbered, and tells the agent not to redo work", () => {
  const text = resumeText(2, { data: { message: "Upstream provider error" } })
  expect(text).toContain("попытка 2 из 3")
  expect(text).toContain("Upstream provider error")
  expect(text).toContain("не повторяй уже сделанное")
})

// Through the real plugin, with a stand-in for opencode's client.
describe("a session.error, through the plugin", () => {
  function fakeClient(messages: MessageLike[], parentID?: string) {
    const prompts: unknown[] = []
    const client = {
      session: {
        get: async () => ({ data: { id: "ses", ...(parentID ? { parentID } : {}) } }),
        messages: async () => ({ data: messages }),
        status: async () => ({ data: { ses: { type: "idle" } } }),
        promptAsync: async (request: unknown) => {
          prompts.push(request)
          return { data: undefined }
        },
      },
    }
    return { client, prompts }
  }
  const failed = [user("сделай"), { info: { role: "assistant", mode: "1ccoder-profile", providerID: "p", modelID: "m" }, parts: [] } as MessageLike]
  const error = { name: "UnknownError", data: { message: '{"message":"Upstream provider error"}' } }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

  async function fire(client: unknown) {
    // oxlint-disable-next-line typescript/no-explicit-any -- only `client` is read from the input here
    const hooks = await InfobasePlugin({ client } as any, { baseUrl: "http://127.0.0.1:1", resumeDelaysMs: [0, 0, 0] })
    // oxlint-disable-next-line typescript/no-explicit-any -- a minimal event of the shape opencode sends
    await hooks.event!({ event: { type: "session.error", properties: { sessionID: "ses", error } } as any })
    await settle()
  }

  test("resumes with the same agent and model", async () => {
    const { client, prompts } = fakeClient(failed)
    await fire(client)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ path: { id: "ses" }, body: { agent: "1ccoder-profile", model: { providerID: "p", modelID: "m" } } })
  })

  test("leaves a sub-agent's session to its parent", async () => {
    const { client, prompts } = fakeClient(failed, "ses_parent")
    await fire(client)
    expect(prompts).toHaveLength(0)
  })

  test("does not resume a turn that ended by asking the user", async () => {
    const { client, prompts } = fakeClient([user("сделай"), assistant([{ type: "text", text: "Удалить расширение?" }])])
    await fire(client)
    expect(prompts).toHaveLength(0)
  })
})

// Layer 3, debrief14.md §14.5: after two tool calls the model answered with
// nothing -- finish stop, no text, no tool, no error -- and the session sat idle.
const toolStep: MessageLike = {
  info: { role: "assistant", finish: "tool-calls" },
  parts: [{ type: "step-start" }, { type: "tool", tool: "1c_get_bsl_syntax_help", state: { status: "completed" } }, { type: "step-finish" }],
}
const emptyStop: MessageLike = { info: { role: "assistant", finish: "stop" }, parts: [{ type: "step-start" }, { type: "step-finish" }] }

describe("a turn that ended on an empty answer", () => {
  test("the observed shape: tool calls, then an empty stop", () => {
    expect(endedEmpty([user("сделай"), toolStep, toolStep, emptyStop])).toBe(true)
  })

  test("reasoning alone is not an answer the user sees", () => {
    const reasoned: MessageLike = { info: { role: "assistant", finish: "stop" }, parts: [{ type: "reasoning", text: "думаю" }] }
    expect(endedEmpty([user("сделай"), toolStep, reasoned])).toBe(true)
  })

  test("a final text is a deliberate finish", () => {
    expect(endedEmpty([user("сделай"), toolStep, assistant([{ type: "text", text: "Готово." }])])).toBe(false)
  })

  test("an empty answer with no work in the turn is not mid-work", () => {
    expect(endedEmpty([user("привет"), emptyStop])).toBe(false)
    // Tools in an earlier turn don't count.
    expect(endedEmpty([user("сделай"), toolStep, assistant([{ type: "text", text: "Готово." }]), user("ещё"), emptyStop])).toBe(false)
  })

  test("an error is layer 2's, and a step that asked for tools is still running", () => {
    expect(endedEmpty([user("сделай"), toolStep, { info: { role: "assistant", error: { name: "APIError" } }, parts: [] }])).toBe(false)
    expect(endedEmpty([user("сделай"), toolStep])).toBe(false)
  })
})

// debrief15.md §15.22: mid-work, the turn ended on «…прочитаю XML макета через
// СериализаторXDTO и напечатаю:» with finish stop and no call, and sat idle.
const said = (text: string): MessageLike => ({ info: { role: "assistant", finish: "stop" }, parts: [{ type: "text", text }] })
const ANNOUNCED = "Быстрая проверка без пересборки — прочитаю XML макета через СериализаторXDTO и напечатаю:"

describe("a turn that announced a step and stopped", () => {
  test("the observed message is an announcement", () => {
    expect(announcedStep([user("сделай"), toolStep, said(ANNOUNCED)])).toBe(ANNOUNCED)
  })

  test("a next step named without a colon, after a report of what was done", () => {
    expect(announcedStep([user("сделай"), toolStep, said("Макет собран.\nСейчас напечатаю и сравню с образцом.")])).toBe(
      "Сейчас напечатаю и сравню с образцом.",
    )
    expect(announcedStep([user("сделай"), toolStep, said("Заголовок на месте, теперь проверю подписи")])).toBe(
      "Заголовок на месте, теперь проверю подписи",
    )
  })

  test("a trailing colon announces whatever the verb", () => {
    expect(announcedStep([user("сделай"), toolStep, said("Строка 9 макета через СериализаторXDTO:")])).toBe(
      "Строка 9 макета через СериализаторXDTO:",
    )
  })

  test("a final report, an offer and a question are left alone", () => {
    const report = "Готово. Печатная форма зарегистрирована и печатается как образец.\nФайлы: ВПФ_ПриказНаПрофОбучение.epf."
    expect(announcedStep([user("сделай"), toolStep, said(report)])).toBeNull()
    expect(announcedStep([user("сделай"), toolStep, said("Всё готово. Если нужно, поправлю отступы")])).toBeNull()
    expect(announcedStep([user("сделай"), toolStep, said("Проверю печать: регистрировать форму в calc?")])).toBeNull()
  })

  test("only a stop mid-work with no call counts", () => {
    expect(announcedStep([user("привет"), said(ANNOUNCED)])).toBeNull()
    const withCall: MessageLike = {
      info: { role: "assistant", finish: "stop" },
      parts: [{ type: "text", text: ANNOUNCED }, { type: "tool", tool: "1c_execute_code", state: { status: "completed" } }],
    }
    expect(announcedStep([user("сделай"), toolStep, withCall])).toBeNull()
    const cut: MessageLike = { info: { role: "assistant", finish: "length" }, parts: [{ type: "text", text: ANNOUNCED }] }
    expect(announcedStep([user("сделай"), toolStep, cut])).toBeNull()
  })
})

describe("a session.idle, through the plugin", () => {
  const logs: { body?: { service?: string; message?: string; extra?: Record<string, unknown> } }[] = []
  async function idle(messages: MessageLike[]) {
    const prompts: { body?: { parts?: { text?: string }[] } }[] = []
    const client = {
      session: {
        get: async () => ({ data: { id: "ses" } }),
        messages: async () => ({ data: messages }),
        status: async () => ({ data: { ses: { type: "idle" } } }),
        promptAsync: async (request: { body?: { parts?: { text?: string }[] } }) => {
          prompts.push(request)
          return { data: undefined }
        },
      },
      app: {
        log: async (request: { body?: { service?: string; message?: string; extra?: Record<string, unknown> } }) => {
          logs.push(request)
          return { data: true }
        },
      },
    }
    // oxlint-disable-next-line typescript/no-explicit-any -- only `client` is read from the input here
    const hooks = await InfobasePlugin({ client } as any, { baseUrl: "http://127.0.0.1:1", resumeDelaysMs: [0, 0, 0] })
    // oxlint-disable-next-line typescript/no-explicit-any -- a minimal event of the shape opencode sends
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses" } } as any })
    await new Promise((resolve) => setTimeout(resolve, 30))
    return prompts
  }

  test("an empty answer mid-work is resumed, visibly, saying why", async () => {
    const prompts = await idle([user("сделай"), toolStep, emptyStop])
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.body?.parts?.[0]?.text).toContain("пустой ответ посреди работы")
  })

  test("a turn that finished with text is left alone", async () => {
    expect(await idle([user("сделай"), toolStep, assistant([{ type: "text", text: "Готово." }])])).toHaveLength(0)
  })

  test("a turn that announced a step and stopped is resumed, asking for the call, and the resume is logged", async () => {
    logs.length = 0
    const prompts = await idle([user("сделай"), toolStep, said(ANNOUNCED)])
    expect(prompts).toHaveLength(1)
    const text = prompts[0]?.body?.parts?.[0]?.text ?? ""
    expect(text).toContain(`«${ANNOUNCED}»`)
    expect(text).toContain("вызовом инструмента")
    expect(logs.map((log) => log.body?.message)).toEqual([`session ses: resume 1/3 (announced a step and stopped: ${ANNOUNCED})`])
    // debrief15.md §15.28: the server drops `service`; `extra` is what names the line.
    expect(logs[0]?.body).toMatchObject({ extra: { service: "1ccoder-resume" } })
  })

  test("a turn that ended with a question is left alone", async () => {
    expect(await idle([user("сделай"), toolStep, said("Регистрировать форму в calc?")])).toHaveLength(0)
  })
})
