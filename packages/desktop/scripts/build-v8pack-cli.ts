#!/usr/bin/env bun
// Bundles the v8pack CLI into a standalone .mjs.
//
// It ships as a real file on disk rather than inside the asar, because it is
// run as a separate process: the generated skills invoke it through Electron's
// own binary with ELECTRON_RUN_AS_NODE=1, which is what lets us drop the
// assumption that the user has Node installed.
//
// The CLI imports nothing but node: builtins, so this is close to a copy.

import { $ } from "bun"

const CLI = "resources/v8pack-cli.mjs"
const PLUGIN = "resources/1ccoder-plugin.mjs"

await $`bun build src/main/v8pack/cli.ts --target=node --format=esm --outfile=${CLI}`

// The plugin is loaded by the sidecar, which provides @opencode-ai/plugin
// itself -- bundling a second copy of it would be wasteful and could pull in a
// different version than the host is running.
await $`bun build src/main/infobase/plugin.ts --target=node --format=esm --external @opencode-ai/plugin --outfile=${PLUGIN}`

/**
 * The loader's rule, enforced where the artefact is produced.
 *
 * 2026-09-23, debrief8.md §E7 / T7. opencode's `getLegacyPlugins` walks EVERY
 * export of a plugin module and throws `Plugin export is not a function` on the
 * first one that is not a plugin. A `export const REQUEST_TIMED_OUT = "..."`
 * added for a test to import therefore rejected the whole plugin -- and the app
 * ran a full session with no `1c_*` tools, no permission gate and no guards,
 * saying nothing. Typecheck passed, 91 unit tests passed, and a plain `node`
 * import passed, because none of them is the consumer that enforces this.
 *
 * Checked by reading the emitted export block rather than by importing: the
 * bundle leaves `@opencode-ai/plugin` external, so it cannot be imported
 * standalone here.
 */
async function assertPluginExportsAreFunctions(path: string): Promise<void> {
  const source = await Bun.file(path).text()
  const block = /\bexport\s*\{([^}]*)\}/.exec(source)
  if (!block) throw new Error(`${path}: no export block found -- the plugin must export a default`)

  const names = block[1]!
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    // `plugin_default as default` -- the local name is what the bundle declares.
    .map((entry) => entry.split(/\s+as\s+/)[0]!.trim())

  const offenders = names.filter((name) => {
    // A function export appears as `function name(` / `async function name(` or
    // as `var name = (...) =>` / `var name = async (...) =>`.
    const declared = new RegExp(
      String.raw`(?:async\s+)?function\s+${name}\b|\b(?:var|let|const)\s+${name}\s*=\s*(?:async\s*)?(?:function\b|\(|[A-Za-z_$])`,
    )
    if (!declared.test(source)) return true
    // A string/number/object constant assigned directly is the failure mode.
    return new RegExp(String.raw`\b(?:var|let|const)\s+${name}\s*=\s*(?:"|'|\d|\{|\[)`).test(source)
  })

  if (offenders.length) {
    throw new Error(
      `${path}: these exports are not functions and will make opencode reject the whole plugin: ` +
        `${offenders.join(", ")}. Move them to another module (see bulk.ts) and export only the plugin.`,
    )
  }
  if (!names.includes("plugin_default") && !names.includes("default")) {
    throw new Error(`${path}: no default export -- the sidecar has nothing to load`)
  }
}

await assertPluginExportsAreFunctions(PLUGIN)

for (const out of [CLI, PLUGIN]) {
  const size = (await Bun.file(out).arrayBuffer()).byteLength
  console.log(`bundled: ${out} (${size} bytes)`)
}
console.log(`checked: ${PLUGIN} exports only plugin functions`)
