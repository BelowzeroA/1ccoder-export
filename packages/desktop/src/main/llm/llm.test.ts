import { expect, test, describe } from "bun:test"

import {
  asksForStream,
  createStallWatcher,
  createStreamEndWatcher,
  isTokenUsable,
  upstreamMessage,
  newUploadId,
  planChunks,
  STREAM_STALL_MS,
  UPSTREAM_HEADERS_MS,
  TOKEN_REFRESH_MARGIN_MS,
  LlmRelay,
  BALANCE_REFRESH_MS,
  CREDITS_ERROR_TYPE,
  creditsExhaustedMessage,
  ACCOUNT_BLOCKED_ERROR_TYPE,
  ACCOUNT_BLOCKED_MESSAGE,
  isAccountBlocked,
  fetchErrorReason,
  TRANSIENT_ERROR_TYPE,
  UPSTREAM_UNREACHABLE,
} from "./relay"
import {
  applyDefaultModel,
  disableShare,
  restrictProviders,
  mergeProviderConfig,
  resolveOpencodeConfigDir,
  MODEL_ID,
  PROVIDER_ID,
} from "./provider-config"
import { SUPPORT_CONTACT } from "./support"

describe("chunk planning", () => {
  test("covers the whole body with no gaps or overlaps", () => {
    const total = 60_120
    const size = 12_000
    const plan = planChunks(total, size)
    expect(plan.length).toBe(6)
    expect(plan[0].start).toBe(0)
    expect(plan[plan.length - 1].end).toBe(total)
    for (let i = 1; i < plan.length; i++) expect(plan[i].start).toBe(plan[i - 1].end)
    expect(plan.reduce((sum, p) => sum + (p.end - p.start), 0)).toBe(total)
  })

  test("no chunk exceeds the threshold, which is the entire point", () => {
    const size = 12_000
    for (const total of [1, 11_999, 12_000, 12_001, 100_000, 999_999]) {
      for (const piece of planChunks(total, size)) {
        expect(piece.end - piece.start).toBeLessThanOrEqual(size)
        expect(piece.end - piece.start).toBeGreaterThan(0)
      }
    }
  })

  test("a body exactly on the boundary is a single chunk", () => {
    expect(planChunks(12_000, 12_000).length).toBe(1)
    expect(planChunks(12_001, 12_000).length).toBe(2)
  })

  test("indices are sequential from zero", () => {
    const plan = planChunks(50_000, 7_000)
    expect(plan.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  test("an empty body produces no chunks", () => {
    expect(planChunks(0, 12_000)).toEqual([])
  })

  test("a non-positive chunk size is rejected rather than looping forever", () => {
    expect(() => planChunks(100, 0)).toThrow()
  })
})

describe("upload ids", () => {
  test("are alphanumeric, since the server rejects anything else in the path", () => {
    for (let i = 0; i < 50; i++) {
      const id = newUploadId()
      expect(id).toMatch(/^[A-Za-z0-9]+$/)
      expect(id.length).toBeGreaterThan(0)
      expect(id.length).toBeLessThanOrEqual(40)
    }
  })

  test("do not collide across rapid successive calls", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newUploadId()))
    expect(ids.size).toBe(200)
  })
})

describe("token freshness", () => {
  const now = 1_000_000

  test("a token comfortably in the future is usable", () => {
    expect(isTokenUsable({ token: "t", expiresAt: now + 3_600_000 }, now)).toBe(true)
  })

  test("an expired token is not", () => {
    expect(isTokenUsable({ token: "t", expiresAt: now - 1 }, now)).toBe(false)
  })

  test("a token inside the refresh margin is treated as stale", () => {
    // Otherwise it can expire mid-flight, which the user sees as a failed request.
    expect(isTokenUsable({ token: "t", expiresAt: now + TOKEN_REFRESH_MARGIN_MS - 1 }, now)).toBe(false)
  })

  test("absent token is not usable", () => {
    expect(isTokenUsable(null, now)).toBe(false)
  })
})

