// Renderer-side bridge for the account's credits.
//
// Fork-owned, like ./1ccoder-mcp.ts, so preload/index.ts and preload/types.ts
// each gain a single line. Read-only: the renderer can see the balance and hear
// when it changes, and nothing else -- the token that reads it stays in main.

import { ipcRenderer } from "electron"

import { CREDITS_CHANNELS } from "../main/llm/credits-channels"
import type { CreditBalance } from "../main/llm/relay"

export type { CreditBalance }

export interface CreditsApi {
  /** The last known balance, read from the server if none is known yet. */
  get: () => Promise<CreditBalance | null>
  /** Called after each model request settles. Returns the unsubscribe. */
  subscribe: (callback: (balance: CreditBalance) => void) => () => void
  /**
   * The address of our service the relay is using, or null before it has
   * started. Here because sign-in talks to the same service and must follow
   * the same failover (connectivity/relay-ru-plan.md, A5).
   */
  serverUrl: () => Promise<string | null>
}

export const creditsApi: CreditsApi = {
  get: () => ipcRenderer.invoke(CREDITS_CHANNELS.get),
  subscribe: (callback) => {
    const handler = (_event: unknown, balance: CreditBalance) => callback(balance)
    ipcRenderer.on(CREDITS_CHANNELS.changed, handler)
    return () => ipcRenderer.removeListener(CREDITS_CHANNELS.changed, handler)
  },
  serverUrl: () => ipcRenderer.invoke(CREDITS_CHANNELS.server),
}
