// Keeping the sidecar's MCP client in step with the toolkit that serves it.
//
// opencode connects a remote MCP server once, when the instance boots, and
// keeps whatever came back -- a failure included. The toolkit is a 1C window
// that opens tens of seconds after a profile is bound, and that the user may
// close, restart or start by hand at any point. Put together, those two facts
// mean the `1c_*` tools can be missing for an entire session while the toolkit
// is up and answering: the sidecar simply never looks again.
//
// So something has to look. This is that something: ask whether the port
// answers, and when the answer changes, tell the sidecar to connect or
// disconnect.
//
// The decision is kept apart from the timer on purpose. What to do is a
// function of two booleans and can be tested; the polling around it is four
// lines in use-session-profile.ts.

/** How often a profile session asks whether the toolkit is there. */
export const TOOLKIT_POLL_MS = 10_000

export type LinkAction = "connect" | "disconnect" | "none"

/**
 * Acting only on a change, rather than connecting whenever the port answers,
 * is what keeps this cheap: connecting replaces the sidecar's client and
 * re-lists its tools, and doing that every ten seconds would churn the agent's
 * tool list for no reason.
 */
export function linkAction(linked: boolean, alive: boolean): LinkAction {
  if (alive && !linked) return "connect"
  if (!alive && linked) return "disconnect"
  return "none"
}

export interface ToolkitLinkDeps {
  /** Does the toolkit's port answer right now? */
  readonly health: () => Promise<boolean>
  readonly connect: () => Promise<unknown>
  readonly disconnect: () => Promise<unknown>
  /**
   * Does the sidecar actually hold a connected client? When given, it is the
   * truth each tick decides from, instead of what this class last did.
   *
   * 2026-09-27, debrief15.md §15.7: the sidecar's connect answers `true` even
   * when the connect failed -- the failure is only stored as a status. A 1C
   * session blocked by a modal window let the port answer while `initialize`
   * timed out; the link recorded itself as linked, the port kept answering, and
   * it never tried again. Every `1c_*` call said «Not connected» for as long
   * as that toolkit ran, window closed or not.
   */
  readonly sidecarConnected?: () => Promise<boolean>
}

export class ToolkitLink {
  private linked = false
  private inFlight: Promise<LinkAction> | null = null

  constructor(private readonly deps: ToolkitLinkDeps) {}

  /** Whether the sidecar is believed to hold a live client for the toolkit. */
  get connected(): boolean {
    return this.linked
  }

  /**
   * One check. Concurrent calls share the one in flight: the timer and the
   * bind that just happened can easily land together, and connecting twice
   * would tear down the client that was just built.
   */
  sync(): Promise<LinkAction> {
    if (this.inFlight) return this.inFlight
    const run = this.run().finally(() => {
      this.inFlight = null
    })
    this.inFlight = run
    return run
  }

  private async run(): Promise<LinkAction> {
    const alive = await this.deps.health().catch(() => false)
    const sidecar = this.deps.sidecarConnected
    if (sidecar) this.linked = await sidecar().catch(() => this.linked)
    const action = linkAction(this.linked, alive)

    if (action === "connect") {
      // Recorded as linked only once the sidecar has actually answered, so a
      // sidecar that was still starting is simply retried on the next tick.
      await this.deps.connect()
      this.linked = sidecar ? await sidecar().catch(() => false) : true
      return action
    }

    if (action === "disconnect") {
      // Recorded as unlinked whatever happens: the server it pointed at is
      // gone, and a toolkit that comes back must be connected afresh.
      this.linked = false
      await this.deps.disconnect()
      return action
    }

    return action
  }
}