describe("provider config merging", () => {
  test("registers the provider with the relay port", () => {
    const merged = mergeProviderConfig({}, 45123, "1CCoder модель") as any
    expect(merged.provider[PROVIDER_ID].options.baseURL).toBe("http://127.0.0.1:45123/v1")
    expect(merged.provider[PROVIDER_ID].models[MODEL_ID].name).toBe("1CCoder модель")
    expect(merged.provider[PROVIDER_ID].npm).toBe("@ai-sdk/openai-compatible")
  })

  test("leaves unrelated user config untouched", () => {
    const existing = {
      theme: "dark",
      agent: { build: { model: "anthropic/claude" } },
      provider: { openai: { npm: "@ai-sdk/openai", options: { apiKey: "user-key" } } },
    }
    const merged = mergeProviderConfig(existing, 1234, "1CCoder модель") as any
    expect(merged.theme).toBe("dark")
    expect(merged.agent.build.model).toBe("anthropic/claude")
    expect(merged.provider.openai.options.apiKey).toBe("user-key")
    expect(merged.provider[PROVIDER_ID]).toBeDefined()
  })

  test("rewrites our own entry on a port change without duplicating it", () => {
    const first = mergeProviderConfig({}, 1111, "1CCoder модель")
    const second = mergeProviderConfig(first, 2222, "1CCoder модель") as any
    expect(Object.keys(second.provider)).toEqual([PROVIDER_ID])
    expect(second.provider[PROVIDER_ID].options.baseURL).toContain("2222")
  })

  test("becomes the default model when the user has not chosen one", () => {
    const config = applyDefaultModel(mergeProviderConfig({}, 1, "x")) as any
    expect(config.model).toBe(`${PROVIDER_ID}/${MODEL_ID}`)
  })

  test("never overrides a model the user explicitly chose", () => {
    const config = applyDefaultModel({ model: "anthropic/claude-sonnet-4" }) as any
    expect(config.model).toBe("anthropic/claude-sonnet-4")
  })

  test("share is disabled even when the user's config turned it on", () => {
    expect(disableShare({ share: "auto", model: "m" })).toEqual({ share: "disabled", model: "m" })
  })
})

describe("relay request handling", () => {
  function makeRelay(fetchImpl: typeof fetch, credential = { email: "u@e.com", credential: "cred" }) {
    return new LlmRelay({
      getCredential: async () => credential,
      baseUrl: "https://auth.example.test",
      fetchImpl,
      now: () => 1_000_000,
    })
  }

  test("small bodies are sent in one request, not chunked", async () => {
    const calls: string[] = []
    const relay = makeRelay((async (url: any, init: any) => {
      calls.push(String(url))
      if (String(url).endsWith("/llm/config")) return new Response(JSON.stringify({ chunk_size: 12000 }))
      if (String(url).endsWith("/llm/token")) return new Response(JSON.stringify({ token: "tok", expires_at: 2_000 }))
      return new Response("{}", { status: 200 })
    }) as any)
    await relay.getToken()
    const send = (relay as any).send.bind(relay)
    await send(Buffer.alloc(500), "tok")
    expect(calls.filter((c) => c.includes("/llm/upload/")).length).toBe(0)
    expect(calls.some((c) => c.endsWith("/llm/v1/chat/completions"))).toBe(true)
  })

  // 2026-09-21, debrief5.md §8.5. STREAM_STALL_MS guards the body once it is
  // flowing. Nothing guarded the wait for headers, and doFetch carried no
  // signal, so an upstream that simply never answered hung forever: two turns
  // in one session ran 81 and 213 minutes and ended only when the app
  // reconnected. 4h54m of a 10h session, looking from the outside exactly like
  // an agent that had stopped working.
  describe("an upstream that never answers", () => {
    // The deadline itself is ten minutes, so rather than wait it out the test
    // aborts the very signal the relay armed. If the request carries no
    // signal, there is nothing to abort and this hangs — which is the bug.
    test("carries a signal that actually ends the request", async () => {
      let captured: AbortSignal | undefined
      const relay = makeRelay((async (url: any, init: any) => {
        const u = String(url)
        if (u.endsWith("/llm/config")) return new Response(JSON.stringify({ chunk_size: 12000 }))
        if (u.endsWith("/llm/token")) return new Response(JSON.stringify({ token: "tok", expires_at: 2_000 }))
        captured = init?.signal
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal.reason))
        })
      }) as any)
      await relay.getToken()

      const send = (relay as any).send.bind(relay)
      const pending = send(Buffer.alloc(500), "tok")
      await Promise.resolve()
      expect(captured).toBeInstanceOf(AbortSignal)
      ;(captured as any)?.dispatchEvent?.(new Event("abort"))

      const failed = await Promise.race([
        pending.then(
          () => "resolved",
          () => "rejected",
        ),
        new Promise((r) => setTimeout(() => r("still-hanging"), 500)),
      ])
      expect(failed).not.toBe("still-hanging")
    })

    test("passes a signal on the chunk-upload legs too", async () => {
      const signalled: boolean[] = []
      const relay = makeRelay((async (url: any, init: any) => {
        const u = String(url)
        if (u.endsWith("/llm/config")) return new Response(JSON.stringify({ chunk_size: 1000 }))
        if (u.endsWith("/llm/token")) return new Response(JSON.stringify({ token: "tok", expires_at: 2_000 }))
        signalled.push(Boolean(init?.signal))
        if (u.includes("/llm/upload/")) return new Response(JSON.stringify({ bytes_received: 1 }))
        return new Response("{}")
      }) as any)
      await relay.getToken()

      const send = (relay as any).send.bind(relay)
      // Comfortably over the built-in chunk size, so the upload legs run: a
      // hang there strands the turn just as thoroughly as one on completion.
      await send(Buffer.alloc(40_000), "tok")
      expect(signalled.length).toBeGreaterThan(1)
      expect(signalled.every(Boolean)).toBe(true)
    })

    test("the header deadline leaves room for the slowest healthy first token", () => {
      // 550 s was the slowest real first-token wait; the guard must sit above
      // it, and above the stream guard so the right leg names the failure.
      expect(UPSTREAM_HEADERS_MS).toBeGreaterThan(550_000)
      expect(UPSTREAM_HEADERS_MS).toBeGreaterThan(STREAM_STALL_MS)
    })
  })

  test("large bodies are uploaded in chunks then triggered by upload id", async () => {
    const uploads: string[] = []
    let triggeredWithUploadId = false
    const relay = makeRelay((async (url: any, init: any) => {
      const u = String(url)
      if (u.endsWith("/llm/config")) return new Response(JSON.stringify({ chunk_size: 1000 }))
      if (u.endsWith("/llm/token")) return new Response(JSON.stringify({ token: "tok", expires_at: 2_000 }))
      if (u.includes("/llm/upload/")) {
        uploads.push(u)
        return new Response(JSON.stringify({ bytes_received: 1 }))
      }
      if (init?.headers?.["X-1CCoder-Upload-Id"]) triggeredWithUploadId = true
      return new Response("{}")
    }) as any)
    ;(relay as any).chunkSize = 1000
    const send = (relay as any).send.bind(relay)
    await send(Buffer.alloc(5500), "tok")
    expect(uploads.length).toBe(6)
    expect(triggeredWithUploadId).toBe(true)
  })

  test("a failed chunk aborts rather than triggering an incomplete completion", async () => {
    let triggered = false
    const relay = makeRelay((async (url: any, init: any) => {
      const u = String(url)
      if (u.includes("/llm/upload/")) return new Response("nope", { status: 500 })
      if (init?.headers?.["X-1CCoder-Upload-Id"]) triggered = true
      return new Response("{}")
    }) as any)
    ;(relay as any).chunkSize = 1000
    const response = await (relay as any).send.bind(relay)(Buffer.alloc(5000), "tok")
    expect(response.status).toBe(500)
    expect(triggered).toBe(false)
  })

  test("returns no token when the user is signed out", async () => {
    const relay = new LlmRelay({
      getCredential: async () => null,
      baseUrl: "https://auth.example.test",
      fetchImpl: (async () => new Response("{}")) as any,
    })
    expect(await relay.getToken()).toBeNull()
  })

  test("parallel requests trigger a single token fetch, not one each", async () => {
    let tokenCalls = 0
    const relay = makeRelay((async (url: any) => {
      if (String(url).endsWith("/llm/token")) {
        tokenCalls++
        return new Response(JSON.stringify({ token: "tok", expires_at: 9_999_999 }))
      }
      return new Response("{}")
    }) as any)
    await Promise.all([relay.getToken(), relay.getToken(), relay.getToken()])
    expect(tokenCalls).toBe(1)
  })
})

