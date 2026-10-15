import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

import { readEndpoints } from "./endpoints"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
// 1CCoder ships for Windows only. The Linux deb/rpm metainfo and the legacy
// opencode-desktop launcher were upstream's and are keyed to its app ids, so
// they are dropped rather than renamed.

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  // CI, or a workstation release that asked for it (script/release-1ccoder.ps1 -Sign).
  if (process.env.GITHUB_ACTIONS !== "true" && process.env.ONECCODER_SIGN !== "1") return

  await execFileAsync(
    // CI runners have PowerShell 7; a stock workstation has only 5.1, which the
    // TrustedSigning module also supports.
    process.env.GITHUB_ACTIONS === "true" ? "pwsh" : "powershell",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

// Kept in step with src/main/identity.ts. The app id names the %APPDATA%
// folder that holds pilots' profiles, so it does not change once shipped.
const APP_IDS = {
  dev: "com.1ccoder.desktop.dev",
  beta: "com.1ccoder.desktop.beta",
  prod: "com.1ccoder.desktop",
} as const

// Updates come from a static directory on the service's own host, not GitHub
// or S3: `<server>/updates/` holds the installer and latest.yml. The app
// re-points the feed at whichever address of the service it chose
// (src/main/updater.ts); this is the default baked into app-update.yml:
// ONECCODER_UPDATES_URL, else the first of ONECCODER_SERVER_URLS + /updates
// (endpoints.ts). Ours is the Moscow relay, because some Russian networks cap
// every connection to the direct host at ~16 KB, downloads included
// (connectivity/relay-ru-plan.md, A6).
const UPDATES_URL = readEndpoints("production", packageDir).updatesUrl

const getBase = (appId: string): Configuration => ({
  artifactName: "1ccoder-setup-${version}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "ai.opencode.desktop" becomes
  // "ai.opencode.desktop.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    desktopName: `${appId}.desktop`,
    // A per-user one-click install goes to %LOCALAPPDATA%\Programs\<name>, and
    // the package name was upstream's, so pilots got "@opencode-aidesktop".
    // Fresh installs only: an update reads the old folder back from the
    // registry (InstallLocation under a key derived from appId, which does not
    // change), so existing installs stay where they are. The runtime name and
    // userData do not depend on this: main/index.ts sets both from the channel.
    name: "1CCoder",
  },
  files: ["out/**/*", "resources/**/*", "!resources/opencode-cli*"],
  extraResources: [
    ...(channel === "dev"
      ? [
          {
            from: "resources/",
            to: "",
            filter: ["opencode-cli*"],
          },
        ]
      : []),
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
    // The skill installer resolves these through `process.resourcesPath` in a
    // packaged app (see resolveBundledResource), which is the directory app.asar
    // sits IN -- not a path inside it. `files` alone therefore puts them somewhere
    // the installer never looks, so they have to be copied out as well.
    //
    // 2026-09-21: noticed while vendoring the MXL skills (debrief6.md §9 C1).
    // It applies equally to the plugin, the CLI and the .epf templates, which
    // have only ever been exercised in dev builds -- where appPath is the
    // package directory and the same call happens to resolve correctly.
    {
      from: "resources/",
      to: "",
      filter: ["1ccoder-plugin.mjs", "v8pack-cli.mjs", "templates/**", "vendor/**"],
    },
    // MCP_Toolkit.epf with its LICENSE (GPL-3.0), NOTICE and modifications.diff,
    // which travel with it as a condition of shipping it (src/main/mcp/toolkit.ts).
    {
      from: "resources/toolkit/",
      to: "toolkit/",
      filter: ["MCP_Toolkit.epf", "LICENSE", "NOTICE.md", "modifications.diff"],
    },
    // rg.exe, so opencode never downloads ripgrep from GitHub (src/main/outbound.ts).
    {
      from: "resources/bin/",
      to: "bin/",
      filter: ["rg.exe"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: "1CCoder",
    schemes: ["1ccoder"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "1CCoder Dev",
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: "1CCoder Beta",
        protocols: { name: "1CCoder Beta", schemes: ["1ccoder"] },
        publish: { provider: "generic", url: `${UPDATES_URL}/beta/`, channel: "latest" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: "1CCoder",
        protocols: { name: "1CCoder", schemes: ["1ccoder"] },
        publish: { provider: "generic", url: `${UPDATES_URL}/`, channel: "latest" },
      }
    }
  }
}

export default getConfig()
