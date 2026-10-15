// Renderer-side bridge for the MCP Toolkit.
//
// Fork-owned, like ./1ccoder-profiles.ts, so preload/index.ts and
// preload/types.ts each gain a single line.
//
// Note what is absent: no way to choose the port, no way to say where the .epf
// is, no way to read the infobase password that opens it. The renderer can ask
// for the toolkit its session's profile needs, ask how that went, and learn the
// profile's port only to point its session folder's MCP client at it.

import { ipcRenderer } from "electron"

import type { ToolkitStatus } from "../main/mcp/supervisor"

export type { ToolkitStatus }

export interface McpApi {
  /** Starts the toolkit for this profile if it is not already serving it. */
  ensure: (profileId: string) => Promise<ToolkitStatus>
  status: (profileId?: string) => Promise<ToolkitStatus>
  /**
   * Whether the toolkit's port answers right now -- including a toolkit the
   * user opened by hand, which is not something `status` can know.
   */
  health: (profileId?: string) => Promise<boolean>
  /**
   * Records that a session folder's MCP client is about to point at this
   * profile's toolkit, and returns the port to point it at (null: no profile).
   */
  link: (directory: string | undefined, profileId: string) => Promise<number | null>
}

export const mcpApi: McpApi = {
  ensure: (profileId) => ipcRenderer.invoke("1ccoder-mcp-ensure", profileId),
  status: (profileId) => ipcRenderer.invoke("1ccoder-mcp-status", profileId),
  health: (profileId) => ipcRenderer.invoke("1ccoder-mcp-health", profileId),
  link: (directory, profileId) => ipcRenderer.invoke("1ccoder-mcp-link", { directory, profileId }),
}
