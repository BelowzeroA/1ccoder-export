import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { closeOutboundCalls } from "./outbound"

const ROOT = mkdtempSync(join(tmpdir(), "1ccoder-outbound-"))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

test("share and the catalog fetch are switched off, and the bundled rg goes first on PATH", () => {
  const resourcesPath = join(ROOT, "packaged")
  mkdirSync(join(resourcesPath, "bin"), { recursive: true })
  writeFileSync(join(resourcesPath, "bin", "rg.exe"), "")
  const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows" }
  const bin = closeOutboundCalls(env, { packaged: true, resourcesPath, appPath: "unused" })
  expect(bin).toBe(join(resourcesPath, "bin"))
  expect(env.OPENCODE_DISABLE_SHARE).toBe("1")
  expect(env.OPENCODE_DISABLE_MODELS_FETCH).toBe("1")
  expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1")
  expect(env.PATH).toBe(`${bin}${delimiter}C:\\Windows`)
  // A second call (a sidecar restart) does not stack the entry.
  closeOutboundCalls(env, { packaged: true, resourcesPath, appPath: "unused" })
  expect(env.PATH).toBe(`${bin}${delimiter}C:\\Windows`)
})

test("without a bundled rg, PATH is left alone", () => {
  const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows" }
  expect(closeOutboundCalls(env, { packaged: false, resourcesPath: "unused", appPath: join(ROOT, "dev") })).toBeNull()
  expect(env.PATH).toBe("C:\\Windows")
  expect(env.OPENCODE_DISABLE_SHARE).toBe("1")
})
