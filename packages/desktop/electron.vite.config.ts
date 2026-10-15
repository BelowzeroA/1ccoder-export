import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "electron-vite"
import appPlugin from "@opencode-ai/app/vite"
import * as fs from "node:fs/promises"
import { readFileSync } from "node:fs"
import { readEndpoints } from "./endpoints"

const OPENCODE_SERVER_DIST = "../opencode/dist/node"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.OPENCODE_CHANNEL === "latest") return "prod"
  return "dev"
})()

// The opencode version this build is based on. The desktop package carries the
// product's own version line (0.x.y), so the upstream one is read from the
// server package, which a rebase keeps current.
const upstreamVersion: string = JSON.parse(readFileSync("../opencode/package.json", "utf8")).version

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./out/renderer/**",
          filesToDeleteAfterUpload: "./out/renderer/**/*.map",
        },
      })
    : false

export default defineConfig(({ mode }) => {
  // The backend this build talks to (endpoints.ts): baked into main and the
  // renderer, which reads the support contact.
  const endpoints = readEndpoints(mode)
  const endpointDefines = {
    "import.meta.env.ONECCODER_SERVER_URLS": JSON.stringify(endpoints.servers.join(",")),
    "import.meta.env.ONECCODER_SUPPORT_CONTACT": JSON.stringify(endpoints.support),
  }
  return {
    main: {
      define: {
        "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
        "import.meta.env.UPSTREAM_VERSION": JSON.stringify(upstreamVersion),
        ...endpointDefines,
      },
      build: {
        rollupOptions: {
          input: { index: "src/main/index.ts", sidecar: "src/main/sidecar.ts" },
          // Keep this identical to electron-vite's Node 20.11+ shim. Its regex insertion can
          // corrupt bundled TypeScript, while a Rollup banner places the shim safely.
          output: {
            banner: `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`,
          },
        },
        externalizeDeps: { include: [nodePtyPkg] },
      },
      plugins: [
        {
          name: "opencode:node-pty-narrower",
          enforce: "pre",
          resolveId(s) {
            if (s === "@lydell/node-pty") return nodePtyPkg
          },
        },
        {
          name: "opencode:virtual-server-module",
          enforce: "pre",
          resolveId(id) {
            if (id === "virtual:opencode-server") return this.resolve(`${OPENCODE_SERVER_DIST}/node.js`)
          },
        },
        {
          name: "opencode:copy-server-assets",
          async writeBundle() {
            for (const l of await fs.readdir(OPENCODE_SERVER_DIST)) {
              if (!l.endsWith(".wasm")) continue
              await fs.writeFile(`./out/main/chunks/${l}`, await fs.readFile(`${OPENCODE_SERVER_DIST}/${l}`))
            }
          },
        },
      ],
    },
    preload: {
      build: {
        rollupOptions: {
          input: { index: "src/preload/index.ts" },
          output: {
            format: "cjs",
            entryFileNames: "[name].js",
          },
        },
      },
    },
    renderer: {
      plugins: [appPlugin, sentry],
      define: endpointDefines,
      publicDir: "../../../app/public",
      root: "src/renderer",
      build: {
        sourcemap: true,
        rollupOptions: {
          input: {
            main: "src/renderer/index.html",
          },
        },
      },
    },
  }
})
