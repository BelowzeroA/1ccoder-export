#!/usr/bin/env bun
import { $ } from "bun"

import { buildSidecar, downloadCliToResources, resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`bun ./scripts/build-v8pack-cli.ts`
await $`bun ./scripts/fetch-ripgrep.ts`
await buildSidecar()
if (channel === "dev") await downloadCliToResources()
