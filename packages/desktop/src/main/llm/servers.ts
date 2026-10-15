// Which address of our service to use: the first in an ordered list whose
// /health answers.
//
// 2026-10-07, connectivity/relay-ru-plan.md (A5). Some Russian networks freeze
// every TCP connection to our AWS host after ~16-24 KB, whatever name it is
// reached by. Our first address is a Moscow relay that carries the same service
// past that cap; the second is the direct route, which still works there,
// degraded, through compaction and a connection per request. The relay is a new
// single point of failure, so it is preferred, never relied on: when it does not
// answer, the client uses the direct route and keeps checking back.
//
// The list is baked in at build time (ONECCODER_SERVER_URLS, ../endpoints.ts)
// for the first start and then served by /llm/config, so the order can change
// without a release.

import { SERVER_URLS } from "../endpoints"
import { fetchOnFreshConnection } from "./fresh-connection"

export const DEFAULT_SERVERS: readonly string[] = SERVER_URLS

/** A /health that has not answered in this long is down, as far as choosing goes. */
export const PROBE_TIMEOUT_MS = 5_000

/** Failures in a row on the chosen address before the list is probed again. */
export const FAILURES_BEFORE_REPROBE = 2

/** How often a client that fell back looks again for a better address. */
export const PREFERRED_RECHECK_MS = 10 * 60_000

export interface ServerSelectorOptions {
  servers?: readonly string[]
  fetchImpl?: typeof fetch
  now?: () => number
  log?: (message: string, extra?: Record<string, unknown>) => void
}

export class ServerSelector {
  private list: string[]
  private chosen: string
  private failures = 0
  private probedAt = 0
  private probing: Promise<string> | null = null
  private readonly doFetch: typeof fetch
  private readonly now: () => number

  constructor(private readonly options: ServerSelectorOptions = {}) {
    const given = normalise(options.servers ?? DEFAULT_SERVERS)
    this.list = given.length > 0 ? given : [...DEFAULT_SERVERS]
    this.chosen = this.list[0]
    this.doFetch = options.fetchImpl ?? fetchOnFreshConnection
    this.now = options.now ?? (() => Date.now())
  }

  get current(): string {
    return this.chosen
  }

  get servers(): readonly string[] {
    return this.list
  }

  /**
   * Adopts the list the server serves. A changed list is probed again, since
   * the address in use may have moved down it or left it.
   */
  setServers(servers: readonly string[]): void {
    const next = normalise(servers)
    if (next.length === 0 || next.join("\n") === this.list.join("\n")) return
    this.list = next
    if (!next.includes(this.chosen)) this.chosen = next[0]
    void this.probe()
  }

  /**
   * Asks every address at once and takes the first in list order that
   * answered, so a dead relay costs one probe timeout and not one per entry.
   * When none answers the choice stays as it was: the next request fails on
   * its own terms, which says more than a guess would.
   */
  probe(): Promise<string> {
    if (this.list.length < 2) return Promise.resolve(this.chosen)
    if (this.probing) return this.probing
    this.probing = (async () => {
      try {
        const answers = this.list.map((url) => this.healthy(url))
        for (const [index, url] of this.list.entries()) {
          if (!(await answers[index])) continue
          this.choose(url)
          return url
        }
        this.options.log?.("no server answered its health check", { servers: this.list, keeping: this.chosen })
        return this.chosen
      } finally {
        this.probedAt = this.now()
        this.failures = 0
        this.probing = null
      }
    })()
    return this.probing
  }

  /** A request on the chosen address failed in a way a different address might not. */
  reportFailure(): void {
    this.failures++
    if (this.failures >= FAILURES_BEFORE_REPROBE) void this.probe()
  }

  /** A request on the chosen address went through. */
  reportSuccess(): void {
    this.failures = 0
    if (this.chosen !== this.list[0] && this.now() - this.probedAt >= PREFERRED_RECHECK_MS) void this.probe()
  }

  private choose(url: string): void {
    if (url === this.chosen) return
    this.options.log?.("server changed", { from: this.chosen, to: url })
    this.chosen = url
  }

  private async healthy(url: string): Promise<boolean> {
    try {
      const response = await this.doFetch(`${url}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      await response.body?.cancel().catch(() => undefined)
      return response.ok
    } catch {
      return false
    }
  }
}

function normalise(servers: readonly string[]): string[] {
  return [...new Set(servers.map((url) => url.trim().replace(/\/+$/, "")).filter((url) => /^https?:\/\//.test(url)))]
}
