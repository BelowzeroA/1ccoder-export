// The relay's transport after the Moscow relay (connectivity/relay-ru-plan.md,
// step 5): which address is used, how a frozen connection is told from a slow
// model, how a broken stream ends, and when retrying stops.

import { describe, expect, test } from "bun:test"

import {
  completeEventsEnd,
  LlmRelay,
  RETRIES_STOPPED_ERROR_TYPE,
  STREAM_FROZEN_FRAME,
  TRANSIENT_ERROR_TYPE,
  TRANSIENT_FAILURE_LIMIT,
} from "./relay"
import { FAILURES_BEFORE_REPROBE, PREFERRED_RECHECK_MS, ServerSelector } from "./servers"
import { RETRIES_STOPPED } from "./support"

const encode = (text: string) => new TextEncoder().encode(text)
const CONTENT = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
const FINISHED = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
const DONE = "data: [DONE]\n\n"
const HEARTBEAT = ": 1ccoder heartbeat\n\n"

/** One script step per pull: text to send, a pause first, an error, or a hang. */
type Step = string | { wait: number } | { error: Error } | "hang"

function sse(steps: Step[]) {
  const queue = [...steps]
  return new Response(
    new ReadableStream({
      async pull(controller) {
        for (;;) {
          const step = queue.shift()
          if (step === undefined) return controller.close()
          if (step === "hang") return new Promise<void>(() => undefined)
          if (typeof step === "string") return controller.enqueue(encode(step))
          if ("wait" in step) await Bun.sleep(step.wait)
          if ("error" in step) return controller.error(step.error)
        }
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  )
}

function harness(completion: () => Response, config: Record<string, unknown> = { chunk_size: 12000 }) {
  let completions = 0
  const relay = new LlmRelay({
    getCredential: async () => ({ email: "u@e.com", credential: "cred" }),
    baseUrl: "https://auth.example.test",
    frozenMinMs: 300,
    fetchImpl: (async (url: unknown) => {
      const target = String(url)
      if (target.endsWith("/llm/config")) return new Response(JSON.stringify(config))
      if (target.endsWith("/llm/token"))
        return new Response(JSON.stringify({ token: "tok", expires_at: Date.now() / 1000 + 3600 }))
      completions++
      return completion()
    }) as typeof fetch,
  })
  return { relay, completions: () => completions }
}

async function ask(port: number, session = "ses_1", stream = true) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Id": session },
    body: JSON.stringify({ messages: [], stream }),
  })
  return { status: response.status, body: await response.text() }
}

async function relayed(completion: () => Response, config?: Record<string, unknown>) {
  const { relay } = harness(completion, config)
  const port = await relay.start()
  try {
    return (await ask(port)).body
  } finally {
    await relay.close()
  }
}

describe("whole SSE events only", () => {
  test("the end of the last complete event", () => {
    expect(completeEventsEnd(Buffer.from(""))).toBe(0)
    expect(completeEventsEnd(Buffer.from('data: {"cho'))).toBe(0)
    expect(completeEventsEnd(Buffer.from(CONTENT + 'data: {"cho'))).toBe(CONTENT.length)
    expect(completeEventsEnd(Buffer.from("data: x\r\n\r\ndata: y"))).toBe("data: x\r\n\r\n".length)
  })

  test("an event split across reads arrives whole and unchanged", async () => {
    const body = await relayed(() => sse([CONTENT.slice(0, 9), CONTENT.slice(9, 30), CONTENT.slice(30), FINISHED, DONE]))
    expect(body).toBe(CONTENT + FINISHED + DONE)
  })

  // 2026-10-05, SERVER_ST: the error frame followed half an event, the client
  // parsed the two as one and said "JSON parsing failed" -- not retryable.
  test("a stream that breaks mid-event drops the half and starts its error on a boundary", async () => {
    const body = await relayed(() => sse([CONTENT, 'data: {"choices":[{"index":7', { error: new Error("reset") }]))
    expect(body).toStartWith(CONTENT + 'data: {"error"')
    expect(body).not.toContain('"index":7')
    expect(body).toContain(TRANSIENT_ERROR_TYPE)
  })

  test("so does one that closes tidily mid-event", async () => {
    const body = await relayed(() => sse([CONTENT, 'data: {"choices":[{"de']))
    expect(body).toStartWith(CONTENT + 'data: {"error"')
    expect(body).toContain("ended before it was complete")
  })

  test("a last event its sender never closed with a blank line is still delivered", async () => {
    const body = await relayed(() => sse([CONTENT, FINISHED, "data: [DONE]"]))
    expect(body).toBe(CONTENT + FINISHED + DONE)
  })
})

