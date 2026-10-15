import { describe, expect, test } from "bun:test"

import {
  checkPluginRegistration,
  EXPECTED_PLUGIN_TOOLS,
  REGISTRATION_POLL_MS,
  REGISTRATION_WAIT_MS,
  registrationNotice,
  waitForPluginRegistration,
} from "./registration"

// 2026-09-23, debrief8.md §E7. The plugin was rejected at sidecar start and the
// only record was a log line. A session then ran six hours with no `1c_*` tools
// and, with them, no permission gate, no bulk-write refusal and no support
// guard -- while the agent rebuilt the channel to the base by hand and every
// step looked like competent engineering.

const ALL = [...EXPECTED_PLUGIN_TOOLS, "bash", "read", "edit"]

function sidecar(body: string | null) {
  return { get: async () => body }
}

describe("when the plugin registered", () => {
  test("a plain id array is accepted", async () => {
    const verdict = await checkPluginRegistration(sidecar(JSON.stringify(ALL)))
    expect(verdict.ok).toBe(true)
    expect(verdict.missing).toEqual([])
  })

  // The endpoint's shape is not ours; tolerate objects carrying an `id`.
  test("objects with an id field are accepted too", async () => {
    const body = JSON.stringify({ tools: ALL.map((id) => ({ id, description: "…" })) })
    expect((await checkPluginRegistration(sidecar(body))).ok).toBe(true)
  })

  test("nothing is said when all is well", async () => {
    const verdict = await checkPluginRegistration(sidecar(JSON.stringify(ALL)))
    expect(registrationNotice(verdict)).toBeNull()
  })
})

describe("when the plugin was rejected", () => {
  // What 09-23 actually looked like: the built-ins are there, the plugin's are not.
  const body = JSON.stringify(["bash", "read", "edit", "grep", "1c_execute_code"])

  test("every expected tool is reported missing", async () => {
    const verdict = await checkPluginRegistration(sidecar(body))
    expect(verdict.checked).toBe(true)
    expect(verdict.ok).toBe(false)
    expect(verdict.missing).toEqual([...EXPECTED_PLUGIN_TOOLS])
  })

  // `1c_execute_code` comes from the MCP toolkit, not the plugin. Its presence
  // is exactly why the absence is confusing from inside a session: the agent
  // can still write to the base, only without any of the guards.
  test("an MCP toolkit tool does not count as the plugin being present", async () => {
    expect((await checkPluginRegistration(sidecar(body))).registered).toEqual([])
  })

  test("the notice names the tools, the lost guards, and forbids the workaround", async () => {
    const notice = registrationNotice(await checkPluginRegistration(sidecar(body)))!
    expect(notice).toContain("1c_profile_info")
    expect(notice).toContain("подтверждение записи")
    expect(notice).toContain("массовой записи")
    expect(notice).toContain("MCP-клиент")
    expect(notice).toContain("перезапустить")
  })

  test("a partial registration is still a failure", async () => {
    const partial = JSON.stringify(["1c_profile_info", "1c_toolkit_start", "bash"])
    const verdict = await checkPluginRegistration(sidecar(partial))
    expect(verdict.ok).toBe(false)
    expect(verdict.registered).toEqual(["1c_profile_info", "1c_toolkit_start"])
    expect(verdict.missing).toContain("1c_run_epf")
  })
})

// An unreachable or unparseable sidecar is UNKNOWN, not broken. Claiming the
// plugin failed because a probe timed out would be its own false alarm, and a
// false alarm here teaches the user to ignore the real one.
describe("when the sidecar cannot be asked", () => {
  test("an unreachable sidecar reports unchecked, and says nothing", async () => {
    const verdict = await checkPluginRegistration(sidecar(null))
    expect(verdict.checked).toBe(false)
    expect(registrationNotice(verdict)).toBeNull()
  })

  test("a body that is not JSON reports unchecked", async () => {
    const verdict = await checkPluginRegistration(sidecar("<html>401</html>"))
    expect(verdict.checked).toBe(false)
    expect(registrationNotice(verdict)).toBeNull()
  })

  test("a throwing transport does not throw out of the check", async () => {
    const verdict = await checkPluginRegistration({
      get: async () => {
        throw new Error("ECONNREFUSED")
      },
    })
    expect(verdict.checked).toBe(false)
  })
})

// debrief14.md §14.5: three tools were added to the plugin and not to this list,
// so the toolkit-down guard took `1c_new_extension` for a toolkit tool and
// refused it while the toolkit was stopped. The list has to be the plugin's.
test("the expected list is exactly the plugin's own tools", async () => {
  const { InfobasePlugin } = await import("./plugin")
  // oxlint-disable-next-line typescript/no-explicit-any -- the plugin input is unused when only listing tools
  const hooks = await InfobasePlugin({} as any, { baseUrl: "http://127.0.0.1:1" })
  expect(Object.keys(hooks.tool ?? {}).toSorted()).toEqual([...EXPECTED_PLUGIN_TOOLS].toSorted())
})


// 2026-10-05, SERVER_ST: one 5 s check landed inside a ~10 s sidecar bootstrap.
describe("while the sidecar is still loading plugins", () => {
  // A clock that moves only when the wait sleeps; `answers` is what each ask returns.
  function asked(answers: (string | null)[]) {
    let clock = 0
    let calls = 0
    const deps = {
      get: async () => answers[Math.min(calls++, answers.length - 1)],
      now: () => clock,
      sleep: async (ms: number) => void (clock += ms),
    }
    return { deps, calls: () => calls }
  }
  const all = JSON.stringify([...EXPECTED_PLUGIN_TOOLS])
  const builtInOnly = JSON.stringify(["bash", "read"])

  test("a plugin that registers a few seconds late is reported registered", async () => {
    const { deps, calls } = asked([null, builtInOnly, builtInOnly, all])
    expect((await waitForPluginRegistration(deps)).ok).toBe(true)
    expect(calls()).toBe(4)
  })

  test("one that never registers is reported missing, once the wait is over", async () => {
    const { deps, calls } = asked([builtInOnly])
    const verdict = await waitForPluginRegistration(deps)
    expect(verdict.checked).toBe(true)
    expect(verdict.ok).toBe(false)
    expect(calls()).toBe(Math.floor(REGISTRATION_WAIT_MS / REGISTRATION_POLL_MS) + 1)
  })

  test("a registered plugin is not asked about again", async () => {
    const { deps, calls } = asked([all])
    expect((await waitForPluginRegistration(deps)).ok).toBe(true)
    expect(calls()).toBe(1)
  })
})