describe("opencode config directory resolution", () => {
  // Normalise separators without embedding a backslash escape in the test source.
  const norm = (value: string) => value.split(String.fromCharCode(92)).join("/")

  test("honours an explicit OPENCODE_CONFIG_DIR override", () => {
    expect(resolveOpencodeConfigDir({ OPENCODE_CONFIG_DIR: "/custom/dir" } as never)).toBe("/custom/dir")
  })

  test("uses XDG_CONFIG_HOME when set, as the desktop does under TEST_ONBOARDING", () => {
    expect(norm(resolveOpencodeConfigDir({ XDG_CONFIG_HOME: "/xdg" } as never))).toBe("/xdg/opencode")
  })

  test("falls back to ~/.config on every platform, Windows included", () => {
    // Regression guard. An earlier version branched to %APPDATA% on Windows,
    // which wrote a config file the sidecar never reads: the xdg-basedir package
    // opencode depends on resolves to ~/.config regardless of platform.
    const dir = norm(resolveOpencodeConfigDir({ APPDATA: "C:/Users/x/AppData/Roaming" } as never))
    expect(dir).toContain("/.config/opencode")
    expect(dir).not.toContain("AppData")
  })
})


describe("stream termination", () => {
  const encode = (text: string) => new TextEncoder().encode(text)
  const CONTENT = 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n'
  const FINISHED = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
  const DONE = "data: [DONE]\n\n"

  test("the terminator frame ends a stream", () => {
    const watcher = createStreamEndWatcher()
    watcher.observe(encode(CONTENT))
    expect(watcher.ended).toBe(false)
    watcher.observe(encode(DONE))
    expect(watcher.ended).toBe(true)
  })

  test("a string finish_reason ends a stream, a null one does not", () => {
    // Every intermediate chunk carries "finish_reason": null, so a substring
    // test for the key alone would call every stream finished after one chunk.
    const running = createStreamEndWatcher()
    running.observe(encode(CONTENT))
    expect(running.ended).toBe(false)

    const finished = createStreamEndWatcher()
    finished.observe(encode(FINISHED))
    expect(finished.ended).toBe(true)
  })

  test("a terminator split across two reads is still seen", () => {
    const watcher = createStreamEndWatcher()
    watcher.observe(encode(CONTENT + "data: [DO"))
    expect(watcher.ended).toBe(false)
    watcher.observe(encode("NE]\n\n"))
    expect(watcher.ended).toBe(true)
  })

  test("multi-byte content split mid-character does not confuse it", () => {
    const watcher = createStreamEndWatcher()
    const bytes = encode('data: {"choices":[{"delta":{"content":"Выгрузка"}}]}\n\n' + DONE)
    watcher.observe(bytes.slice(0, 40))
    watcher.observe(bytes.slice(40))
    expect(watcher.ended).toBe(true)
  })

  async function relayResponse(upstream: () => Response) {
    const relay = new LlmRelay({
      getCredential: async () => ({ email: "u@e.com", credential: "cred" }),
      baseUrl: "https://auth.example.test",
      now: () => 1_000_000,
      fetchImpl: (async (url: any) => {
        const target = String(url)
        if (target.endsWith("/llm/config")) return new Response(JSON.stringify({ chunk_size: 12000 }))
        if (target.endsWith("/llm/token")) return new Response(JSON.stringify({ token: "tok", expires_at: 2_000 }))
        return upstream()
      }) as any,
    })
    const port = await relay.start()
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [], stream: true }),
      })
      return await response.text()
    } finally {
      await relay.close()
    }
  }

  // One chunk per pull, so an error lands only after the chunks before it have
  // actually reached the relay -- which is what a stream breaking mid-response
  // looks like. Enqueueing everything up front and erroring in the same tick
  // tears the stream down before a single byte is read, which is a different
  // failure and not the one under test.
  function sse(chunks: string[], error?: Error) {
    let index = 0
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (index < chunks.length) {
            controller.enqueue(encode(chunks[index++]))
            return
          }
          if (error) controller.error(error)
          else controller.close()
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    )
  }

  test("a complete stream is passed through untouched", async () => {
    const body = await relayResponse(() => sse([CONTENT, FINISHED, DONE]))
    expect(body).toBe(CONTENT + FINISHED + DONE)
    expect(body).not.toContain("1ccoder_relay")
  })

  test("a stream that ends before its terminator is reported, not swallowed", async () => {
    // The shape a DPI reset leaves behind. Ending the response here without
    // saying anything is what made a dropped answer look like a finished one.
    const body = await relayResponse(() => sse([CONTENT]))
    expect(body).toStartWith(CONTENT)
    expect(body).toContain("The model response ended before it was complete")
    expect(body).toEndWith(DONE)
  })

  test("a stream that breaks mid-response is reported, not swallowed", async () => {
    const body = await relayResponse(() => sse([CONTENT], new Error("connection reset")))
    expect(body).toStartWith(CONTENT)
    expect(body).toContain("The connection to the model dropped mid-response")
    expect(body).toEndWith(DONE)
  })

  test("the server's own error frame is not mistaken for a truncated stream", async () => {
    // The server appends [DONE] to the frames it invents for exactly this
    // reason; without it the relay would stack a second error on top.
    const upstreamError = 'data: {"error": {"message": "Upstream provider error"}}\n\n' + DONE
    const body = await relayResponse(() => sse([CONTENT, upstreamError]))
    expect(body).toBe(CONTENT + upstreamError)
    expect(body).not.toContain("1ccoder_relay")
  })
})


