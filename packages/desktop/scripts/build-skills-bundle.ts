#!/usr/bin/env bun
// The skills a release installs, as one tarball, for `admin pull-session` to
// lay beside a pilot's session (next_steps.md, Step 3b): the client uploads
// only a manifest, because every install of one build has the same skills.
//
// Produced by the same installSkills() the app runs at startup, into a
// throwaway config directory. The launcher in it names a placeholder
// executable -- the one per-machine detail, which a debrief does not need.
//
//   bun ./scripts/build-skills-bundle.ts <out.tar.gz>

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { $ } from "bun"

// skills/index.ts logs through logging.ts, which imports electron at module
// load; outside Electron that throws, so the logger is stubbed, as the
// skills tests do.
Bun.plugin({
  setup(build) {
    build.module(resolve(import.meta.dir, "../src/main/logging.ts"), () => ({
      exports: { write: () => {} },
      loader: "object",
    }))
  },
})
const { installSkills } = await import("../src/main/skills")

const out = process.argv[2]
if (!out) throw new Error("usage: build-skills-bundle.ts <out.tar.gz>")

const resources = resolve(import.meta.dir, "../resources")
const configDir = await mkdtemp(join(tmpdir(), "1ccoder-skills-"))
try {
  const result = await installSkills({
    configDir,
    cliSource: join(resources, "v8pack-cli.mjs"),
    pluginSource: join(resources, "1ccoder-plugin.mjs"),
    templatesSource: join(resources, "templates"),
    vendorSource: join(resources, "vendor/cc-1c-skills"),
    electronPath: "C:\\Program Files\\1CCoder\\1CCoder.exe",
  })
  // Windows' own bsdtar: a GNU tar from Git Bash reads "C:" as a remote host.
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar"
  await $`${tar} -czf ${resolve(out)} -C ${configDir} .`
  console.log(`skills bundle: ${result.skills.length} skills -> ${out}`)
} finally {
  await rm(configDir, { recursive: true, force: true })
}