describe("a frozen connection, told from a slow model", () => {
  const beating = { chunk_size: 12000, heartbeat_seconds: 0.05 }

  test("no bytes at all, heartbeats included, is a frozen connection", async () => {
    const started = Date.now()
    const body = await relayed(() => sse([CONTENT, "hang"]), beating)
    expect(body).toBe(CONTENT + STREAM_FROZEN_FRAME.toString())
    // frozenMinMs, not STREAM_STALL_MS.
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("heartbeats keep a long silence in data alive", async () => {
    const beats: Step[] = Array.from({ length: 8 }, () => [{ wait: 100 }, HEARTBEAT] as Step[]).flat()
    const body = await relayed(() => sse([CONTENT, ...beats, FINISHED, DONE]), beating)
    expect(body).not.toContain("froze")
    expect(body.replaceAll(HEARTBEAT, "")).toBe(CONTENT + FINISHED + DONE)
  })

  test("a server that does not send heartbeats is never judged by them", async () => {
    const body = await relayed(() => sse([CONTENT, { wait: 700 }, FINISHED, DONE]))
    expect(body).toBe(CONTENT + FINISHED + DONE)
  })
})

describe("retrying stops after answers keep breaking", () => {
  const truncated = () => sse([CONTENT])

  test(`after ${TRANSIENT_FAILURE_LIMIT} lost answers the next request is refused before it costs anything`, async () => {
    const { relay, completions } = harness(truncated)
    const port = await relay.start()
    try {
      for (let i = 0; i < TRANSIENT_FAILURE_LIMIT; i++) expect((await ask(port)).body).toContain(TRANSIENT_ERROR_TYPE)
      const refused = await ask(port)
      expect(refused.body).toContain(RETRIES_STOPPED)
      expect(refused.body).toContain(RETRIES_STOPPED_ERROR_TYPE)
      expect(refused.body).not.toContain(TRANSIENT_ERROR_TYPE)
      expect(refused.body).toEndWith(DONE)
      expect(completions()).toBe(TRANSIENT_FAILURE_LIMIT)
      // The count starts over, so the person's «продолжай» is sent.
      await ask(port)
      expect(completions()).toBe(TRANSIENT_FAILURE_LIMIT + 1)
    } finally {
      await relay.close()
    }
  })

  test("an answer that arrives resets the count", async () => {
    let n = 0
    const { relay, completions } = harness(() => (++n % 3 === 0 ? sse([CONTENT, FINISHED, DONE]) : truncated()))
    const port = await relay.start()
    try {
      for (let i = 0; i < 6; i++) expect((await ask(port)).body).not.toContain(RETRIES_STOPPED)
      expect(completions()).toBe(6)
    } finally {
      await relay.close()
    }
  })

  test("the server's own transient error counts as a lost answer", async () => {
    const serverError = 'data: {"error": {"message": "Upstream provider error", "type": "1ccoder_transient"}}\n\n' + DONE
    const { relay } = harness(() => sse([CONTENT, serverError]))
    const port = await relay.start()
    try {
      for (let i = 0; i < TRANSIENT_FAILURE_LIMIT; i++) await ask(port)
      expect((await ask(port)).body).toContain(RETRIES_STOPPED)
    } finally {
      await relay.close()
    }
  })

  test("sessions are counted apart", async () => {
    const { relay } = harness(truncated)
    const port = await relay.start()
    try {
      for (let i = 0; i < TRANSIENT_FAILURE_LIMIT; i++) await ask(port, "ses_a")
      expect((await ask(port, "ses_b")).body).not.toContain(RETRIES_STOPPED)
      expect((await ask(port, "ses_a")).body).toContain(RETRIES_STOPPED)
    } finally {
      await relay.close()
    }
  })

  test("a refusal that needs a person does not count", async () => {
    const { relay } = harness(() => new Response(JSON.stringify({ detail: "bad request" }), { status: 400 }))
    const port = await relay.start()
    try {
      for (let i = 0; i < TRANSIENT_FAILURE_LIMIT + 1; i++) expect((await ask(port)).body).not.toContain(RETRIES_STOPPED)
    } finally {
      await relay.close()
    }
  })

  test("a non-streaming request is refused with a status opencode does not retry", async () => {
    const { relay } = harness(() => new Response("", { status: 502 }))
    const port = await relay.start()
    try {
      for (let i = 0; i < TRANSIENT_FAILURE_LIMIT; i++) expect((await ask(port, "ses_1", false)).status).toBe(502)
      const refused = await ask(port, "ses_1", false)
      expect(refused.status).toBe(424)
      expect(refused.body).toContain(RETRIES_STOPPED)
    } finally {
      await relay.close()
    }
  })
})

describe("which address of the service is used", () => {
  // Answers /health for the addresses in `up`; records every URL asked.
  function network(up: Set<string>) {
    const asked: string[] = []
    const fetchImpl = (async (url: unknown) => {
      const target = String(url)
      asked.push(target)
      const origin = new URL(target).origin
      if (!up.has(origin)) throw new TypeError("fetch failed")
      return new Response("{}")
    }) as typeof fetch
    return { asked, fetchImpl }
  }

  test("the first in the list that answers", async () => {
    const selector = new ServerSelector({ servers: ["https://a.test", "https://b.test"], ...network(new Set(["https://b.test"])) })
    expect(await selector.probe()).toBe("https://b.test")
    expect(selector.current).toBe("https://b.test")
  })

  test("order wins over speed: the preferred one is used when both answer", async () => {
    const selector = new ServerSelector({
      servers: ["https://a.test", "https://b.test"],
      ...network(new Set(["https://a.test", "https://b.test"])),
    })
    expect(await selector.probe()).toBe("https://a.test")
  })

  test("when none answers the choice stays", async () => {
    const selector = new ServerSelector({ servers: ["https://a.test", "https://b.test"], ...network(new Set()) })
    expect(await selector.probe()).toBe("https://a.test")
  })

  test(`${FAILURES_BEFORE_REPROBE} failures in a row move to an address that answers`, async () => {
    const up = new Set(["https://a.test", "https://b.test"])
    const selector = new ServerSelector({ servers: ["https://a.test", "https://b.test"], ...network(up) })
    await selector.probe()
    up.delete("https://a.test")
    for (let i = 0; i < FAILURES_BEFORE_REPROBE; i++) selector.reportFailure()
    await selector.probe()
    expect(selector.current).toBe("https://b.test")
  })

  test("a client that fell back checks again for the preferred one, not on every request", async () => {
    let now = 0
    const up = new Set(["https://b.test"])
    const net = network(up)
    const selector = new ServerSelector({ servers: ["https://a.test", "https://b.test"], now: () => now, ...net })
    await selector.probe()
    up.add("https://a.test")
    selector.reportSuccess()
    expect(selector.current).toBe("https://b.test")
    now = PREFERRED_RECHECK_MS
    selector.reportSuccess()
    await selector.probe()
    expect(selector.current).toBe("https://a.test")
  })

  test("the served list replaces the built-in one", async () => {
    const selector = new ServerSelector({ servers: ["https://a.test", "https://b.test"], ...network(new Set(["https://c.test"])) })
    selector.setServers(["https://c.test/", "https://a.test", "not a url"])
    expect(selector.servers).toEqual(["https://c.test", "https://a.test"])
    await selector.probe()
    expect(selector.current).toBe("https://c.test")
  })

  test("the relay sends everything to the address that answered, and adopts the served list", async () => {
    const asked: string[] = []
    const relay = new LlmRelay({
      getCredential: async () => ({ email: "u@e.com", credential: "cred" }),
      servers: ["https://ru.test", "https://auth.test"],
      fetchImpl: (async (url: unknown) => {
        const target = String(url)
        asked.push(target)
        if (target.startsWith("https://ru.test")) throw new TypeError("fetch failed")
        if (target.endsWith("/health")) return new Response("{}")
        if (target.endsWith("/llm/config"))
          return new Response(JSON.stringify({ chunk_size: 12000, servers: ["https://ru.test", "https://auth.test"] }))
        if (target.endsWith("/llm/token"))
          return new Response(JSON.stringify({ token: "tok", expires_at: Date.now() / 1000 + 3600 }))
        return sse([CONTENT, FINISHED, DONE])
      }) as typeof fetch,
    })
    const port = await relay.start()
    try {
      expect(relay.serverUrl).toBe("https://auth.test")
      expect((await ask(port)).body).toBe(CONTENT + FINISHED + DONE)
      expect(asked).toContain("https://auth.test/llm/v1/chat/completions")
      expect(asked.filter((url) => url.startsWith("https://ru.test") && !url.endsWith("/health"))).toEqual([])
    } finally {
      await relay.close()
    }
  })
})