// 2026-09-23, debrief9.md §9.6. The relay allows the upstream 600 s for response
// headers (UPSTREAM_HEADERS_MS) because a cache-missed turn has been measured at
// 550 s. The client waiting on the relay is undici, whose headersTimeout is
// 300 s and which a signal cannot raise -- the same property that broke the
// plugin transport in C2/D1. So the relay's budget was unreachable: every
// first-token wait in the 300-600 s band failed at the client while the relay
// waited inside its own limit. One did, at exactly 300.000 s, mid-run:
//
//   AI_APICallError: Cannot connect to API: Headers Timeout Error
//
// The fix answers the status line before asking the upstream anything, so the
// client's header wait is milliseconds and cannot expire.
describe("when the model takes a long time to say anything", () => {
  const encode = (text: string) => new TextEncoder().encode(text)
  const CONTENT_HI = 'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n'
  const DONE_FRAME = "data: [DONE]\n\n"

  function relay(upstream: () => Promise<Response> | Response) {
    return new LlmRelay({
      getCredential: async () => ({ email: "u@e.com", credential: "cred" }),
      baseUrl: "https://auth.example.test",
      now: () => 1_000_000,
      fetchImpl: (async (url: any) => {
        const target = String(url)
        if (target.endsWith("/llm/config")) return new Response(JSON.stringify({ chunk_size: 12000 }))
        if (target.endsWith("/llm/token")) return new Response(JSON.stringify({ token: "tok", expires_at: 2_000 }))
        return upstream()
      }) as any,
    })
  }

  test("response headers arrive before the upstream has answered", async () => {
    let release: (value: Response) => void = () => {}
    const pending = new Promise<Response>((resolve) => {
      release = resolve
    })
    const instance = relay(() => pending)
    const port = await instance.start()
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [], stream: true }),
      })
      // Headers are here while the upstream call is still outstanding. Before
      // this change, `await fetch` could not return until the upstream did.
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/event-stream")

      release(
        new Response(encode(CONTENT_HI + DONE_FRAME), {
          headers: { "Content-Type": "text/event-stream" },
        }),
      )
      expect(await response.text()).toContain('"content":"hi"')
    } finally {
      await instance.close()
    }
  })

  // The status line is spent, so an upstream failure has to be said in the body
  // -- which is how this relay already reports a stream that breaks or stalls.
  test("an upstream error becomes an in-band frame, not a silent stop", async () => {
    const instance = relay(() => new Response(JSON.stringify({ error: "overloaded" }), { status: 503, headers: { "Content-Type": "application/json" } }))
    const port = await instance.start()
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [], stream: true }),
      })
      expect(response.status).toBe(200)
      const body = await response.text()
      expect(body).toContain("The model service failed (503)")
      expect(body).toContain("overloaded")
      expect(body).toContain("[DONE]")
    } finally {
      await instance.close()
    }
  })

  // A non-streaming request is parsed whole, so committing to 200 early would
  // turn an upstream error into a malformed body. Those keep the real status.
  test("a non-streaming request still gets the upstream status", async () => {
    const instance = relay(() => new Response(JSON.stringify({ error: "nope" }), { status: 400, headers: { "Content-Type": "application/json" } }))
    const port = await instance.start()
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [], stream: false }),
      })
      expect(response.status).toBe(400)
    } finally {
      await instance.close()
    }
  })

  test("only a declared stream is answered early", () => {
    expect(asksForStream(Buffer.from(JSON.stringify({ stream: true })))).toBe(true)
    expect(asksForStream(Buffer.from(JSON.stringify({ stream: false })))).toBe(false)
    expect(asksForStream(Buffer.from(JSON.stringify({ messages: [{ content: "stream" }] })))).toBe(false)
    expect(asksForStream(Buffer.from("not json"))).toBe(false)
  })

  test("the upstream message names the cause the agent has to act on", () => {
    expect(upstreamMessage(401, "")).toContain("not authorised")
    expect(upstreamMessage(429, "")).toContain("rate limiting")
    expect(upstreamMessage(502, "bad gateway")).toContain("bad gateway")
  })
})

