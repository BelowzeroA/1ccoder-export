// The product's own identity: app ids, names and the deep-link scheme.
//
// The app id names the %APPDATA% folder that holds profiles, session bindings
// and the auth credential, so it is fixed once, before pilots install: changing
// it later strands every pilot's profiles in the old folder. The same values
// are repeated in electron-builder.config.ts, which cannot import from here.

import { cpSync, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

export type Channel = "dev" | "beta" | "prod"

export const APP_IDS: Record<Channel, string> = {
  dev: "com.1ccoder.desktop.dev",
  beta: "com.1ccoder.desktop.beta",
  prod: "com.1ccoder.desktop",
}

export const APP_NAMES: Record<Channel, string> = {
  dev: "1CCoder Dev",
  beta: "1CCoder Beta",
  prod: "1CCoder",
}

/** The ids the fork shipped under until 2026-10, inherited from OpenCode. */
export const LEGACY_APP_IDS: Record<Channel, string> = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
}

export const PROTOCOL = "1ccoder"

/** The scheme the shared UI parses (packages/app deep-links.ts). */
const UPSTREAM_PROTOCOL = "opencode"

/**
 * Deep links arrive as 1ccoder://…; the shared UI only parses opencode://…, so
 * the scheme is swapped here rather than in upstream code. Anything else
 * passes through untouched.
 */
export function toUpstreamDeepLink(url: string): string {
  const prefix = `${PROTOCOL}://`
  return url.startsWith(prefix) ? `${UPSTREAM_PROTOCOL}://${url.slice(prefix.length)}` : url
}

export function isDeepLink(arg: string): boolean {
  return arg.startsWith(`${PROTOCOL}://`) || arg.startsWith(`${UPSTREAM_PROTOCOL}://`)
}

/**
 * What the app keeps in userData that is worth carrying over: the electron-store
 * files (profiles, bindings, auth, settings, workspace state), the drafts
 * database, and Chromium's `Local State` and `Local Storage`. `Local State`
 * carries the os_crypt key that safeStorage ciphertexts (profile passwords, the
 * auth credential) are sealed with, so the stores are unreadable without it.
 * Caches, logs and crash dumps are left behind.
 */
function isCarried(name: string): boolean {
  return (
    name.startsWith("1ccoder.") ||
    name.startsWith("opencode.") ||
    name.startsWith("drafts.sqlite") ||
    name === "default.dat" ||
    name === "Local State" ||
    name === "Local Storage"
  )
}

/**
 * Copies the previous identity's userData into the new one, once: only when the
 * new folder holds none of the carried files yet. A copy, not a move, so going
 * back to an older build still finds its data. Must run before anything opens a
 * store under the new folder. Returns the names it copied.
 */
export function adoptPreviousUserData(from: string, to: string): string[] {
  if (!existsSync(from)) return []
  if (existsSync(to) && readdirSync(to).some(isCarried)) return []
  const names = readdirSync(from).filter(isCarried)
  for (const name of names) {
    const source = join(from, name)
    cpSync(source, join(to, name), { recursive: statSync(source).isDirectory(), errorOnExist: false, force: false })
  }
  return names
}
