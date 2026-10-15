import { afterAll, describe, expect, test } from "bun:test"

import { InfobasePlugin } from "./plugin"

// 2026-10-13: toolkits are per profile, so the gate must know whose session is
// calling and from which folder. The first version sent the bare session id,
// which matches no binding (they are keyed `session:<id>`): the gate then
// probed whichever profile was asked about last, and the wrong-base refusal
// could never fire. Caught by starting two toolkits through the live relay.

const gates: Record<string, unknown>[] = []
let linkedTo: string | undefined
const relay = Bun.serve({
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === "/1c/toolkit/gate") {
      gates.push((await request.json()) as Record<string, unknown>)
      return Response.json({ designerBusy: false, port: "up", state: "running", ...(linkedTo ? { linkedTo } : {}) })
    }
    return new Response("", { status: 404 })
  },
})
afterAll(() => relay.stop(true))

async function before(tool: string) {
  // oxlint-disable-next-line typescript/no-explicit-any -- only `directory` is read from the input on this path
  const hooks = await InfobasePlugin({ directory: "C:\\Work\\tasks\\stage3" } as any, { baseUrl: `http://localhost:${relay.port}` })
  return hooks["tool.execute.before"]!({ tool, sessionID: "ses_abc", callID: "c" }, { args: { query: "ВЫБРАТЬ 1" } })
}

describe("the gate before a toolkit call", () => {
  test("names the session as bindings key it, and the folder", async () => {
    gates.length = 0
    linkedTo = undefined
    await before("1c_execute_query")
    expect(gates).toEqual([{ conversationId: "session:ses_abc", directory: "C:\\Work\\tasks\\stage3" }])
  })

  test("refuses the call when the folder's tools reach another profile's base", async () => {
    linkedTo = "КА 2 (демо)"
    await expect(before("1c_execute_query")).rejects.toThrow("«КА 2 (демо)»")
    linkedTo = undefined
  })
})
