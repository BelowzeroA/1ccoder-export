import { describe, expect, test } from "bun:test"

import { mergeAgentConfig, NOPROFILE_AGENT, PROFILE_AGENT } from "../skills/agents"
import { buildToolkitArgs, MCP_CLIENT_NAME, MCP_PORT, startupParameter, toolkitCandidates } from "./toolkit"

// Windows paths are what this actually runs on, but the separator is chosen per
// directory, so forward slashes exercise the same code without a wall of
// escaping in the expectations.
const profile = {
  kind: "file" as const,
  filePath: "D:/bases/acc",
  workingDirectory: "D:/stage",
  userName: "Administrator",
}

describe("toolkitCandidates", () => {
  test("prefers the config directory, then the profile, then the infobase and its parent", () => {
    expect(toolkitCandidates({ configDir: "C:/cfg", profile })).toEqual([
      "C:/cfg/1ccoder-mcp/MCP_Toolkit.epf",
      "D:/stage/MCP_Toolkit.epf",
      "D:/bases/acc/MCP_Toolkit.epf",
      "D:/bases/MCP_Toolkit.epf",
    ])
  })

  test("a server infobase has no directory of its own to search", () => {
    expect(
      toolkitCandidates({
        configDir: "C:/cfg",
        profile: {
          kind: "server",
          serverCluster: "srv",
          serverDatabase: "db",
          workingDirectory: "D:/stage",
          userName: "x",
        },
      }),
    ).toEqual(["C:/cfg/1ccoder-mcp/MCP_Toolkit.epf", "D:/stage/MCP_Toolkit.epf"])
  })

  test("the bundled copy is the last resort, after every copy the user put down", () => {
    const bundled = "C:/Program Files/1CCoder/resources/toolkit/MCP_Toolkit.epf"
    const candidates = toolkitCandidates({ configDir: "C:/cfg", profile, bundled })
    expect(candidates.at(-1)).toBe(bundled)
    expect(candidates.slice(0, -1)).toEqual(toolkitCandidates({ configDir: "C:/cfg", profile }))
  })

  test("the same directory named twice is searched once", () => {
    const candidates = toolkitCandidates({
      configDir: "C:/cfg",
      profile: { ...profile, workingDirectory: "D:/bases/acc" },
    })
    expect(new Set(candidates).size).toBe(candidates.length)
  })
})

describe("buildToolkitArgs", () => {
  test("opens the toolkit in enterprise mode and tells it to start serving", () => {
    expect(buildToolkitArgs({ profile, password: "secret", toolkitPath: "D:/bases/MCP_Toolkit.epf" })).toEqual([
      "ENTERPRISE",
      '/F"D:/bases/acc"',
      '/N"Administrator"',
      '/P"secret"',
      "/Execute",
      '"D:/bases/MCP_Toolkit.epf"',
      `/C"startup;mode=embedded;port=${MCP_PORT}"`,
      "/DisableStartupDialogs",
      "/DisableStartupMessages",
      "/Lru",
    ])
  })

  // 2026-09-23, debrief9.md §9.9c. The toolkit session is where the agent
  // verifies its work. Without /L it inherited the platform's English UI, so a
  // control print of an invoice rendered "31 August 2026" where the user's own
  // session renders "31 августа 2026" -- the agent then had to work out whether
  // that was its own defect. Verification has to happen in the user's locale.
  // The value is attached to the switch, like /N, /P and /C: the process is
  // spawned with windowsVerbatimArguments, so a separate "ru" argument reaches
  // the platform as a stray token. The first version of this passed "/L" and
  // "ru" as two entries and the 2026-09-24 00:15 run proved it inert -- the
  // control print still said "24 September 2026".
  test("pins the session language as one token, not two", () => {
    const args = buildToolkitArgs({ profile, password: "", toolkitPath: "D:/t.epf" })
    expect(args).toContain("/Lru")
    expect(args).not.toContain("/L")
  })

  test("the startup parameter names the embedded transport, not the proxy", () => {
    expect(startupParameter(6003)).toBe("startup;mode=embedded;port=6003")
  })
})

describe("mergeAgentConfig", () => {
  test("declares the toolkit as a remote MCP server", () => {
    const mcp = mergeAgentConfig({}, "C:/skills").mcp as Record<string, unknown>
    expect(mcp[MCP_CLIENT_NAME]).toEqual({
      type: "remote",
      url: `http://127.0.0.1:${MCP_PORT}/mcp`,
      enabled: true,
    })
  })

  test("keeps servers the user configured themselves", () => {
    const existing = { mcp: { mine: { type: "remote", url: "http://example" } } }
    const mcp = mergeAgentConfig(existing, "C:/skills").mcp as Record<string, unknown>
    expect(Object.keys(mcp).sort()).toEqual([MCP_CLIENT_NAME, "mine"])
  })

  test("only a session with a profile may call its tools", () => {
    const agent = mergeAgentConfig({}, "C:/skills").agent as Record<string, { permission: Record<string, unknown> }>
    expect(agent[NOPROFILE_AGENT].permission[`${MCP_CLIENT_NAME}_*`]).toBe("deny")
    expect(agent[PROFILE_AGENT].permission[`${MCP_CLIENT_NAME}_*`]).toBeUndefined()
  })
})
