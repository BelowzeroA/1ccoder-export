// Which port each profile's MCP Toolkit listens on.
//
// 2026-10-13: one fixed port for every profile made two sessions on different
// infobases stop each other's toolkit whenever either touched its base. Each
// profile now gets a port of its own, kept for good once given, so a toolkit
// left running by an earlier app run is found where it was started.
//
// MCP_PORT itself is not handed out. opencode's global config still names it
// (skills/agents.ts), and a session whose app-side link has not run yet reaches
// for it; with nothing of ours listening there, that session sees "no toolkit"
// rather than another profile's base.

import { MCP_PORT } from "./toolkit"

export const FIRST_PROFILE_PORT = MCP_PORT + 1
export const LAST_PROFILE_PORT = MCP_PORT + 96

export interface ToolkitPortsDeps {
  readonly load: () => Record<string, number>
  readonly save: (ports: Record<string, number>) => void
}

export class ToolkitPorts {
  private ports: Record<string, number> | null = null

  constructor(private readonly deps: ToolkitPortsDeps) {}

  /** The profile's port, given on first use and kept after that. */
  portFor(profileId: string): number {
    const ports = this.read()
    const known = ports[profileId]
    if (known !== undefined) return known
    const taken = new Set(Object.values(ports))
    let port = FIRST_PROFILE_PORT
    while (taken.has(port) && port < LAST_PROFILE_PORT) port++
    // Past the range every new profile shares its last port: the supervisor
    // then stops one for the other, which is the old behaviour, not a failure.
    ports[profileId] = port
    this.deps.save(ports)
    return port
  }

  private read(): Record<string, number> {
    if (this.ports) return this.ports
    const loaded = this.deps.load()
    this.ports = Object.fromEntries(
      Object.entries(loaded).filter(
        (entry): entry is [string, number] =>
          Number.isInteger(entry[1]) && entry[1] >= FIRST_PROFILE_PORT && entry[1] <= LAST_PROFILE_PORT,
      ),
    )
    return this.ports
  }
}
