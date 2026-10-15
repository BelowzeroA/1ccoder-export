import { $ } from "bun"
import { buildSidecar, downloadCliToResources } from "./utils"

await $`bun run install-electron`

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

await buildSidecar()
await downloadCliToResources()
await $`bun ./scripts/fetch-ripgrep.ts`
