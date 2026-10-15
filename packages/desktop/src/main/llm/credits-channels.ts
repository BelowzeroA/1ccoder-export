// IPC channel names for the credits bridge, shared by main (llm/index.ts) and
// preload (preload/1ccoder-credits.ts). A module of its own so preload pulls in
// nothing from the main process but these strings.
export const CREDITS_CHANNELS = {
  get: "1ccoder-credits-get",
  changed: "1ccoder-credits-changed",
  /** The service address in use (llm/servers.ts); sign-in follows it. */
  server: "1ccoder-server-url",
} as const