describe("stall detection", () => {
  const encode = (text: string) => new TextEncoder().encode(text)
  const CONTENT = 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n'
  // What OpenRouter sends while it waits on an upstream. Bytes on the wire,
  // and the reason a byte-based deadline never fires.
  const KEEPALIVE = ": OPENROUTER PROCESSING\n\n"

  /** A clock the test drives, so no test has to actually wait 210 seconds. */
  function fakeClock(start = 0) {
    let t = start
    return { now: () => t, advance: (ms: number) => (t += ms) }
  }

  test("a data frame refreshes the deadline", () => {
    const clock = fakeClock()
    const stall = createStallWatcher(clock.now)
    clock.advance(100_000)
    stall.observe(encode(CONTENT))
    expect(stall.remaining(STREAM_STALL_MS)).toBe(STREAM_STALL_MS)
  })

  test("a keep-alive comment does NOT refresh the deadline", () => {
    // The whole point. Treating this as progress is what let a dead stream
    // look alive for sixteen minutes.
    const clock = fakeClock()
    const stall = createStallWatcher(clock.now)
    clock.advance(100_000)
    stall.observe(encode(KEEPALIVE))
    expect(stall.remaining(STREAM_STALL_MS)).toBe(STREAM_STALL_MS - 100_000)
  })

  test("endless keep-alives eventually exhaust the budget", () => {
    const clock = fakeClock()
    const stall = createStallWatcher(clock.now)
    for (let i = 0; i < 30; i++) {
      clock.advance(15_000)
      stall.observe(encode(KEEPALIVE))
    }
    expect(stall.remaining(STREAM_STALL_MS)).toBeLessThanOrEqual(0)
  })

  test("a slow but living stream is never declared stalled", () => {
    const clock = fakeClock()
    const stall = createStallWatcher(clock.now)
    // Far longer in total than the budget; no single gap is.
    for (let i = 0; i < 20; i++) {
      clock.advance(60_000)
      stall.observe(encode(CONTENT))
      expect(stall.remaining(STREAM_STALL_MS)).toBeGreaterThan(0)
    }
  })

  test("a data marker split across two reads still counts as progress", () => {
    const clock = fakeClock()
    const stall = createStallWatcher(clock.now)
    clock.advance(50_000)
    stall.observe(encode("dat"))
    stall.observe(encode("a: {}\n\n"))
    expect(stall.remaining(STREAM_STALL_MS)).toBe(STREAM_STALL_MS)
  })

  test("the client budget sits above the server's, so the server names it first", () => {
    // The server applies 180s to its own upstream. If this fired first, every
    // upstream stall would be reported as a client-leg failure and point at
    // the wrong hop.
    expect(STREAM_STALL_MS).toBeGreaterThan(180_000)
  })
})

