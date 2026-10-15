// Registers "1CCoder модель" as a provider in opencode's global config.
//
// The sidecar reads providers from <xdgConfig>/opencode/opencode.json (see
// packages/core/src/global.ts). We merge a single entry in and leave everything
// else untouched -- this file belongs to the user, may already contain their own
// providers, agents and settings, and clobbering it would be a bad way to
// discover that we own it now.
//
// The baseURL points at the loopback relay (see relay.ts), whose port is
// ephemeral, so this is rewritten on every launch before the sidecar starts.

import { readFile, writeFile, mkdir } from "node:fs/promises"

import { mergeAgentConfig } from "../skills/agents"
import type { ModelLimits } from "./relay"
import { homedir } from "node:os"
import { join } from "node:path"

export const PROVIDER_ID = "1ccoder"
export const MODEL_ID = "default"
export const DEFAULT_MODEL_LABEL = "1CCoder модель"

export interface ProviderConfigInput {
  configDir: string
  port: number
  modelLabel?: string
  /**
   * Where the generated skill set was installed. When present, our two agents
   * and this path are merged into the same write -- one writer for this file,
   * so a second one cannot race it or drop the other's changes.
   */
  skillsDir?: string | null
  /** The bundled infobase plugin and the loopback address it should call. */
  plugin?: { path: string; baseUrl: string } | null
  /** Configuration dumps our agents may read without an ask (infobase/dump-dirs.ts). */
  readableDirs?: readonly string[]
  /** Pilot (packaged) builds offer our provider only; see restrictProviders. */
  onlyOurProvider?: boolean
  /** The model's context window and output ceiling, when the server knows them. */
  limits?: ModelLimits | null
}

/**
 * Merges our provider into an existing config object without disturbing
 * anything else. Pure, so the merge semantics can be tested without touching
 * a real user's config file.
 */
export function mergeProviderConfig(
  existing: Record<string, unknown>,
  port: number,
  modelLabel: string,
  limits: ModelLimits | null = null,
) {
  const next: Record<string, unknown> = { ...existing }
  const providers = { ...((next.provider as Record<string, unknown>) ?? {}) }

  providers[PROVIDER_ID] = {
    npm: "@ai-sdk/openai-compatible",
    name: "1CCoder",
    options: {
      baseURL: `http://127.0.0.1:${port}/v1`,
      // The relay injects the real, rotating proxy token. A placeholder is
      // still required because the AI SDK refuses to construct a client
      // without one.
      apiKey: "managed-by-1ccoder",
    },
    models: {
      // Without `modalities` every input capability defaults to false (see
      // provider.ts, where a config-declared model falls back to `?? false`),
      // and the capability layer then refuses image content before it ever
      // reaches a protocol. That default -- not a broken tool -- is why
      // screenshots came back as "I can't view screenshots in this session".
      // The upstream model does accept images: OpenRouter reports
      // z-ai/glm-5.3-flash as input_modalities ["text","image","video"].
      // PDFs are deliberately absent: they are rasterised to images before they
      // reach the model, so nothing downstream should believe it can send one.
      [MODEL_ID]: {
        name: modelLabel,
        attachment: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        // What opencode needs to show how full the context is and to compact a
        // session before the provider refuses it; without it the indicator
        // reads 0% and nothing compacts. Served by our server for whatever
        // model it runs, so it is omitted rather than guessed when unknown.
        // No `cost`: credits are the one money figure a pilot should see.
        ...(limits ? { limit: { context: limits.context, output: limits.output } } : {}),
      },
    },
  }

  next.provider = providers
  return next
}

/**
 * Makes our model the default only when the user has not chosen one. Overriding
 * an explicit choice on every launch would be user-hostile -- the spec asks for
 * ours to be the default, not to be mandatory.
 */
export function applyDefaultModel(config: Record<string, unknown>): Record<string, unknown> {
  if (typeof config.model === "string" && config.model.length > 0) return config
  return { ...config, model: `${PROVIDER_ID}/${MODEL_ID}` }
}

