import { expect, test } from "bun:test"
import type { Configuration } from "electron-builder"

// 1CCoder: our own ids (src/main/identity.ts). Upstream's deb/rpm metainfo and
// its hidden launcher for old Linux pins are gone with them -- 1CCoder ships on
// Windows only -- so their assertions went too.
const channels = [
  { channel: "dev", appId: "com.1ccoder.desktop.dev" },
  { channel: "beta", appId: "com.1ccoder.desktop.beta" },
  { channel: "prod", appId: "com.1ccoder.desktop" },
] as const

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel.channel

    const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.appId).toBe(channel.appId)
    expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
    expect(config.linux?.executableName).toBe(channel.appId)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
  })
}

test("bundles the CLI outside the dev app archive", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "dev"
  const module = await import("./electron-builder.config.ts?cli-resource")
  const config = module.default as Configuration
  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  expect(config.files).toContain("!resources/opencode-cli*")
  expect(config.extraResources).toContainEqual({
    from: "resources/",
    to: "",
    filter: ["opencode-cli*"],
  })
})

for (const channel of ["beta", "prod"] as const) {
  test(`does not bundle the CLI in ${channel} builds`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel
    const module = await import(`./electron-builder.config.ts?no-cli-resource=${channel}`)
    const config = module.default as Configuration
    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.extraResources).not.toContainEqual({
      from: "resources/",
      to: "",
      filter: ["opencode-cli*"],
    })
  })
}

// 2026-09-21, debrief6.md §9 C1. `files` puts these inside app.asar, but the
// skill installer resolves them through `process.resourcesPath`, which is the
// directory app.asar sits in. Without this entry every bundled resource --
// the plugin, the CLI, the .epf templates and the vendored MXL skills -- is
// missing from a packaged build while working perfectly in dev.
test("copies the installer's resources out of the archive", async () => {
  const module = await import("./electron-builder.config.ts?installer-resources")
  const config = module.default as Configuration
  expect(config.extraResources).toContainEqual({
    from: "resources/",
    to: "",
    filter: ["1ccoder-plugin.mjs", "v8pack-cli.mjs", "templates/**", "vendor/**"],
  })
})