// failures_to_tools.md G5, T1, T5: plugin requests added through one table
// rather than a handler each.
describe("infobase routes", () => {
  test("a registered path answers with its handler's JSON; an unknown one is 404", async () => {
    const seen: unknown[] = []
    const relay = new LlmRelay({
      getCredential: async () => null,
      infobaseRoutes: {
        "toolkit/gate": async (request) => {
          seen.push(request)
          return { designerBusy: false, port: "up", state: "running" }
        },
      },
    })
    const port = await relay.start()
    try {
      const answer = await fetch(`http://127.0.0.1:${port}/1c/toolkit/gate`, { method: "POST", body: '{"a":1}' })
      expect(await answer.json()).toEqual({ designerBusy: false, port: "up", state: "running" })
      expect(seen).toEqual([{ a: 1 }])

      const missing = await fetch(`http://127.0.0.1:${port}/1c/nothing`, { method: "POST", body: "{}" })
      expect(missing.status).toBe(404)

      const malformed = await fetch(`http://127.0.0.1:${port}/1c/toolkit/gate`, { method: "POST", body: "{" })
      expect(malformed.status).toBe(400)
    } finally {
      await relay.close()
    }
  })
})

describe("provider allowlist for pilot builds", () => {
  test("a pilot build offers our provider only and points the models at it", () => {
    const out = restrictProviders({ model: "opencode/big-pickle", small_model: "opencode/tiny", theme: "x" }, true)
    expect(out.enabled_providers).toEqual([PROVIDER_ID])
    expect(out.model).toBe(`${PROVIDER_ID}/${MODEL_ID}`)
    expect("small_model" in out).toBe(false)
    expect(out.theme).toBe("x")
  })

  test("a pilot build keeps a model that is already ours", () => {
    expect(restrictProviders({ model: `${PROVIDER_ID}/other` }, true).model).toBe(`${PROVIDER_ID}/other`)
  })

  test("a dev build removes the allowlist a pilot build wrote", () => {
    const out = restrictProviders({ enabled_providers: [PROVIDER_ID], model: "m" }, false)
    expect("enabled_providers" in out).toBe(false)
    expect(out.model).toBe("m")
  })

  test("a dev build leaves an allowlist the user wrote alone", () => {
    const mine = { enabled_providers: [PROVIDER_ID, "anthropic"] }
    expect(restrictProviders(mine, false)).toEqual(mine)
  })
})

