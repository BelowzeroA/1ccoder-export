// The backend's addresses and the support contact, as baked in at build time
// (packages/desktop/endpoints.ts, through electron-vite's `define`). The build
// refuses to run without them, so outside tests these are never empty. Under
// bun test, `import.meta.env` is the process environment, which bun fills from
// packages/desktop/.env.test.

const env = import.meta.env as Record<string, string | undefined>

/** Base URLs of the service, most preferred first. */
export const SERVER_URLS: readonly string[] = (env.ONECCODER_SERVER_URLS ?? "")
  .split(",")
  .map((url) => url.trim().replace(/\/+$/, ""))
  .filter(Boolean)

/** Where refusals and the sign-in screen send the user. */
export const SUPPORT_CONTACT: string = env.ONECCODER_SUPPORT_CONTACT ?? ""
