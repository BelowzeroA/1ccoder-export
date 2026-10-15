import { app } from "electron"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev"

/** The opencode release this build is based on; app.getVersion() is the product's own line. */
export const UPSTREAM_VERSION: string = import.meta.env.UPSTREAM_VERSION ?? "unknown"
