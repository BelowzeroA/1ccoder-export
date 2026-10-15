import { describe, expect, test } from "bun:test"

import { CONFIGURATION_CODE, parseProbeReply, probeConfiguration } from "./configuration-probe"
import { callToolkitTool } from "./toolkit-client"

// 2026-09-25, skills_rebuild_plan.md Part 2.2. No 1C here: a fake /mcp
// endpoint that speaks the streamable-HTTP handshake the way a server may --
// plain JSON or an SSE stream, with or without a session id.

type Reply = { json?: unknown; sse?: unknown; status?: number; session?: string }

function fakeToolkit(toolResult: (args: Record<string, unknown>) => Reply) {
  const seen: { method: string; session: string | null; body: any }[] = []
  const send = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    const headers = new Headers(init.headers)
    seen.push({ method: body.method, session: headers.get("mcp-session-id"), body })
    const reply: Reply =
      body.method === "initialize"
        ? { json: { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } }, session: "s-1" }
        : body.method === "notifications/initialized"
          ? { status: 202 }
          : toolResult(body.params.arguments)
    const outHeaders: Record<string, string> = reply.session ? { "mcp-session-id": reply.session } : {}
    if (reply.sse !== undefined) {
      outHeaders["content-type"] = "text/event-stream"
      const events = [
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}`,
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: reply.sse })}`,
      ]
      return new Response(events.join("\n\n") + "\n\n", { status: 200, headers: outHeaders })
    }
    if (reply.status === 202) return new Response(null, { status: 202, headers: outHeaders })
    outHeaders["content-type"] = "application/json"
    return new Response(JSON.stringify(reply.json ?? { jsonrpc: "2.0", id: body.id, result: {} }), {
      status: reply.status ?? 200,
      headers: outHeaders,
    })
  }) as unknown as typeof fetch
  return { send, seen }
}

const text = (value: string) => ({ content: [{ type: "text", text: value }] })
const ANSWER = '1ccoder-configuration|БухгалтерияПредприятия|3.0.205.22|3.1.12.297|File="C:\\Bases\\Acc";'
const profile = { kind: "file" as const, filePath: "C:\\Bases\\Acc" }

describe("the toolkit call", () => {
  test("does the handshake and carries the session id", async () => {
    const toolkit = fakeToolkit(() => ({ json: { jsonrpc: "2.0", id: 2, result: text("ok") } }))
    expect(await callToolkitTool("execute_code", { code: "x" }, { fetch: toolkit.send })).toBe("ok")
    expect(toolkit.seen.map((call) => call.method)).toEqual(["initialize", "notifications/initialized", "tools/call"])
    expect(toolkit.seen[2]!.session).toBe("s-1")
    expect(toolkit.seen[2]!.body.params).toEqual({ name: "execute_code", arguments: { code: "x" } })
  })

  test("reads a reply sent as an event stream, past a notification", async () => {
    const toolkit = fakeToolkit(() => ({ sse: text("streamed") }))
    expect(await callToolkitTool("execute_code", { code: "x" }, { fetch: toolkit.send })).toBe("streamed")
  })

  test("a tool error is an error, with the toolkit's words", async () => {
    const toolkit = fakeToolkit(() => ({
      json: { jsonrpc: "2.0", id: 2, result: { isError: true, ...text("Операция запрещена") } },
    }))
    await expect(callToolkitTool("execute_code", { code: "x" }, { fetch: toolkit.send })).rejects.toThrow(
      "Операция запрещена",
    )
  })
})

describe("the configuration question", () => {
  // Nothing in it may be on the toolkit's refusal list, or the probe would be
  // refused in every base -- see the 1ccoder-ib-mcp skill for the list.
  test("asks nothing the toolkit refuses and writes nothing", () => {
    expect(CONFIGURATION_CODE).not.toMatch(/Записать|Удалить|УстановитьПривилегированныйРежим|(?<!\.)Выполнить\(/)
    expect(CONFIGURATION_CODE).toContain("СтрокаСоединенияИнформационнойБазы()")
  })

  test("the answer is found whether it comes plain or wrapped in JSON", () => {
    expect(parseProbeReply(ANSWER, () => 1)?.configuration).toEqual({
      name: "БухгалтерияПредприятия",
      version: "3.0.205.22",
      bspVersion: "3.1.12.297",
      source: "toolkit",
      detectedAt: 1,
    })
    const wrapped = JSON.stringify({ success: true, data: ANSWER })
    expect(parseProbeReply(wrapped)?.connectionString).toBe('File="C:\\Bases\\Acc";')
  })

  // 2026-09-25, captured live from MCP_Toolkit.epf on a БП 3.0.203.18 base.
  // `data` is a JSON string whose content is itself JSON-encoded; decoding one
  // layer left `\"` and `\\` in the connection string, and the probe rejected
  // the profile's own base as "other-infobase".
  test("the toolkit's double-encoded reply decodes to the plain answer", () => {
    const live =
      '{\n    "success": true,\n    "data": "\\"1ccoder-configuration|БухгалтерияПредприятия|3.0.203.18|3.1.12.268|File=\\\\\\"C:\\\\\\\\Work\\\\\\\\Bases\\\\\\\\demo\\\\\\\\1C\\\\\\\\acc\\\\\\";\\""\n}'
    const probed = parseProbeReply(live)
    expect(probed?.connectionString).toBe('File="C:\\Work\\Bases\\demo\\1C\\acc";')
    expect(probed?.configuration).toMatchObject({
      name: "БухгалтерияПредприятия",
      version: "3.0.203.18",
      bspVersion: "3.1.12.268",
    })
  })

  test("no БСП is an answer, not a failure", () => {
    const probed = parseProbeReply('1ccoder-configuration|МояКонфигурация|1.0||File="C:\\B";')
    expect(probed?.configuration.name).toBe("МояКонфигурация")
    expect(probed?.configuration.bspVersion).toBeUndefined()
  })

  test("is recorded only for the profile's own infobase", async () => {
    const own = fakeToolkit(() => ({ json: { jsonrpc: "2.0", id: 2, result: text(JSON.stringify({ success: true, data: ANSWER })) } }))
    expect(await probeConfiguration(profile, { fetch: own.send })).toMatchObject({ ok: true })

    const other = fakeToolkit(() => ({
      json: { jsonrpc: "2.0", id: 2, result: text(ANSWER.replace("C:\\Bases\\Acc", "C:\\Bases\\Trade")) },
    }))
    expect(await probeConfiguration(profile, { fetch: other.send })).toMatchObject({ ok: false, reason: "other-infobase" })
  })

  test("a toolkit that cannot be reached is a quiet failure", async () => {
    const down = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    expect(await probeConfiguration(profile, { fetch: down })).toMatchObject({ ok: false, reason: "failed" })
  })
})