describe("credits", () => {
  // A relay over a fake server that records what reached it and answers the
  // completion with `completion`.
  function harness(completion: () => Response, config: Record<string, unknown> = { chunk_size: 12000 }) {
    const seen: { url: string; headers: Headers }[] = []
    const balances: unknown[] = []
    const relay = new LlmRelay({
      getCredential: async () => ({ email: "u@e.com", credential: "cred" }),
      baseUrl: "https://auth.example.test",
      onBalance: (balance) => balances.push(balance),
      fetchImpl: (async (url: any, init: any) => {
        const u = String(url)
        seen.push({ url: u, headers: new Headers(init?.headers) })
        if (u.endsWith("/llm/config")) return new Response(JSON.stringify(config))
        if (u.endsWith("/llm/token"))
          return new Response(JSON.stringify({ token: "tok", expires_at: Date.now() / 1000 + 3600 }))
        if (u.endsWith("/llm/balance"))
          return new Response(
            JSON.stringify({ credits_spent: 3.2, credits_limit: 20, credits_left: 16.8, period_end: 1_793_491_200 }),
          )
        return completion()
      }) as any,
    })
    return { relay, seen, balances }
  }

  async function post(port: number, headers: Record<string, string> = {}) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ messages: [], stream: true }),
    })
    return response.text()
  }

  const finished = () =>
    new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      headers: { "content-type": "text/event-stream" },
    })

  test("the session id is passed on to the server", async () => {
    const { relay, seen } = harness(finished)
    const port = await relay.start()
    try {
      await post(port, { "X-Session-Id": "ses_abc" })
      const completion = seen.find((s) => s.url.endsWith("/llm/v1/chat/completions"))
      expect(completion?.headers.get("x-1ccoder-session")).toBe("ses_abc")
    } finally {
      await relay.close()
    }
  })

  test("a spent budget becomes a readable, non-retryable message", async () => {
    const { relay } = harness(
      () =>
        new Response(JSON.stringify({ detail: "x", code: "credits_exhausted", balance: -0.1, period_end: 1_793_491_200 }), {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
    )
    const port = await relay.start()
    try {
      const text = await post(port)
      expect(text).toContain("Кредиты 1CCoder на этот период закончились")
      expect(text).toContain(SUPPORT_CONTACT)
      expect(text).toContain(`"type":"${CREDITS_ERROR_TYPE}"`)
      expect(text).not.toContain("1ccoder_transient")
      expect(text.endsWith("data: [DONE]\n\n")).toBe(true)
    } finally {
      await relay.close()
    }
  })

  test("a 402 without the code is our own key, not the pilot's budget", () => {
    expect(creditsExhaustedMessage(402, '{"error":{"message":"Insufficient credits"}}')).toBeNull()
    expect(creditsExhaustedMessage(500, '{"code":"credits_exhausted"}')).toBeNull()
  })

  test("the balance is re-read once after a burst of requests", async () => {
    const { relay, seen, balances } = harness(finished)
    const port = await relay.start()
    try {
      await post(port)
      await post(port)
      await new Promise((r) => setTimeout(r, BALANCE_REFRESH_MS + 300))
      expect(seen.filter((s) => s.url.endsWith("/llm/balance")).length).toBe(1)
      expect(balances).toEqual([{ spent: 3.2, limit: 20, left: 16.8, periodEnd: 1_793_491_200_000, blocked: false }])
      expect(relay.balance?.left).toBe(16.8)
    } finally {
      await relay.close()
    }
  })

  test("model limits are taken from the server config when it has them", async () => {
    const known = harness(finished, { chunk_size: 12000, model_limits: { context: 200000, output: 32000 } })
    await known.relay.start()
    expect(known.relay.modelLimits).toEqual({ context: 200000, output: 32000 })
    await known.relay.close()

    const unknown = harness(finished, { chunk_size: 12000, model_limits: null })
    await unknown.relay.start()
    expect(unknown.relay.modelLimits).toBeNull()
    await unknown.relay.close()
  })

  test("the provider declares limits only when they are known", () => {
    const withLimits = mergeProviderConfig({}, 1, "m", { context: 200000, output: 32000 }) as any
    expect(withLimits.provider[PROVIDER_ID].models[MODEL_ID].limit).toEqual({ context: 200000, output: 32000 })
    expect("cost" in withLimits.provider[PROVIDER_ID].models[MODEL_ID]).toBe(false)
    const without = mergeProviderConfig({}, 1, "m") as any
    expect("limit" in without.provider[PROVIDER_ID].models[MODEL_ID]).toBe(false)
  })
})

describe("blocked account", () => {
  const BLOCKED_BODY = JSON.stringify({ detail: "This account is blocked", code: "account_blocked" })
  const blockedResponse = () => new Response(BLOCKED_BODY, { status: 403, headers: { "content-type": "application/json" } })

  // A fake server whose block can be lifted mid-test: the token, the
  // completion and the balance all answer from `state.blocked`, as the real
  // server reads the account's status on each of them.
  function harness(state: { blocked: boolean; tokenRefused?: boolean }) {
    const seen: string[] = []
    const balances: { blocked: boolean }[] = []
    const relay = new LlmRelay({
      getCredential: async () => ({ email: "u@e.com", credential: "cred" }),
      baseUrl: "https://auth.example.test",
      onBalance: (balance) => balances.push(balance),
      fetchImpl: (async (url: any) => {
        const u = String(url)
        seen.push(u)
        if (u.endsWith("/llm/config")) return new Response(JSON.stringify({ chunk_size: 12000 }))
        if (u.endsWith("/llm/token")) {
          if (state.blocked && state.tokenRefused) return blockedResponse()
          return new Response(JSON.stringify({ token: "tok", expires_at: Date.now() / 1000 + 3600 }))
        }
        if (u.endsWith("/llm/balance"))
          return new Response(
            JSON.stringify({
              credits_spent: 1,
              credits_limit: 10,
              credits_left: 9,
              period_end: 1_793_491_200,
              status: state.blocked ? "blocked" : "active",
            }),
          )
        if (state.blocked) return blockedResponse()
        return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
          headers: { "content-type": "text/event-stream" },
        })
      }) as any,
    })
    return { relay, seen, balances, completions: () => seen.filter((u) => u.endsWith("/chat/completions")).length }
  }

  async function post(port: number, stream: boolean) {
    return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [], stream }),
    })
  }

  function expectBlockedFrame(text: string) {
    expect(text).toContain(ACCOUNT_BLOCKED_MESSAGE)
    expect(text).toContain(SUPPORT_CONTACT)
    expect(text).toContain(`"type":"${ACCOUNT_BLOCKED_ERROR_TYPE}"`)
    expect(text).not.toContain(TRANSIENT_ERROR_TYPE)
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true)
  }

  test("a streaming request says the account is blocked, once, not retried", async () => {
    const h = harness({ blocked: true })
    const port = await h.relay.start()
    try {
      expectBlockedFrame(await (await post(port, true)).text())
      expect(h.completions()).toBe(1)
    } finally {
      await h.relay.close()
    }
  })

  test("a non-streaming request gets a 403 in the relay's own words", async () => {
    const h = harness({ blocked: true })
    const port = await h.relay.start()
    try {
      const response = await post(port, false)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: { message: ACCOUNT_BLOCKED_MESSAGE, type: ACCOUNT_BLOCKED_ERROR_TYPE } })
    } finally {
      await h.relay.close()
    }
  })

  test("a refused token says blocked, not 'not signed in', and asks no completion", async () => {
    const h = harness({ blocked: true, tokenRefused: true })
    const port = await h.relay.start()
    try {
      const text = await (await post(port, true)).text()
      expectBlockedFrame(text)
      expect(text).not.toContain("not signed in")
      expect(h.completions()).toBe(0)
    } finally {
      await h.relay.close()
    }
  })

  test("the balance note learns of the block, with a token and without one", async () => {
    const withToken = harness({ blocked: true })
    expect((await withToken.relay.refreshBalance())?.blocked).toBe(true)
    const refused = harness({ blocked: true, tokenRefused: true })
    expect((await refused.relay.refreshBalance())?.blocked).toBe(true)
    expect(refused.balances.map((b) => b.blocked)).toEqual([true])
  })

  test("an unblock works on the next request, with no restart or new sign-in", async () => {
    const state = { blocked: true, tokenRefused: true }
    const h = harness(state)
    const port = await h.relay.start()
    try {
      expectBlockedFrame(await (await post(port, true)).text())
      state.blocked = false
      const text = await (await post(port, true)).text()
      expect(text).toContain("finish_reason")
      expect(text).not.toContain(ACCOUNT_BLOCKED_MESSAGE)
      expect((await h.relay.refreshBalance())?.blocked).toBe(false)
    } finally {
      await h.relay.close()
    }
  })

  test("only a 403 with the code is a block", () => {
    expect(isAccountBlocked(403, BLOCKED_BODY)).toBe(true)
    expect(isAccountBlocked(403, '{"detail":"No active account for this token"}')).toBe(false)
    expect(isAccountBlocked(402, BLOCKED_BODY)).toBe(false)
    expect(isAccountBlocked(403, "<html>Forbidden</html>")).toBe(false)
  })
})

