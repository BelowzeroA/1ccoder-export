import { describe, expect, test } from "bun:test"

import { MCP_PORT } from "./toolkit"
import { FIRST_PROFILE_PORT, LAST_PROFILE_PORT, ToolkitPorts } from "./toolkit-ports"

function ports(initial: Record<string, number> = {}) {
  const saved: Record<string, number>[] = []
  const store = new ToolkitPorts({ load: () => ({ ...initial }), save: (next) => void saved.push({ ...next }) })
  return { store, saved }
}

describe("each profile's toolkit port", () => {
  test("two profiles get two ports, neither of them the shared MCP_PORT", () => {
    const { store } = ports()
    const a = store.portFor("a")
    const b = store.portFor("b")
    expect(a).not.toBe(b)
    expect([a, b]).not.toContain(MCP_PORT)
    expect(a).toBe(FIRST_PROFILE_PORT)
  })

  test("a port once given is kept, and saved so it survives a restart", () => {
    const { store, saved } = ports()
    const first = store.portFor("a")
    expect(store.portFor("a")).toBe(first)
    expect(saved).toEqual([{ a: first }])
    expect(ports(saved[0]).store.portFor("a")).toBe(first)
  })

  test("a freed gap is reused, not skipped", () => {
    const { store } = ports({ a: FIRST_PROFILE_PORT + 1 })
    expect(store.portFor("b")).toBe(FIRST_PROFILE_PORT)
  })

  test("stored values outside the range are ignored", () => {
    const { store } = ports({ a: MCP_PORT, b: 80, c: Number.NaN })
    expect(store.portFor("a")).toBe(FIRST_PROFILE_PORT)
  })

  test("past the range, new profiles share the last port rather than fail", () => {
    const full = Object.fromEntries(
      Array.from({ length: LAST_PROFILE_PORT - FIRST_PROFILE_PORT + 1 }, (_, i) => [`p${i}`, FIRST_PROFILE_PORT + i]),
    )
    expect(ports(full).store.portFor("late")).toBe(LAST_PROFILE_PORT)
  })
})
