// fetch, but every request on a TCP connection of its own.
//
// 2026-10-05, measured from SERVER_ST: the DPI in front of our host now counts
// uploaded bytes per *connection*, not per request as it did in September
// (SYSTEM-REFERENCE.md §7.1). On one keep-alive connection the second 12 KB
// chunk stalled for 21.8 s and failed; with a new connection per request all
// four chunks and the final POST went through and the model answered. Node's
// fetch pools connections and has no per-request way to opt out without the
// undici package, so this goes through node:https with `agent: false`, which
// opens a socket for the request and closes it after.
//
// It costs a TLS handshake per request -- about half a second from Russia, a
// couple of seconds on a four-chunk turn -- against a turn that otherwise never
// arrives.

import { request as httpRequest, type IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import { Readable } from "node:stream"

export const fetchOnFreshConnection: typeof fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const method = (init?.method ?? "GET").toUpperCase()
  const body = bodyBytes(init?.body)
  const headers = Object.fromEntries(new Headers(init?.headers).entries())
  if (body || method === "POST" || method === "PUT") headers["content-length"] = String(body?.byteLength ?? 0)
  const signal = init?.signal ?? undefined

  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const send = url.protocol === "http:" ? httpRequest : httpsRequest
    const req = send(url, { method, headers, agent: false }, (res) => resolve(toResponse(res, method)))
    // Shaped like fetch's own failure, so the cause (ECONNRESET, ETIMEDOUT, a
    // TLS error) lands where relay.ts's fetchErrorReason looks for it.
    req.on("error", (error) => reject(signal?.aborted ? signal.reason : new TypeError("fetch failed", { cause: error })))
    // Rejected here rather than through "error": not every runtime emits one
    // for a destroyed request (Bun does not), and a promise settles only once.
    signal?.addEventListener(
      "abort",
      () => {
        reject(signal.reason)
        req.destroy()
      },
      { once: true },
    )
    req.end(body)
  })
}

function bodyBytes(body: BodyInit | null | undefined): Buffer | undefined {
  if (body === null || body === undefined) return undefined
  if (typeof body === "string") return Buffer.from(body)
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  throw new TypeError("fetchOnFreshConnection sends string and byte bodies only")
}

function toResponse(res: IncomingMessage, method: string): Response {
  const headers = new Headers()
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one)
  }
  const status = res.statusCode ?? 502
  const empty = method === "HEAD" || status === 204 || status === 304
  if (empty) res.resume()
  return new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
    status,
    statusText: res.statusMessage,
    headers,
  })
}