// 2026-10-05, the first clean-machine install: the chunk uploads went through,
// the final POST never reached the server, and fetch threw. The relay had
// already sent its 200, so the throw ended the response bare: an empty stream,
// which opencode reported as an answerless step twice over, with the network
// error logged nowhere.
describe("a model request that never gets an answer", () => {
  const networkError = () =>
    new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) })

  function relay(onCompletion: () => Promise<Response>, logged: string[] = []) {
    return new LlmRelay({
      getCredential: async () => ({ email: "u@e.com", credential: "cred" }),
      baseUrl: "https://auth.example.test",
      now: () => 1_000_000,
      log: (message, extra) => void logged.push(`${message} ${JSON.stringify(extra ?? {})}`),
      fetchImpl: (async (url: any) => {
        const target = String(url)
        if (target.endsWith("/llm/config")) return new Response(JSON.stringify({ chunk_size: 1000 }))
        if (target.endsWith("/llm/token")) return new Response(JSON.stringify({ token: "tok", expires_at: 2_000 }))
        if (target.includes("/llm/upload/")) return new Response(JSON.stringify({ bytes_received: 1 }))
        return onCompletion()
      }) as any,
    })
  }

  async function ask(instance: LlmRelay, bytes: number) {
    const port = await instance.start()
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(bytes) }], stream: true }),
      })
      return { status: response.status, body: await response.text() }
    } finally {
      await instance.close()
    }
  }

  test("is said in the stream, as transient, with the network's own reason", async () => {
    const logged: string[] = []
    // Over the 1000-byte chunk size: the uploads succeed, the final POST throws.
    const answer = await ask(relay(async () => Promise.reject(networkError()), logged), 5_000)
    expect(answer.status).toBe(200)
    expect(answer.body).toContain(UPSTREAM_UNREACHABLE)
    expect(answer.body).toContain("ECONNRESET")
    expect(answer.body).toContain(TRANSIENT_ERROR_TYPE)
    expect(answer.body).toContain("[DONE]")
    expect(logged.some((line) => line.includes("model request failed before an answer") && line.includes("ECONNRESET"))).toBe(true)
  })

  test("a small request that throws is reported the same way", async () => {
    const answer = await ask(relay(async () => Promise.reject(networkError())), 10)
    expect(answer.body).toContain(UPSTREAM_UNREACHABLE)
  })

  test("the reason names undici's cause, not just 'fetch failed'", () => {
    expect(fetchErrorReason(networkError())).toBe("fetch failed (ECONNRESET: read ECONNRESET)")
    expect(fetchErrorReason(new Error("The model did not respond"))).toBe("The model did not respond")
  })
})
