import { afterAll, describe, expect, test } from "bun:test"

import { routeAgent } from "./agent-routing"
import { InfobasePlugin } from "./plugin"
import { DEFAULT_AGENT, NOPROFILE_AGENT, packAgentName, PROFILE_AGENT } from "../skills/agents"
import { PACKS } from "../skills/packs"

// debrief14.md §14.6: four days of sessions ran as `build` while the session
// record said otherwise.

const PACK = PACKS[0]
const PACK_AGENT = packAgentName(PACK)
const PACK_CONFIGURATION = PACK.configurations[0]
const ALL = new Set([DEFAULT_AGENT, "plan", PROFILE_AGENT, PACK_AGENT, NOPROFILE_AGENT])

describe("the rule", () => {
  test("a prompt on the default agent runs as the binding's agent", () => {
    expect(routeAgent(DEFAULT_AGENT, { ok: true }, ALL)).toEqual({ kind: "switch", from: DEFAULT_AGENT, to: PROFILE_AGENT })
    expect(routeAgent(undefined, { ok: true }, ALL)).toEqual({ kind: "switch", from: DEFAULT_AGENT, to: PROFILE_AGENT })
    expect(routeAgent(DEFAULT_AGENT, { ok: false, reason: "no-profile" }, ALL)).toEqual({
      kind: "switch",
      from: DEFAULT_AGENT,
      to: NOPROFILE_AGENT,
    })
  })

  test("a configuration with a pack gets the pack's agent, also from the generic one", () => {
    const binding = { ok: true, configuration: { name: PACK_CONFIGURATION } } as const
    expect(routeAgent(DEFAULT_AGENT, binding, ALL)).toMatchObject({ kind: "switch", to: PACK_AGENT })
    expect(routeAgent(PROFILE_AGENT, binding, ALL)).toMatchObject({ kind: "switch", to: PACK_AGENT })
    expect(routeAgent(PACK_AGENT, binding, ALL)).toEqual({ kind: "keep" })
  })

  test("an agent somebody chose on purpose stays", () => {
    expect(routeAgent("plan", { ok: true }, ALL)).toEqual({ kind: "keep" })
    expect(routeAgent("explore", { ok: false, reason: "no-profile" }, ALL)).toEqual({ kind: "keep" })
  })

  test("no answer, or a deleted profile, changes nothing", () => {
    expect(routeAgent(DEFAULT_AGENT, undefined, ALL)).toEqual({ kind: "keep" })
    expect(routeAgent(DEFAULT_AGENT, { ok: false, reason: "profile-missing" }, ALL)).toEqual({ kind: "keep" })
  })

  test("never onto an agent the sidecar doesn't have", () => {
    expect(routeAgent(DEFAULT_AGENT, { ok: true }, new Set([DEFAULT_AGENT]))).toEqual({
      kind: "missing",
      from: DEFAULT_AGENT,
      wanted: PROFILE_AGENT,
    })
    expect(routeAgent(DEFAULT_AGENT, { ok: true }, undefined)).toEqual({ kind: "keep" })
  })
})

// Through the real plugin: a fake relay answers the binding, a stand-in client
// lists the agents and takes the log.
let profileAnswer: Record<string, unknown> = { ok: true }
const relay = Bun.serve({
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname === "/1c/profile") return Response.json(profileAnswer)
    return new Response("", { status: 404 })
  },
})
afterAll(() => relay.stop(true))

describe("chat.message, through the plugin", () => {
  function fakeClient(agents: string[] | null) {
    const logs: { service?: string; level: string; message: string }[] = []
    const client = {
      app: {
        agents: async () => (agents ? { data: agents.map((name) => ({ name })) } : { data: undefined }),
        log: async ({ body }: { body: { service?: string; level: string; message: string } }) => {
          logs.push(body)
          return { data: true }
        },
      },
    }
    return { client, logs }
  }

  async function send(client: unknown, agent: string) {
    // oxlint-disable-next-line typescript/no-explicit-any -- only `client` is read from the input here
    const hooks = await InfobasePlugin({ client } as any, { baseUrl: `http://127.0.0.1:${relay.port}` })
    const output = { message: { id: "msg", sessionID: "ses", role: "user", agent }, parts: [] }
    // oxlint-disable-next-line typescript/no-explicit-any -- the message shape opencode passes, trimmed
    await hooks["chat.message"]!({ sessionID: "ses", agent } as any, output as any)
    return output.message.agent
  }

  test("a bound session prompted as build runs as the pack's agent, and it is logged", async () => {
    profileAnswer = { ok: true, workingDirectory: "C:\\w", configuration: { name: PACK_CONFIGURATION } }
    const { client, logs } = fakeClient([...ALL])
    expect(await send(client, DEFAULT_AGENT)).toBe(PACK_AGENT)
    expect(logs).toEqual([
      // debrief15.md §15.28: `extra` is what the server writes, so it carries the name.
      { service: "1ccoder-routing", level: "info", message: `session ses: build -> ${PACK_AGENT}`, extra: { service: "1ccoder-routing" } },
    ])
  })

  test("a session without a profile runs as the noprofile agent", async () => {
    profileAnswer = { ok: false, reason: "no-profile" }
    expect(await send(fakeClient([...ALL]).client, DEFAULT_AGENT)).toBe(NOPROFILE_AGENT)
  })

  test("plan stays plan", async () => {
    profileAnswer = { ok: true }
    expect(await send(fakeClient([...ALL]).client, "plan")).toBe("plan")
  })

  test("agents missing from the sidecar: the turn keeps its agent, and a warning is logged", async () => {
    profileAnswer = { ok: true }
    const { client, logs } = fakeClient([DEFAULT_AGENT])
    expect(await send(client, DEFAULT_AGENT)).toBe(DEFAULT_AGENT)
    expect(logs[0]?.level).toBe("warn")
  })

  test("the agent list unreadable: nothing is switched", async () => {
    profileAnswer = { ok: true }
    expect(await send(fakeClient(null).client, DEFAULT_AGENT)).toBe(DEFAULT_AGENT)
  })
})
