#!/usr/bin/env bun
// Puts rg.exe in resources/bin, to ship in the installer.
//
// Without it, opencode downloads ripgrep from GitHub on the first grep or glob
// (packages/core/src/ripgrep/binary.ts), which a pilot's network may not reach.
// The app puts resources/bin first on the sidecar's PATH (ripgrep.ts), and
// opencode takes an rg found on PATH before it tries to download one.
//
// The version and file are the ones binary.ts would fetch, pinned by the
// SHA-256 the ripgrep release publishes. Windows x64 only: that is all 1CCoder
// ships for. The binary is not committed (resources/bin is gitignored).

import { $ } from "bun"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const VERSION = "15.1.0"
const PLATFORM = "x86_64-pc-windows-msvc"
const SHA256 = "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a"
const DEST = "resources/bin/rg.exe"

if (process.platform !== "win32") {
  console.log("fetch-ripgrep: not Windows, skipped")
  process.exit(0)
}
if (existsSync(DEST)) {
  console.log(`fetch-ripgrep: ${DEST} already there`)
  process.exit(0)
}

const name = `ripgrep-${VERSION}-${PLATFORM}`
const url = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${name}.zip`
const response = await fetch(url)
if (!response.ok) throw new Error(`fetch-ripgrep: ${url} answered ${response.status}`)
const bytes = new Uint8Array(await response.arrayBuffer())
const actual = createHash("sha256").update(bytes).digest("hex")
if (actual !== SHA256) throw new Error(`fetch-ripgrep: ${url} has SHA-256 ${actual}, expected ${SHA256}`)

const directory = await mkdtemp(join(tmpdir(), "1ccoder-rg-"))
try {
  const archive = join(directory, `${name}.zip`)
  await Bun.write(archive, bytes)
  await $`powershell.exe -NoProfile -NonInteractive -Command ${`$global:ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath '${archive}' -DestinationPath '${directory}' -Force`}`
  await mkdir("resources/bin", { recursive: true })
  await copyFile(join(directory, name, "rg.exe"), DEST)
} finally {
  await rm(directory, { recursive: true, force: true })
}
console.log(`fetch-ripgrep: ripgrep ${VERSION} copied to ${DEST}`)
