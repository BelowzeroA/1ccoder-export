import { describe, expect, test } from "bun:test"

import { verifyProfile, type PlatformRun, type VerifyDeps } from "./verify"

/**
 * A machine where everything works, with counters so a test can assert what was
 * NOT done -- the point of ordering the checks is that a bad working directory
 * costs nothing, rather than five seconds of platform startup.
 */
function deps(overrides: Partial<VerifyDeps> = {}) {
  const calls = { runPlatform: 0, ensureWritableDir: 0 }
  const base: VerifyDeps = {
    runPlatform: async (): Promise<PlatformRun> => {
      calls.runPlatform++
      return { exitCode: 0, timedOut: false }
    },
    readOut: async () => "Ошибок не обнаружено",
    pathExists: async () => true,
    isFile: async () => true,
    listDir: async () => ["1cv8.exe", "1cv8c.exe"],
    probeTcp: async () => true,
    ensureWritableDir: async () => {
      calls.ensureWritableDir++
      return "ok"
    },
    tempDir: async () => "C:\\temp\\probe",
    cleanup: async () => undefined,
  }
  return { deps: { ...base, ...overrides }, calls }
}

const input = {
  platformPath: "D:\\bin\\1cv8.exe",
  kind: "file" as const,
  filePath: "D:\\Bases\\Acc",
  workingDirectory: "D:\\Work\\Acc",
  userName: "Администратор",
  password: "",
}

describe("working directory check", () => {
  test("passes when the directory is already usable", async () => {
    const { deps: d } = deps()
    const result = await verifyProfile(input, d)
    const workspace = result.checks.find((check) => check.id === "workspace")
    expect(workspace?.status).toBe("pass")
    expect(workspace?.code).toBe("workspace-ok")
    expect(result.ok).toBe(true)
  })

  test("says so when it had to create the directory", async () => {
    const { deps: d } = deps({ ensureWritableDir: async () => "created" })
    const result = await verifyProfile(input, d)
    expect(result.checks.find((check) => check.id === "workspace")?.code).toBe("workspace-created")
    expect(result.ok).toBe(true)
  })

  test("blocks when the directory cannot be created or written to", async () => {
    const { deps: d } = deps({ ensureWritableDir: async () => "failed" })
    const result = await verifyProfile(input, d)
    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === "workspace")?.status).toBe("fail")
  })

  test("blocks on an empty working directory without touching the disk", async () => {
    const { deps: d, calls } = deps()
    const result = await verifyProfile({ ...input, workingDirectory: "   " }, d)
    expect(result.ok).toBe(false)
    expect(calls.ensureWritableDir).toBe(0)
  })

  // The whole reason the workspace check sits before the credential check.
  test("a bad working directory costs no platform launch", async () => {
    const { deps: d, calls } = deps({ ensureWritableDir: async () => "failed" })
    await verifyProfile(input, d)
    expect(calls.runPlatform).toBe(0)
  })

  test("a missing infobase is still caught before the working directory is created", async () => {
    const { deps: d, calls } = deps({ pathExists: async () => false })
    const result = await verifyProfile(input, d)
    expect(result.checks.find((check) => check.id === "infobase")?.status).toBe("fail")
    expect(calls.ensureWritableDir).toBe(0)
  })
})
