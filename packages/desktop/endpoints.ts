// The service this build talks to, read at BUILD time and baked into the app.
//
// Every address of the backend, the support contact shown in refusals, and the
// update feed come from here, so the same client builds against any service
// that implements the 1CCoder API. Nothing is read at run time: an installed
// app can't be pointed elsewhere by a user's environment.
//
// Sources, first wins: the process environment, then `.env.<mode>.local`,
// `.env.<mode>`, `.env.local`, `.env` in packages/desktop. `mode` is
// "development" for `electron-vite dev`, "production" for builds, "test" for
// bun test. `.env.example` lists the variables.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export interface Endpoints {
  /** Base URLs of the service, most preferred first; the client fails over down the list. */
  readonly servers: readonly string[]
  /** The update feed's base; the channel's directory is appended. */
  readonly updatesUrl: string
  /** Where refusals and the sign-in screen send the user, e.g. a Telegram handle or an e-mail. */
  readonly support: string
}

const KEYS = ["ONECCODER_SERVER_URLS", "ONECCODER_UPDATES_URL", "ONECCODER_SUPPORT_CONTACT"] as const

// `dir` defaults to the working directory, as the build configs' other relative
// paths do: both electron-vite and electron-builder run from packages/desktop.
export function readEndpoints(mode: string, dir: string = process.cwd()): Endpoints {
  const files = [`.env.${mode}.local`, `.env.${mode}`, ".env.local", ".env"].map((name) =>
    parseEnvFile(join(dir, name)),
  )
  const value = (key: (typeof KEYS)[number]) =>
    process.env[key]?.trim() ||
    files.map((file) => file[key]).find((found) => found !== undefined && found !== "") ||
    ""
  const servers = value("ONECCODER_SERVER_URLS")
    .split(",")
    .map((url) => url.trim().replace(/\/+$/, ""))
    .filter(Boolean)
  const support = value("ONECCODER_SUPPORT_CONTACT")
  const missing = [
    ...(servers.length ? [] : ["ONECCODER_SERVER_URLS"]),
    ...(support ? [] : ["ONECCODER_SUPPORT_CONTACT"]),
  ]
  if (missing.length) {
    throw new Error(
      `${missing.join(" and ")} not set for mode "${mode}". Set them in the environment or in ` +
        `packages/desktop/.env.${mode} (see .env.example).`,
    )
  }
  const bad = servers.find((url) => !/^https?:\/\/[^/\s]+/.test(url))
  if (bad) throw new Error(`ONECCODER_SERVER_URLS: "${bad}" is not an http(s) URL.`)
  return {
    servers,
    updatesUrl: (value("ONECCODER_UPDATES_URL") || `${servers[0]}/updates`).replace(/\/+$/, ""),
    support,
  }
}

/** KEY=value lines; # comments, blank lines and surrounding quotes allowed. */
function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const at = line.indexOf("=")
        return [
          line.slice(0, at).trim(),
          line
            .slice(at + 1)
            .trim()
            .replace(/^(["'])(.*)\1$/, "$2"),
        ]
      }),
  )
}
