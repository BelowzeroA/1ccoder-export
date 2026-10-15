import { describe, expect, test } from "bun:test"

import { linkAction, ToolkitLink } from "./toolkit-link"

describe("linkAction", () => {
  test("connects when the toolkit appears and disconnects when it goes", () => {
    expect(linkAction(false, true)).toBe("connect")
    expect(linkAction(true, false)).toBe("disconnect")
  })

  // Connecting replaces the sidecar's client and re-lists its tools. Doing that
  // on every poll would churn the agent's tool list for no reason.
  test("does nothing while nothing has changed", () => {
    expect(linkAction(true, true)).toBe("none")
    expect(linkAction(false, false)).toBe("none")
  })
})

function spy(health: () => Promise<boolean>, connect?: () => Promise<unknown>) {
  const calls: string[] = []
  const link = new ToolkitLink({
    health,
    connect: () => {
      calls.push("connect")
      return connect ? connect() : Promise.resolve()
    },
    disconnect: () => {
      calls.push("disconnect")
      return Promise.resolve()
    },
  })
  return { link, calls }
}

describe("ToolkitLink", () => {
  test("connects once when the port starts answering", async () => {
    let alive = false
    const { link, calls } = spy(async () => alive)

    expect(await link.sync()).toBe("none")
    alive = true
    expect(await link.sync()).toBe("connect")
    expect(await link.sync()).toBe("none")
    expect(calls).toEqual(["connect"])
    expect(link.connected).toBe(true)
  })

  // The toolkit is a 1C window. It closes, and it comes back -- and a client
  // pointed at a dead port must be replaced rather than kept.
  test("reconnects after the toolkit goes away and returns", async () => {
    let alive = true
    const { link, calls } = spy(async () => alive)

    await link.sync()
    alive = false
    await link.sync()
    alive = true
    await link.sync()
    expect(calls).toEqual(["connect", "disconnect", "connect"])
  })

  // A sidecar that was still starting must not leave the link believing it is
  // connected: the next tick is the retry.
  test("a failed connect is retried rather than remembered as success", async () => {
    let fail = true
    const { link, calls } = spy(
      async () => true,
      () => (fail ? Promise.reject(new Error("not ready")) : Promise.resolve()),
    )

    await expect(link.sync()).rejects.toThrow("not ready")
    expect(link.connected).toBe(false)
    fail = false
    expect(await link.sync()).toBe("connect")
    expect(calls).toEqual(["connect", "connect"])
  })

  // debrief15.md §15.7: the sidecar's connect answered `true` while the connect
  // had failed (the 1C session behind the port was blocked by a window). With
  // the port answering throughout, the link never tried again.
  test("a connect the sidecar only claims is retried until the sidecar really holds a client", async () => {
    let sidecarUp = false
    const calls: string[] = []
    const link = new ToolkitLink({
      health: async () => true,
      connect: async () => void calls.push("connect"),
      disconnect: async () => void calls.push("disconnect"),
      sidecarConnected: async () => sidecarUp,
    })

    expect(await link.sync()).toBe("connect")
    expect(link.connected).toBe(false)
    // The window is closed; the next connect takes.
    expect(await link.sync()).toBe("connect")
    sidecarUp = true
    expect(await link.sync()).toBe("none")
    expect(link.connected).toBe(true)
    expect(calls).toEqual(["connect", "connect"])
  })

  test("a client the sidecar dropped is reconnected while the port answers", async () => {
    let sidecarUp = true
    const calls: string[] = []
    const link = new ToolkitLink({
      health: async () => true,
      connect: async () => {
        calls.push("connect")
        sidecarUp = true
      },
      disconnect: async () => void calls.push("disconnect"),
      sidecarConnected: async () => sidecarUp,
    })

    expect(await link.sync()).toBe("none")
    sidecarUp = false
    expect(await link.sync()).toBe("connect")
    expect(link.connected).toBe(true)
    expect(calls).toEqual(["connect"])
  })

  // The timer and a freshly bound profile land together routinely; two
  // connects in flight would tear down the client the other just built.
  test("concurrent checks share the one in flight", async () => {
    const { link, calls } = spy(async () => true)
    const [first, second] = await Promise.all([link.sync(), link.sync()])
    expect([first, second]).toEqual(["connect", "connect"])
    expect(calls).toEqual(["connect"])
  })

  test("an unreachable probe counts as absent, not as an error", async () => {
    const { link, calls } = spy(() => Promise.reject(new Error("no ipc")))
    expect(await link.sync()).toBe("none")
    expect(calls).toEqual([])
  })
})