/**
 * Share is off for good: upstream posts shared sessions to opncd.ai. The sidecar
 * already refuses through OPENCODE_DISABLE_SHARE (outbound.ts); `share:
 * "disabled"` is what the UI reads to hide the share button and command
 * (packages/app message-timeline.tsx, use-session-commands.tsx). Set on every
 * write, unlike the default model, because it is not the user's choice to make.
 */
export function disableShare(config: Record<string, unknown>): Record<string, unknown> {
  return { ...config, share: "disabled" }
}

/**
 * Pilot builds offer our provider and nothing else. Every other provider talks
 * to someone else's servers directly -- OpenCode's free tier to opencode.ai --
 * which bypasses the credits ledger and the telemetry, and may not be reachable
 * from a pilot's network at all. Dev builds keep them, for comparison runs.
 *
 * `enabled_providers` is opencode's own allowlist: it filters the provider
 * list, the model picker and the connect dialog alike. A default or small
 * model left pointing elsewhere (say, from a dev run on the same machine)
 * would name a model that no longer exists, so those are pointed back at ours.
 *
 * The file is shared between the two kinds of build on one machine, so a dev
 * start removes the allowlist again -- but only if it is exactly the one this
 * function writes, never a list the user wrote themselves.
 */
export function restrictProviders(config: Record<string, unknown>, onlyOurs: boolean): Record<string, unknown> {
  const ours = `${PROVIDER_ID}/`
  if (onlyOurs) {
    const next: Record<string, unknown> = { ...config, enabled_providers: [PROVIDER_ID] }
    if (typeof next.model !== "string" || !next.model.startsWith(ours)) next.model = `${PROVIDER_ID}/${MODEL_ID}`
    if (typeof next.small_model === "string" && !next.small_model.startsWith(ours)) delete next.small_model
    return next
  }
  const list = config.enabled_providers
  if (Array.isArray(list) && list.length === 1 && list[0] === PROVIDER_ID) {
    const { enabled_providers: _, ...rest } = config
    return rest
  }
  return config
}

export async function writeProviderConfig(input: ProviderConfigInput): Promise<string> {
  const configPath = join(input.configDir, "opencode.json")

  let existing: Record<string, unknown> = {}
  try {
    const raw = await readFile(configPath, "utf8")
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed
  } catch {
    // Missing file is the normal first-run case. A malformed one is not ours to
    // repair, but we must not lose it either -- so fall through to writing a
    // fresh object only when it could not be parsed at all, and leave a backup.
    try {
      const raw = await readFile(configPath, "utf8")
      if (raw.trim().length > 0) await writeFile(`${configPath}.1ccoder-backup`, raw, "utf8")
    } catch {
      // no existing file at all
    }
  }

  const withProvider = restrictProviders(
    disableShare(
      applyDefaultModel(
        mergeProviderConfig(existing, input.port, input.modelLabel ?? DEFAULT_MODEL_LABEL, input.limits ?? null),
      ),
    ),
    input.onlyOurProvider ?? false,
  )
  const merged = input.skillsDir
    ? mergeAgentConfig(withProvider, input.skillsDir, input.plugin ?? null, input.readableDirs ?? [])
    : withProvider

  await mkdir(input.configDir, { recursive: true })
  await writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8")
  return configPath
}

/**
 * Mirrors packages/core/src/global.ts, which resolves the opencode config dir
 * as <xdgConfig>/opencode. Kept as a local resolution rather than importing
 * core: that module runs filesystem setup and effect wiring at import time,
 * which has no business executing inside the Electron main process.
 */
export function resolveOpencodeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCODE_CONFIG_DIR
  if (override) return override
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "opencode")
  // NOTE: deliberately no Windows/%APPDATA% branch. The `xdg-basedir` package
  // opencode uses falls back to ~/.config on EVERY platform, Windows included,
  // so guessing %APPDATA% here writes a config file the sidecar never reads --
  // verified the hard way against a real install, where the sidecar's config
  // lives under the user profile's .config/opencode directory.
  return join(homedir(), ".config", "opencode")
}
