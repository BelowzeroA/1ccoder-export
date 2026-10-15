// One MCP tool call to the toolkit, from the app itself.
//
// 2026-09-25, skills_rebuild_plan.md Part 2.2. Until now only the sidecar spoke
// to the toolkit's /mcp endpoint -- the app just probed /health. Knowing which
// configuration an infobase runs needs one read-only answer from 1C, and the
// app has to get it without the agent: routing a session to a configuration
// pack cannot depend on the agent choosing to ask.
//
// Deliberately minimal: streamable HTTP, initialize -> initialized -> one
// tools/call, no session reuse. Each call is a few hundred milliseconds against
// a server inside a 1C client, which serves one request at a time; holding a
// session open would only compete with the agent's own.

import { mcpUrl, MCP_PORT } from "./toolkit"

export interface ToolkitCallOptions {
  readonly port?: number
  readonly timeoutMs?: number
  readonly fetch?: typeof fetch
}

const PROTOCOL_VERSION = "2025-03-26"
const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Calls one toolkit tool and returns the text of its result.
 *
 * Throws on any transport or protocol failure, and on a tool-level error
 * (`isError`), with the toolkit's own text -- callers here are background
 * detections that log and move on, so a precise message matters more than a
 * typed one.
 */
export async function callToolkitTool(
  name: string,
  args: Record<string, unknown>,
  options: ToolkitCallOptions = {},
): Promise<string> {
  const url = mcpUrl(options.port ?? MCP_PORT)
  const send = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let session: string | undefined

  const post = async (body: Record<string, unknown>): Promise<unknown> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await send(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(session ? { "Mcp-Session-Id": session } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", ...body }),
        signal: controller.signal,
      })
      session = response.headers.get("mcp-session-id") ?? session
      if (!response.ok && response.status !== 202) throw new Error(`toolkit answered HTTP ${response.status}`)
      // A notification has no reply; the server may answer 202 with no body.
      if (!("id" in body)) return undefined
      return readMessage(await response.text(), response.headers.get("content-type") ?? "")
    } finally {
      clearTimeout(timer)
    }
  }

  await post({
    id: 1,
    method: "initialize",
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "1ccoder-desktop", version: "1" } },
  })
  await post({ method: "notifications/initialized" })
  const reply = (await post({ id: 2, method: "tools/call", params: { name, arguments: args } })) as {
    error?: { message?: string }
    result?: { isError?: boolean; content?: readonly { type?: string; text?: string }[] }
  }
  if (reply?.error) throw new Error(`toolkit refused ${name}: ${reply.error.message ?? "unknown error"}`)
  const text = (reply?.result?.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
  if (reply?.result?.isError) throw new Error(`toolkit ${name} failed: ${text}`)
  return text
}

/**
 * The first line starting with `marker|` anywhere in a tool's text result.
 *
 * 2026-09-25, observed live on MCP_Toolkit.epf: `execute_code` wraps the
 * result as `{ "success": true, "data": … }`, and `data` is itself a
 * JSON-encoded string -- `"\"marker|…|File=\\\"C:\\\\…\\\";\""`. Unwrapping one
 * layer and cutting at the marker leaves the second layer's quotes and escapes
 * in the value, which turned the profile's own connection string into one that
 * matched nothing. So every string that is itself JSON is decoded again, until
 * what is left is plain text.
 */
export function findMarkedLine(text: string, marker: string): string | undefined {
  const needle = `${marker}|`
  const walk = (value: unknown, depth: number): string | undefined => {
    if (depth > 5) return undefined
    if (typeof value === "string") {
      const nested = parseJson(value)
      if (nested !== undefined && nested !== value) return walk(nested, depth + 1)
      const at = value.indexOf(needle)
      return at < 0 ? undefined : value.slice(at).split(/\r?\n/)[0]
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1)).find(Boolean)
    if (value && typeof value === "object") return Object.values(value).map((item) => walk(item, depth + 1)).find(Boolean)
    return undefined
  }
  return walk(text, 0)
}

function parseJson(value: string): unknown {
  const trimmed = value.trim()
  if (!/^["{[]/.test(trimmed)) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/** The JSON-RPC message in a reply, whether it came as plain JSON or as an SSE stream. */
function readMessage(body: string, contentType: string): unknown {
  if (!contentType.includes("text/event-stream")) return body ? JSON.parse(body) : undefined
  const messages = body
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n"),
    )
    .filter(Boolean)
    .map((data) => JSON.parse(data) as { id?: unknown })
  // The stream may carry notifications before the reply; the reply has an id.
  return messages.find((message) => message.id !== undefined) ?? messages.at(-1)
}
