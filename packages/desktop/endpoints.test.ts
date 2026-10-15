import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readEndpoints } from "./endpoints"

// The backend is a build-time choice: the same client builds against any service
// that implements the API, and a build that names none must not get as far as a
// user's first sign-in.

const KEYS = ["ONECCODER_SERVER_URLS", "ONECCODER_UPDATES_URL", "ONECCODER_SUPPORT_CONTACT"]
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
const dirs: string[] = []

function envDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "endpoints-"))
  dirs.push(dir)
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  // bun test fills these from .env.test; each case starts from nothing.
  for (const key of KEYS) delete process.env[key]
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe("the build's endpoints", () => {
  test("come from .env.<mode>, in order, without trailing slashes; updates default to the first server", () => {
    const dir = envDir({
      ".env.production":
        'ONECCODER_SERVER_URLS=https://a.example/, https://b.example\nONECCODER_SUPPORT_CONTACT="@help"\n',
    })
    expect(readEndpoints("production", dir)).toEqual({
      servers: ["https://a.example", "https://b.example"],
      updatesUrl: "https://a.example/updates",
      support: "@help",
    })
  })

  test("the environment wins over the files, and the mode picks the file", () => {
    const dir = envDir({
      ".env.production": "ONECCODER_SERVER_URLS=https://prod.example\nONECCODER_SUPPORT_CONTACT=x\n",
      ".env.development": "ONECCODER_SERVER_URLS=https://dev.example\nONECCODER_SUPPORT_CONTACT=x\n",
    })
    expect(readEndpoints("development", dir).servers).toEqual(["https://dev.example"])
    process.env.ONECCODER_SERVER_URLS = "https://ci.example"
    process.env.ONECCODER_UPDATES_URL = "https://cdn.example/feed/"
    expect(readEndpoints("production", dir)).toMatchObject({
      servers: ["https://ci.example"],
      updatesUrl: "https://cdn.example/feed",
    })
  })

  test("a build without a server or a support contact stops, naming what is missing", () => {
    const dir = envDir({ ".env.production": "# nothing yet\n" })
    expect(() => readEndpoints("production", dir)).toThrow(/ONECCODER_SERVER_URLS and ONECCODER_SUPPORT_CONTACT/)
  })

  test("a server that is not an http(s) URL stops the build", () => {
    const dir = envDir({ ".env.production": "ONECCODER_SERVER_URLS=api.example\nONECCODER_SUPPORT_CONTACT=x\n" })
    expect(() => readEndpoints("production", dir)).toThrow(/not an http\(s\) URL/)
  })
})
