import { describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { fetchOnFreshConnection } from "./fresh-connection"
import { fetchErrorReason } from "./relay"

async function serve(handler: Parameters<typeof createServer>[1]) {
  const server: Server = createServer(handler)
  let connections = 0
  server.on("connection", () => void connections++)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    base,
    connections: () => connections,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe("fetchOnFreshConnection", () => {
  // The whole point: the DPI counts bytes per connection, so a chunked
  // request must never share one.
  test("every request opens a connection of its own", async () => {
    const server = await serve((req, res) => {
      req.resume()
      req.on("end", () => res.end("ok"))
    })
    try {
      for (let i = 0; i < 4; i++) {
        const response = await fetchOnFreshConnection(`${server.base}/llm/upload/x/${i}`, {
          method: "POST",
          body: new Uint8Array(12_000),
        })
        expect(await response.text()).toBe("ok")
      }
      expect(server.connections()).toBe(4)
    } finally {
      await server.close()
    }
  })

  test("delivers the body and headers, and a bodiless POST says so", async () => {
    const seen: Array<{ length: string | undefined; auth: string | undefined; bytes: number }> = []
    const server = await serve((req, res) => {
      let bytes = 0
      req.on("data", (chunk: Buffer) => void (bytes += chunk.length))
      req.on("end", () => {
        seen.push({ length: req.headers["content-length"], auth: req.headers.authorization, bytes })
        res.end()
      })
    })
    try {
      await fetchOnFreshConnection(`${server.base}/a`, {
        method: "POST",
        headers: { Authorization: "Bearer tok" },
        body: new Uint8Array(500),
      })
      await fetchOnFreshConnection(`${server.base}/b`, { method: "POST", headers: { "X-1CCoder-Upload-Id": "u1" } })
      expect(seen).toEqual([
        { length: "500", auth: "Bearer tok", bytes: 500 },
        { length: "0", auth: undefined, bytes: 0 },
      ])
    } finally {
      await server.close()
    }
  })

  test("a streamed answer can be read as it arrives", async () => {
    const server = await serve((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      res.write("data: one\n\n")
      setTimeout(() => res.end("data: [DONE]\n\n"), 20)
    })
    try {
      const response = await fetchOnFreshConnection(`${server.base}/stream`)
      expect(response.headers.get("content-type")).toBe("text/event-stream")
      expect(await response.text()).toBe("data: one\n\ndata: [DONE]\n\n")
    } finally {
      await server.close()
    }
  })

  test("a network failure looks like fetch's, with the code in its cause", async () => {
    const server = await serve(() => {})
    const base = server.base
    await server.close()
    const error = await fetchOnFreshConnection(`${base}/gone`).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(TypeError)
    expect(fetchErrorReason(error)).toContain("ECONNREFUSED")
  })

  test("an abort rejects with the signal's own reason", async () => {
    const server = await serve(() => {})
    try {
      const controller = new AbortController()
      const pending = fetchOnFreshConnection(`${server.base}/slow`, { signal: controller.signal })
      setTimeout(() => controller.abort(new Error("The model did not respond")), 20)
      expect(await pending.then(() => "resolved", (e: Error) => e.message)).toBe("The model did not respond")
    } finally {
      await server.close()
    }
  })
})
