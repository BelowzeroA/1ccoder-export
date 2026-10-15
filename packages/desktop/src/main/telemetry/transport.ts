// Talks to the server's /telemetry endpoints.
//
// Every upload is small enough per request to cross the DPI on pilots'
// networks: an object that fits in one chunk goes inline in the commit, and a
// larger one is split across /telemetry/upload first -- the same protocol, and
// the same server-served chunk size, as the model relay's (llm/relay.ts).

import { fetchOnFreshConnection } from "../llm/fresh-connection"
import { newUploadId, planChunks } from "../llm/relay"

export interface TelemetrySwitches {
  readonly enabled: boolean
  readonly artifacts: boolean
  readonly logs: boolean
  readonly max_artifact_bytes: number
  readonly max_log_bytes: number
  readonly sync_seconds: number
  readonly chunk_size: number
}

export interface CommitResult {
  readonly stored: boolean
  readonly reason?: string
}

export interface TransportOptions {
  /** A function when the address can change between requests (llm/servers.ts). */
  readonly baseUrl: string | (() => string)
  /** The proxy token, or null when signed out. */
  readonly getToken: () => Promise<string | null>
  readonly fetchImpl?: typeof fetch
}

/** Anything worth retrying later: offline, 5xx, signed out, a lapsed token. */
export class TransportError extends Error {}

export class TelemetryTransport {
  private chunkSize = 12_000
  private readonly doFetch: typeof fetch

  constructor(private readonly options: TransportOptions) {
    this.doFetch = options.fetchImpl ?? fetchOnFreshConnection
  }

  async switches(): Promise<TelemetrySwitches | null> {
    const response = await this.request("/telemetry/config")
    if (!response.ok) return null
    const data = (await response.json()) as TelemetrySwitches
    if (data.chunk_size > 0) this.chunkSize = data.chunk_size
    return data
  }

  async has(sha256: string): Promise<boolean> {
    const response = await this.request(`/telemetry/has/${sha256}`)
    if (!response.ok) throw new TransportError(`has ${response.status}`)
    return Boolean(((await response.json()) as { exists?: boolean }).exists)
  }

  async commit(kind: string, meta: Record<string, unknown>, content: Uint8Array): Promise<CommitResult> {
    // Base64 is 4/3 the size, plus the JSON around it.
    const inline = Math.ceil(content.byteLength / 3) * 4 + 1024 <= this.chunkSize
    const body = inline
      ? { kind, meta, content_b64: Buffer.from(content).toString("base64") }
      : { kind, meta, upload_id: await this.upload(content) }
    const response = await this.request("/telemetry/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    // A 4xx other than auth or rate limiting says the object itself is wrong;
    // sending it again would change nothing, so it is dropped with the reason.
    if (response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 429)
      return { stored: false, reason: `rejected ${response.status}: ${(await response.text()).slice(0, 200)}` }
    if (!response.ok) throw new TransportError(`commit ${response.status}`)
    return (await response.json()) as CommitResult
  }

  private async upload(content: Uint8Array): Promise<string> {
    const id = newUploadId()
    const plan = planChunks(content.byteLength, this.chunkSize)
    for (const piece of plan) {
      const response = await this.request(`/telemetry/upload/${id}/${piece.index}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Total-Chunks": String(plan.length) },
        body: content.slice(piece.start, piece.end),
      })
      if (!response.ok) throw new TransportError(`upload ${response.status}`)
    }
    return id
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.options.getToken()
    if (!token) throw new TransportError("signed out")
    try {
      const base = typeof this.options.baseUrl === "function" ? this.options.baseUrl() : this.options.baseUrl
      return await this.doFetch(`${base}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60_000),
      })
    } catch (error) {
      throw new TransportError(error instanceof Error ? error.message : String(error))
    }
  }
}
