// Outbound calls the sidecar would make on its own, closed off before it starts.
//
// A pilot's machine should talk to our server and nothing else nobody decided on
// (next_steps.md, Step 0.2):
// - share: upstream posts shared sessions to opncd.ai. OPENCODE_DISABLE_SHARE
//   turns every share operation into a no-op (opencode/src/share/share-next.ts).
// - the model catalog: opencode refreshes models.opencode.ai hourly
//   (core/src/models-dev.ts). OPENCODE_DISABLE_MODELS_FETCH stops the refresh and
//   leaves the cached or bundled snapshot. Our own provider never came from the
//   catalog: it is declared in full in opencode.json (llm/provider-config.ts).
// - ripgrep: opencode downloads rg from GitHub on first use unless one is on
//   PATH (core/src/ripgrep/binary.ts). The installer ships rg.exe in
//   resources/bin (scripts/fetch-ripgrep.ts), and that directory goes first on
//   PATH here.
// - self-update: the sidecar is built as a released upstream version (see
//   scripts/utils.ts buildSidecar), so opencode's own upgrade check would find
//   newer releases on npm and try to install one over ours. The desktop app
//   owns updates; OPENCODE_DISABLE_AUTOUPDATE keeps the sidecar out of it.

import { existsSync } from "node:fs"
import { delimiter, join } from "node:path"

export interface OutboundInput {
  packaged: boolean
  resourcesPath: string
  appPath: string
}

/** Where the bundled rg.exe lives, resolved as resolveBundledResource does. */
export function bundledBinDirectory(input: OutboundInput): string {
  return input.packaged ? join(input.resourcesPath, "bin") : join(input.appPath, "resources", "bin")
}

/**
 * Sets the switches on `env` (process.env, which the sidecar inherits). Returns
 * the bin directory put on PATH, or null when there is no bundled rg to point
 * at -- opencode then falls back to its own download, as before.
 */
export function closeOutboundCalls(env: NodeJS.ProcessEnv, input: OutboundInput): string | null {
  env.OPENCODE_DISABLE_SHARE = "1"
  env.OPENCODE_DISABLE_MODELS_FETCH = "1"
  env.OPENCODE_DISABLE_AUTOUPDATE = "1"
  const bin = bundledBinDirectory(input)
  if (!existsSync(join(bin, "rg.exe")) && !existsSync(join(bin, "rg"))) return null
  const path = env.PATH ?? ""
  if (!path.split(delimiter).includes(bin)) env.PATH = path ? `${bin}${delimiter}${path}` : bin
  return bin
}
