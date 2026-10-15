// 1CCoder model access: a loopback relay that sits between the opencode sidecar
// and our AWS service.
//
// Why this exists rather than pointing opencode straight at our service:
//
//  1. Chunking. Russian ISP DPI resets any single upload to our host once the
//     body passes ~16-32KB (measured: 20KB passes, 40KB fails), and real coding
//     requests are far larger. Splitting a body across several small POSTs gets
//     through -- proven end to end from an affected network
//     (connectivity/dpitest8.ps1) -- provided each POST has a TCP connection of
//     its own: since 2026-10 the DPI counts bytes per connection, not per
//     request (fresh-connection.ts). The AI SDK has no idea how to do either,
//     so something has to sit in front of it.
//  2. Token lifecycle. The proxy token expires every 24h. Provider config in
//     opencode.json is static, so a rotating key cannot live there; the relay
//     injects a fresh one per request instead.
//
// The opencode sidecar therefore talks plain OpenAI-compatible HTTP to
// 127.0.0.1, and every 1CCoder-specific concern stays here.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { AddressInfo } from "node:net"

import { fetchOnFreshConnection } from "./fresh-connection"
import { SERVER_URLS } from "../endpoints"
import { ServerSelector } from "./servers"
import { ACCOUNT_BLOCKED, RETRIES_STOPPED, SUPPORT_CONTACT } from "./support"

export const DEFAULT_AUTH_BASE_URL = SERVER_URLS[0] ?? ""

export interface RelayCredential {
  email: string
  credential: string
}

export interface ProxyToken {
  token: string
  expiresAt: number
}

/** The account's credits, as GET /llm/balance reports them. Times in ms. */
export interface CreditBalance {
  spent: number
  limit: number
  left: number
  periodEnd: number
  /** The operator blocked the account; the figures say nothing useful then. */
  blocked: boolean
}

/** The model's context window and output ceiling, from the server's /llm/config. */
export interface ModelLimits {
  context: number
  output: number
}

export interface RelayOptions {
  /** Returns the stored auth credential, or null when signed out. */
  getCredential: () => Promise<RelayCredential | null>
  /**
   * Runs a 1C operation for a session. Present so the sidecar plugin can ask
   * for infobase work without ever holding the credentials -- the loopback
   * server already exists, so this needs no second listener.
   */
  runInfobaseOperation?: (request: unknown) => Promise<unknown>
  /**
   * Describes the session's bound profile for the same plugin. Read-only and
   * secret-free, which is why it needs none of the ceremony an operation does.
   */
  describeInfobaseProfile?: (request: unknown) => Promise<unknown>
  /**
   * Opens the MCP Toolkit for the session's profile, on request.
   *
   * The toolkit is no longer started when a profile is bound: most sessions
   * never touch the infobase, and opening 1C for them put a window on screen
   * before the user had typed anything. So the agent asks for it when it
   * actually needs one -- which it can only do through a tool that exists
   * whether or not the toolkit is up, and every `1c_*` query tool comes FROM
   * the toolkit. This is that door.
   */
  startInfobaseToolkit?: (request: unknown) => Promise<unknown>
  /** What this base offers for print forms, asked of the running toolkit. */
  describePrintCapabilities?: (request: unknown) => Promise<unknown>
  /**
   * Further plugin requests, by path under `/1c/`: JSON in, JSON out, no
   * credentials, nothing streamed. The four above predate this table and keep
   * their own fields; new ones go here rather than repeating the handler.
   */
  infobaseRoutes?: Readonly<Record<string, (request: unknown) => Promise<unknown>>>
  /** One fixed address, never probed. Tests use it; the app passes `servers`. */
  baseUrl?: string
  /** Addresses of our service in order of preference (servers.ts). */
  servers?: readonly string[]
  fetchImpl?: typeof fetch
  now?: () => number
  /** STREAM_FROZEN_MIN_MS, shorter. For tests, which run on real timers. */
  frozenMinMs?: number
  /**
   * Records something worth knowing about a request. A hook rather than a
   * direct import because main/logging pulls in electron, and this module is
   * unit-tested outside it.
   */
  log?: (message: string, extra?: Record<string, unknown>) => void
  /** Told the account's balance whenever it is re-read after a model request. */
  onBalance?: (balance: CreditBalance) => void
}

/**
 * An error the client has to see, followed by the terminator that tells it the
 * stream is over. Both halves matter: without the message the session sees a
 * stream that silently stops, which is the bug this guards against; without the
 * terminator it sees an unfinished one, and starts the same guesswork again.
 */
function streamErrorFrame(message: string, type = "1ccoder_relay"): Buffer {
  return Buffer.from(`data: ${JSON.stringify({ error: { message, type } })}\n\ndata: [DONE]\n\n`, "utf8")
}

/**
 * The error type of a failure worth retrying: the answer broke on the way, not
 * because of anything in the request. opencode's retry recognises it.
 *
 * 2026-09-26, debrief14.md §14.4: these frames were matched by none of
 * opencode's retry patterns, so a stream that broke mid-answer ended the turn
 * outright -- the session sat idle until the user typed «продолжай».
 */
export const TRANSIENT_ERROR_TYPE = "1ccoder_transient"

/**
 * Said in-band when the response stream breaks after the first byte has gone
 * out. By then the status line is long since on the wire, so there is no HTTP
 * error code left to fail with, and a client that merely sees the stream stop
 * cannot tell a dropped answer from a finished one -- which is exactly how a
 * broken response used to reach the session looking like a complete one.
 */
export const STREAM_ERROR_FRAME = streamErrorFrame("The connection to the model dropped mid-response", TRANSIENT_ERROR_TYPE)

/** The same, for a stream that ended tidily but short. */
export const STREAM_TRUNCATED_FRAME = streamErrorFrame("The model response ended before it was complete", TRANSIENT_ERROR_TYPE)

/**
 * And for a stream that does neither -- it stays open and stops saying
 * anything. The third shape, and the one nothing was watching for: the error
 * frame needs a throw and the truncated frame needs a close, and a hang offers
 * neither. It is the worst of the three to sit through, because the session
 * still looks like it is working. On 2026-09-16 that cost sixteen minutes
 * before the user typed "continue".
 */
export const STREAM_STALLED_FRAME = streamErrorFrame("The model stopped responding mid-answer", TRANSIENT_ERROR_TYPE)

/**
 * How long the stream may go without a data frame before we call it dead.
 *
 * The server applies the same guard to its own upstream, but it cannot see
 * this hop -- and this hop crosses the DPI that the whole relay exists to work
 * around, so it is precisely the one that can go quiet. Slightly longer than
 * the server's 180s, so that when the upstream is the culprit the server names
 * it first and the message says which leg failed.
 */
export const STREAM_STALL_MS = 210_000

/**
 * The fourth shape: not the model going quiet, the connection. On networks
 * that cap each TCP connection to our host at ~16-24 KB the answer simply
 * freezes part-way, and STREAM_STALL_MS let each one cost 210 s before the
 * retry (2026-10-05, SERVER_ST: the same request billed six times, ~225 s
 * apart).
 *
 * Data frames cannot tell the two apart: on 2026-10-07 a healthy model writing
 * a large tool call went up to 105 s between them. So the server sends a
 * comment every few seconds while it has nothing else to say, and a connection
 * that carries no bytes at all -- heartbeats included -- for this long is
 * frozen. Only armed when /llm/config says the server sends them.
 */
export const STREAM_FROZEN_MIN_MS = 30_000

export const STREAM_FROZEN_FRAME = streamErrorFrame(
  "The connection to the 1CCoder server froze mid-answer",
  TRANSIENT_ERROR_TYPE,
)

/**
 * Answers that failed in a row, in one session, before the relay stops
 * passing retries on.
 *
 * 2026-10-05, SERVER_ST. Every frozen answer was retried by opencode (five
 * times a step) and then resumed by auto-resume (three times an hour), and the
 * server billed every attempt in full: the model answered each time, and the
 * answer was lost on the way. Nothing told the person why the session was
 * crawling. The next request after this many is refused before it costs
 * anything, in words that neither retry layer acts on.
 */
export const TRANSIENT_FAILURE_LIMIT = 3

/** Failures further apart than this are not "in a row". */
export const TRANSIENT_FAILURE_WINDOW_MS = 30 * 60_000

/** Said instead of a fourth attempt. In Russian: it is the person's to act on. */
export function retriesStoppedMessage(failures: number): string {
  return (
    `${RETRIES_STOPPED}: ${failures} ответа модели подряд оборвались по дороге — связь с сервером 1CCoder ` +
    "нестабильна. Чтобы не расходовать кредиты впустую, ход остановлен. Проверьте подключение к интернету " +
    `и напишите «продолжай». Если не поможет, напишите в поддержку: ${SUPPORT_CONTACT}`
  )
}

/** The type of that refusal: neither transient nor about money. */
export const RETRIES_STOPPED_ERROR_TYPE = "1ccoder_retries_stopped"

/**
 * Where the last complete SSE event in `buffer` ends, or 0 if none has.
 *
 * 2026-10-05, SERVER_ST: a stream that broke mid-frame had the relay's error
 * frame written straight after the half-received one, so the client parsed
 * `data: {"choi` + `data: {"error"…` as one event and reported "JSON parsing
 * failed" instead of a retryable error. Only whole events are passed on; a
 * partial one is held until it completes, and dropped if the stream fails.
 */
export function completeEventsEnd(buffer: Buffer): number {
  const lf = buffer.lastIndexOf("\n\n")
  const crlf = buffer.lastIndexOf("\r\n\r\n")
  return Math.max(lf < 0 ? 0 : lf + 2, crlf < 0 ? 0 : crlf + 4)
}

/**
 * How long the upstream may take to produce RESPONSE HEADERS.
 *
 * Deliberately generous: a cache-missed turn in a long session uploads
 * hundreds of thousands of tokens before the model says anything, and the
 * slowest healthy first-token wait observed was 550 s. Ten minutes leaves room
 * above that while still being two orders of magnitude below the 81- and
 * 213-minute hangs this exists to cut short.
 *
 * Longer than STREAM_STALL_MS on purpose, for the same reason that guard is
 * longer than the server's: whichever leg actually failed should be the one
 * that names the failure.
 */
/**
 * The response content type, WITH the charset.
 *
 * 2026-09-23, debrief8.md §E11. Without `charset=utf-8` a client is entitled to
 * guess, and PowerShell 5.1 guesses the system ANSI codepage -- so every Cyrillic
 * value this relay returns (profile name, user name, platform paths) came back as
 * `?`. An agent reading it concluded the data was corrupted "on the relay's side",
 * which was the wrong layer and cost it a detour.
 */
const JSON_UTF8 = "application/json; charset=utf-8"

export const UPSTREAM_HEADERS_MS = 600_000

/**
 * Whether the caller asked for a streamed answer.
 *
 * 2026-09-23, debrief9.md §9.6. Only a streaming request can be answered before
 * the upstream has said anything: a JSON response is parsed whole, so committing
 * to `200` for one would turn an upstream error into a malformed body. Parsed
 * rather than pattern-matched because `"stream"` also appears in message text.
 */
export function asksForStream(body: Buffer): boolean {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"))
    return typeof parsed === "object" && parsed !== null && (parsed as { stream?: unknown }).stream === true
  } catch {
    return false
  }
}

/** What an upstream failure is called once the status line has already gone out. */
export function upstreamMessage(status: number, detail: string): string {
  const trimmed = detail.trim()
  // The upstream's own words when it gave any, because "502" alone sends the
  // agent looking in the wrong place -- see §9.7 on reasoning from a bad view.
  const said = trimmed ? `: ${trimmed.slice(0, 200)}` : ""
  if (status === 401) return `1CCoder is not authorised to reach the model${said}`
  if (status === 429) return `The model is rate limiting this account${said}`
  if (status >= 500) return `The model service failed (${status})${said}`
  return `The model request was rejected (${status})${said}`
}

/** Said when the upstream never answered at all, as opposed to going quiet mid-answer. */
export const UPSTREAM_SILENT = "The model did not respond"

/** A model request that failed before any answer came back: no response at all. */
export const UPSTREAM_UNREACHABLE = "The model service could not be reached"

/**
 * What a failed fetch actually was. undici reports every network failure as
 * "fetch failed" and puts the useful part -- ECONNRESET, a connect timeout,
 * a TLS error -- in `cause`.
 */
export function fetchErrorReason(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as { cause?: unknown }).cause
  if (!(cause instanceof Error)) return error.message
  const code = (cause as { code?: unknown }).code
  return `${error.message} (${typeof code === "string" ? `${code}: ` : ""}${cause.message})`
}

/**
 * The error type for a spent budget. Deliberately not TRANSIENT_ERROR_TYPE:
 * retrying cannot help until the period ends or someone tops the account up,
 * and a retry loop against a 402 would only hide the reason from the person.
 */
export const CREDITS_ERROR_TYPE = "1ccoder_credits"


/**
 * The server's 402 `credits_exhausted` turned into words, or null for any other
 * failure -- including a 402 without that code, which is OpenRouter refusing
 * our own key and not the pilot's budget.
 *
 * In Russian, unlike the relay's other messages: this is the one failure that
 * is the person's to act on rather than ours to diagnose, and it is shown to
 * them as the session's error.
 */
export function creditsExhaustedMessage(status: number, detail: string): string | null {
  if (status !== 402) return null
  const body = parseJson(detail)
  if (body?.code !== "credits_exhausted") return null
  const end = typeof body.period_end === "number" ? new Date(body.period_end * 1000) : null
  const until = end
    ? ` Новые кредиты поступят ${String(end.getDate()).padStart(2, "0")}.${String(end.getMonth() + 1).padStart(2, "0")}.`
    : ""
  return `Кредиты 1CCoder на этот период закончились.${until} Чтобы продолжить раньше, напишите в поддержку: ${SUPPORT_CONTACT}`
}

/**
 * The error type for a blocked account. Not transient, like CREDITS_ERROR_TYPE:
 * only the operator can lift a block, so a retry is one more refused request.
 */
export const ACCOUNT_BLOCKED_ERROR_TYPE = "1ccoder_blocked"

/** Said instead of "not signed in" or "rejected (403)": signing in again cannot help. */
export const ACCOUNT_BLOCKED_MESSAGE = `${ACCOUNT_BLOCKED}. Если это ошибка, напишите в поддержку: ${SUPPORT_CONTACT}`

/**
 * Whether the server refused because the operator blocked the account. Only a
 * 403 with that code: a bare 403 is something else and keeps its own words.
 */
export function isAccountBlocked(status: number, detail: string): boolean {
  return status === 403 && parseJson(detail)?.code === "account_blocked"
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * The session id opencode sends with each model request. For a provider that is
 * not one of opencode's own it is X-Session-Id (session/llm/request.ts). Passed
 * on as X-1CCoder-Session, so the server's ledger can price each session.
 */
export function sessionIdOf(req: IncomingMessage): string | undefined {
  const value = req.headers["x-session-id"] ?? req.headers["x-1ccoder-session"]
  const id = Array.isArray(value) ? value[0] : value
  return id ? id.slice(0, 128) : undefined
}

/**
 * How long after a model request the balance is re-read. A turn is many
 * requests in quick succession; one read after the burst settles is enough,
 * and gives the server's ledger a moment to settle the last one.
 */
export const BALANCE_REFRESH_MS = 1_500

/**
 * What counts as progress. An intermediary's keep-alive comment (": OPENROUTER
 * PROCESSING") is bytes on the wire and would refresh any byte-based deadline
 * forever while saying nothing about whether an answer is still coming -- the
 * exact mechanism of the stall this guards against.
 */
const SSE_DATA = "data:"
/** Enough to catch the marker split across two reads. */
const PROGRESS_OVERLAP = 8

/**
 * Tracks whether the stream is still producing data frames. Exported for
 * tests: a deadline that counts keep-alives as progress is no deadline, and a
 * deadline that ignores real frames kills healthy answers.
 */
export function createStallWatcher(now: () => number = Date.now) {
  let lastProgress = now()
  let lastByte = now()
  let tail = ""
  return {
    observe(value: Uint8Array) {
      lastByte = now()
      const text = tail + Buffer.from(value).toString("latin1")
      if (text.includes(SSE_DATA)) lastProgress = now()
      tail = text.slice(-PROGRESS_OVERLAP)
    },
    /** Milliseconds left before the stream is declared stalled. */
    remaining(budgetMs: number): number {
      return budgetMs - (now() - lastProgress)
    },
    /** Milliseconds left before the connection is declared frozen: any byte counts. */
    remainingLive(budgetMs: number): number {
      return budgetMs - (now() - lastByte)
    },
  }
}

/**
 * Whether a passing stream carried an error event of the server's own (its
 * upstream broke, stalled or ended short): the answer is then as lost as one
 * the relay cut, and counts toward the limit. Anchored to an event that IS an
 * error object, so a model merely quoting one in its text does not count.
 */
const IN_BAND_TRANSIENT = /^data: ?\{\s*"error"/m

/**
 * The two ways an OpenAI-compatible stream says it reached the end: the
 * terminator frame, and the string finish_reason every provider puts on its
 * last content chunk. The null finish_reason on intermediate chunks does not
 * count, which is why this is a pattern and not a substring test.
 */
const STREAM_END = /\[DONE\]|"finish_reason"\s*:\s*"/
/**
 * Reads split wherever the network splits them, so a terminator can straddle
 * two of them. Carrying this many bytes forward is well beyond the longest
 * match STREAM_END can make.
 */
const STREAM_END_OVERLAP = 64

/**
 * Watches a passing SSE stream for its terminator, so a stream that stops short
 * can be told from one that finished. Exported for tests: getting this wrong
 * either swallows a dropped answer or condemns a good one.
 */
export function createStreamEndWatcher() {
  let ended = false
  let tail = ""
  return {
    observe(value: Uint8Array) {
      if (ended) return
      // latin1 maps bytes one to one, so a multi-byte character split across
      // two reads cannot swallow the pattern the way a partial utf8 decode can.
      // Everything being searched for is ASCII, so nothing is lost.
      const text = tail + Buffer.from(value).toString("latin1")
      if (STREAM_END.test(text)) {
        ended = true
        tail = ""
        return
      }
      tail = text.slice(-STREAM_END_OVERLAP)
    },
    get ended() {
      return ended
    },
  }
}

/**
 * Refresh a minute early rather than exactly at expiry: a token that expires
 * mid-flight surfaces to the user as a failed request, and a minute of unused
 * validity costs nothing.
 */
export const TOKEN_REFRESH_MARGIN_MS = 60_000

export function isTokenUsable(token: ProxyToken | null, now: number): boolean {
  if (!token) return false
  return token.expiresAt - TOKEN_REFRESH_MARGIN_MS > now
}

/**
 * Splits a body into sub-threshold pieces. Exported for tests: this is the part
 * that must be exactly right, since an off-by-one here corrupts every request.
 */
export function planChunks(
  totalBytes: number,
  chunkSize: number,
): Array<{ index: number; start: number; end: number }> {
  if (chunkSize <= 0) throw new Error("chunkSize must be positive")
  const plan: Array<{ index: number; start: number; end: number }> = []
  let index = 0
  for (let start = 0; start < totalBytes; start += chunkSize) {
    plan.push({ index, start, end: Math.min(start + chunkSize, totalBytes) })
    index++
  }
  return plan
}

/** Ids are used as a path segment server-side, which rejects anything non-alphanumeric. */
export function newUploadId(): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return `u${Date.now().toString(36)}${rand}`.replace(/[^a-z0-9]/gi, "").slice(0, 40)
}

export class LlmRelay {
  private server: Server | null = null
  private token: ProxyToken | null = null
  private tokenInFlight: Promise<ProxyToken | null> | null = null
  private chunkSize = 12_000
  private limits: ModelLimits | null = null
  private balanceTimer: ReturnType<typeof setTimeout> | null = null
  private lastBalance: CreditBalance | null = null
  /**
   * The last /llm/token refusal said the account is blocked. Not a cache that
   * short-cuts requests: every request still asks the server, so an unblock
   * works on the next one, with no restart and no new sign-in.
   */
  private blocked = false
  /** The server's heartbeat interval; 0 until /llm/config says it sends one. */
  private heartbeatMs = 0
  /** Answers lost in a row, per session (TRANSIENT_FAILURE_LIMIT). */
  private readonly failures = new Map<string, { count: number; at: number }>()
  private readonly servers: ServerSelector
  private readonly doFetch: typeof fetch
  private readonly now: () => number

  constructor(private readonly options: RelayOptions) {
    this.doFetch = options.fetchImpl ?? fetchOnFreshConnection
    this.now = options.now ?? (() => Date.now())
    this.servers = new ServerSelector({
      servers: options.baseUrl ? [options.baseUrl] : options.servers,
      fetchImpl: this.doFetch,
      now: this.now,
      log: (message, extra) => this.log(message, extra),
    })
  }

  get port(): number | null {
    const address = this.server?.address()
    return address && typeof address === "object" ? (address as AddressInfo).port : null
  }

  async start(): Promise<number> {
    if (this.server) return this.port!
    // Which address answers decides everything after it, the config included.
    await this.servers.probe()
    // Server-side chunk size, so the DPI workaround can be retuned without
    // shipping a new desktop build. A failure here is not fatal: the built-in
    // default still works, it is just not retunable this session.
    await this.refreshConfig().catch(() => undefined)

    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        const reason = fetchErrorReason(error)
        this.log("relay request failed", { error: reason, headersSent: res.headersSent })
        // Past the status line only the body can carry the reason; a bare end
        // reads to the client as an answer that was simply empty.
        if (res.headersSent && !res.writableEnded) {
          res.write(streamErrorFrame(`${UPSTREAM_UNREACHABLE}: ${reason}`, TRANSIENT_ERROR_TYPE))
          res.end()
          return
        }
        this.fail(res, 502, reason)
      })
    })
    this.server = server

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      // Loopback only. Binding elsewhere would expose a token-injecting proxy
      // to the local network.
      server.listen(0, "127.0.0.1", () => resolve())
    })
    return this.port!
  }

  /**
   * The server this relay talks to right now; telemetry, sign-in and updates go
   * there too. Read it per request: it changes when the preferred one fails.
   */
  get serverUrl(): string {
    return this.servers.current
  }

  /** Known once start() has read the server config; null when the server does not say. */
  get modelLimits(): ModelLimits | null {
    return this.limits
  }

  get balance(): CreditBalance | null {
    return this.lastBalance
  }

  async close(): Promise<void> {
    if (this.balanceTimer) clearTimeout(this.balanceTimer)
    this.balanceTimer = null
    const server = this.server
    if (!server) return
    this.server = null
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async refreshConfig(): Promise<void> {
    const response = await this.doFetch(`${this.serverUrl}/llm/config`)
    if (!response.ok) return
    const data = (await response.json()) as {
      chunk_size?: number
      model_limits?: Partial<ModelLimits> | null
      servers?: unknown
      heartbeat_seconds?: unknown
    }
    if (typeof data.chunk_size === "number" && data.chunk_size > 0) this.chunkSize = data.chunk_size
    if (typeof data.heartbeat_seconds === "number" && data.heartbeat_seconds > 0)
      this.heartbeatMs = data.heartbeat_seconds * 1000
    // A fixed address (tests) stays fixed.
    if (!this.options.baseUrl && Array.isArray(data.servers))
      this.servers.setServers(data.servers.filter((url): url is string => typeof url === "string"))
    const limits = data.model_limits
    if (limits && typeof limits.context === "number" && limits.context > 0)
      this.limits = { context: limits.context, output: typeof limits.output === "number" ? limits.output : 0 }
  }

  /** Re-reads the balance and passes it on. Null when signed out or unreachable. */
  async refreshBalance(): Promise<CreditBalance | null> {
    const token = await this.getToken()
    // No token because of the block itself: the note still has to say so.
    if (!token && this.blocked) return this.publishBalance({ spent: 0, limit: 0, left: 0, periodEnd: 0, blocked: true })
    if (!token) return null
    try {
      const response = await this.doFetch(`${this.serverUrl}/llm/balance`, {
        headers: { Authorization: `Bearer ${token.token}` },
      })
      if (!response.ok) return null
      const data = (await response.json()) as Record<string, unknown>
      if (typeof data.credits_left !== "number" || typeof data.credits_limit !== "number") return null
      return this.publishBalance({
        spent: Number(data.credits_spent ?? 0),
        limit: data.credits_limit,
        left: data.credits_left,
        periodEnd: Number(data.period_end ?? 0) * 1000,
        blocked: data.status === "blocked",
      })
    } catch {
      return null
    }
  }

  private publishBalance(balance: CreditBalance): CreditBalance {
    this.lastBalance = balance
    this.options.onBalance?.(balance)
    return balance
  }

  private scheduleBalanceRefresh() {
    if (!this.options.onBalance) return
    if (this.balanceTimer) clearTimeout(this.balanceTimer)
    this.balanceTimer = setTimeout(() => {
      this.balanceTimer = null
      void this.refreshBalance()
    }, BALANCE_REFRESH_MS)
  }

  /** Cached, refreshed ahead of expiry, and de-duplicated so a burst of parallel
   * requests triggers one token fetch rather than one per request. */
  async getToken(force = false): Promise<ProxyToken | null> {
    if (!force && isTokenUsable(this.token, this.now())) return this.token
    if (this.tokenInFlight) return this.tokenInFlight

    this.tokenInFlight = (async () => {
      try {
        const credential = await this.options.getCredential()
        if (!credential) return null
        const response = await this.doFetch(`${this.serverUrl}/llm/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ credential: credential.credential }),
        })
        if (!response.ok) {
          this.blocked = isAccountBlocked(response.status, await response.text().catch(() => ""))
          return null
        }
        this.blocked = false
        const data = (await response.json()) as { token: string; expires_at: number; chunk_size?: number }
        if (typeof data.chunk_size === "number" && data.chunk_size > 0) this.chunkSize = data.chunk_size
        this.token = { token: data.token, expiresAt: data.expires_at * 1000 }
        return this.token
      } catch {
        return null
      } finally {
        this.tokenInFlight = null
      }
    })()
    return this.tokenInFlight
  }

  private log(message: string, extra?: Record<string, unknown>) {
    this.options.log?.(message, extra)
  }

  private fail(res: ServerResponse, status: number, message: string, type = "1ccoder_relay") {
    if (res.headersSent) {
      res.end()
      return
    }
    res.writeHead(status, { "Content-Type": JSON_UTF8 })
    res.end(JSON.stringify({ error: { message, type } }))
  }

  /**
   * The same refusal, whichever side of the status line we are on.
   *
   * §9.6 opens the response before the upstream is asked, so a failure after
   * that point has no status code left to use. The message still has to arrive,
   * because a stream that merely stops is the failure mode this relay exists to
   * make impossible.
   */
  private failMidStream(res: ServerResponse, streaming: boolean, status: number, message: string, type?: string) {
    if (!streaming) {
      this.fail(res, status, message, type)
      return
    }
    res.write(streamErrorFrame(message, type))
    res.end()
  }

  private async readBody(req: IncomingMessage): Promise<Buffer> {
    const parts: Buffer[] = []
    for await (const chunk of req) parts.push(chunk as Buffer)
    return Buffer.concat(parts)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": JSON_UTF8 })
      res.end(JSON.stringify({ status: "ok" }))
      return
    }
    // 1CCoder infobase operations. Kept on this server rather than a second
    // one: it is already bound to 127.0.0.1 on an ephemeral port that only our
    // own sidecar is told about.
    if (req.method === "POST" && req.url === "/1c/exec") {
      if (!this.options.runInfobaseOperation) {
        this.fail(res, 501, "Infobase operations are not available")
        return
      }
      let request: unknown
      try {
        request = JSON.parse((await this.readBody(req)).toString("utf8"))
      } catch {
        this.fail(res, 400, "Malformed request")
        return
      }
      const result = await this.options.runInfobaseOperation(request)
      res.writeHead(200, { "Content-Type": JSON_UTF8 })
      res.end(JSON.stringify(result))
      return
    }

    if (req.method === "POST" && req.url === "/1c/profile") {
      if (!this.options.describeInfobaseProfile) {
        this.fail(res, 501, "Infobase operations are not available")
        return
      }
      let request: unknown
      try {
        request = JSON.parse((await this.readBody(req)).toString("utf8"))
      } catch {
        this.fail(res, 400, "Malformed request")
        return
      }
      const description = await this.options.describeInfobaseProfile(request)
      res.writeHead(200, { "Content-Type": JSON_UTF8 })
      res.end(JSON.stringify(description))
      return
    }

    if (req.method === "POST" && req.url === "/1c/toolkit/start") {
      if (!this.options.startInfobaseToolkit) {
        this.fail(res, 501, "Infobase operations are not available")
        return
      }
      let request: unknown
      try {
        request = JSON.parse((await this.readBody(req)).toString("utf8"))
      } catch {
        this.fail(res, 400, "Malformed request")
        return
      }
      const started = await this.options.startInfobaseToolkit(request)
      res.writeHead(200, { "Content-Type": JSON_UTF8 })
      res.end(JSON.stringify(started))
      return
    }

    if (req.method === "POST" && req.url === "/1c/print-capabilities") {
      if (!this.options.describePrintCapabilities) {
        this.fail(res, 501, "Infobase operations are not available")
        return
      }
      let request: unknown
      try {
        request = JSON.parse((await this.readBody(req)).toString("utf8"))
      } catch {
        this.fail(res, 400, "Malformed request")
        return
      }
      const described = await this.options.describePrintCapabilities(request)
      res.writeHead(200, { "Content-Type": JSON_UTF8 })
      res.end(JSON.stringify(described))
      return
    }

    const route = req.method === "POST" && req.url?.startsWith("/1c/") ? this.options.infobaseRoutes?.[req.url.slice(4)] : undefined
    if (route) {
      let request: unknown
      try {
        request = JSON.parse((await this.readBody(req)).toString("utf8"))
      } catch {
        this.fail(res, 400, "Malformed request")
        return
      }
      const answer = await route(request)
      res.writeHead(200, { "Content-Type": JSON_UTF8 })
      res.end(JSON.stringify(answer))
      return
    }

    if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
      this.fail(res, 404, "Not found")
      return
    }

    try {
      await this.complete(req, res)
    } finally {
      // Every request that may have spent something, refused or not: a 402
      // has to move the figure on screen to zero as much as a success does.
      this.scheduleBalanceRefresh()
    }
  }

  private async complete(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req)
    const session = sessionIdOf(req)
    const wantsStream = asksForStream(body)

    // TRANSIENT_FAILURE_LIMIT: refused before it reaches the server, so the
    // attempt that would only be lost again costs nothing. The count starts
    // over, so the person's «продолжай» gets the full allowance.
    const key = session ?? ""
    const lost = this.failures.get(key)
    if (lost && this.now() - lost.at < TRANSIENT_FAILURE_WINDOW_MS && lost.count >= TRANSIENT_FAILURE_LIMIT) {
      this.failures.delete(key)
      this.log("retries stopped", { session, failures: lost.count, server: this.serverUrl })
      // 424, not a 5xx: opencode retries every 5xx whatever it says.
      this.refuse(res, wantsStream, 424, retriesStoppedMessage(lost.count), RETRIES_STOPPED_ERROR_TYPE)
      return
    }

    const outcome = await this.answer(body, session, wantsStream, res)
    if (outcome === "delivered") {
      this.failures.delete(key)
      this.servers.reportSuccess()
    }
    if (outcome === "lost") {
      const count = lost && this.now() - lost.at < TRANSIENT_FAILURE_WINDOW_MS ? lost.count + 1 : 1
      this.failures.set(key, { count, at: this.now() })
      // A different address may not be losing them.
      this.servers.reportFailure()
    }
  }

  /** The same refusal on either side of the status line. */
  private refuse(res: ServerResponse, streaming: boolean, status: number, message: string, type: string) {
    if (!streaming) {
      res.writeHead(status, { "Content-Type": JSON_UTF8 })
      res.end(JSON.stringify({ error: { message, type } }))
      return
    }
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" })
    res.end(streamErrorFrame(message, type))
  }

  /**
   * Relays one model request. "lost" is an answer that broke on the way --
   * the kind a retry might fix and that counts toward the limit; "other" is a
   * refusal that needs a person (sign-in, money, a bad request).
   */
  private async answer(
    body: Buffer,
    session: string | undefined,
    wantsStream: boolean,
    res: ServerResponse,
  ): Promise<"delivered" | "lost" | "other"> {
    let token = await this.getToken()
    if (!token && this.blocked) {
      this.refuse(res, wantsStream, 403, ACCOUNT_BLOCKED_MESSAGE, ACCOUNT_BLOCKED_ERROR_TYPE)
      return "other"
    }
    if (!token) {
      this.fail(res, 401, "1CCoder is not signed in")
      return "other"
    }

    // 2026-09-23, debrief9.md §9.6. Headers go out BEFORE the upstream is asked,
    // for a streaming request. UPSTREAM_HEADERS_MS above allows the model 600 s
    // to produce its first byte, on the evidence that 550 s happens on a
    // cache-missed turn -- but the client waiting on us is undici, whose
    // `headersTimeout` is 300 s and cannot be raised by a signal (the same
    // property that broke the plugin's transport, C2/D1). So every first-token
    // wait between 300 s and 600 s was guaranteed to fail at the client while
    // this relay sat patiently inside its own budget, and one did, at exactly
    // 300.000 s:
    //
    //   AI_APICallError: Cannot connect to API: Headers Timeout Error
    //
    // Answering the status line immediately makes the client's header wait
    // milliseconds, which is the only way to stop a deadline we do not own from
    // overriding the one we chose. Everything that can still go wrong upstream
    // is reportable in-band, which is how this relay already reports a stream
    // that breaks, stalls or ends short.
    if (wantsStream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      })
      // flushHeaders, not a comment frame: the headers have to leave now, and
      // nothing may enter the body that the client did not get from the model.
      res.flushHeaders()
    }

    // 2026-10-05, first clean-machine install: on that network the chunks
    // went through and the final POST never reached nginx. fetch threw, the
    // throw escaped to the server's catch, and fail() -- the status line long
    // gone -- could only end the response. The sidecar got a well-formed,
    // empty stream; opencode called it "ended before it produced an answer"
    // twice and gave up, and the reason was logged nowhere. A request that
    // never got an answer is said in-band, as transient, with its cause.
    let upstream: Response
    try {
      upstream = await this.send(body, token.token, session)
      // A 401 means the token died sooner than its stated expiry (server restart,
      // secret rotation). Refresh once and retry rather than surfacing an error.
      if (upstream.status === 401) {
        token = await this.getToken(true)
        if (!token && this.blocked) {
          this.failMidStream(res, wantsStream, 403, ACCOUNT_BLOCKED_MESSAGE, ACCOUNT_BLOCKED_ERROR_TYPE)
          return "other"
        }
        if (!token) {
          this.failMidStream(res, wantsStream, 401, "1CCoder session expired")
          return "other"
        }
        upstream = await this.send(body, token.token, session)
      }
    } catch (error) {
      const reason = fetchErrorReason(error)
      this.log("model request failed before an answer", {
        error: reason,
        streaming: wantsStream,
        bytes: body.byteLength,
        server: this.serverUrl,
      })
      this.failMidStream(res, wantsStream, 502, `${UPSTREAM_UNREACHABLE}: ${reason}`, TRANSIENT_ERROR_TYPE)
      return "lost"
    }

    const contentType = upstream.headers.get("content-type")
    const refusal = upstream.status >= 500 || upstream.status === 429 ? "lost" : "other"

    // The status line is already gone, so an upstream error has to be said
    // in-band or not at all.
    if (wantsStream && !(contentType ?? "").includes("text/event-stream")) {
      const detail = await upstream.text().catch(() => "")
      this.log("upstream did not stream", { status: upstream.status, detail: detail.slice(0, 300) })
      const exhausted = creditsExhaustedMessage(upstream.status, detail)
      if (exhausted) {
        res.write(streamErrorFrame(exhausted, CREDITS_ERROR_TYPE))
        res.end()
        return "other"
      }
      if (isAccountBlocked(upstream.status, detail)) {
        res.write(streamErrorFrame(ACCOUNT_BLOCKED_MESSAGE, ACCOUNT_BLOCKED_ERROR_TYPE))
        res.end()
        return "other"
      }
      res.write(streamErrorFrame(upstreamMessage(upstream.status, detail), refusal === "lost" ? TRANSIENT_ERROR_TYPE : undefined))
      res.end()
      return refusal
    }

    // The server's own JSON would reach the session as "rejected (403)", which
    // reads like a fault of ours; the body is one short line, so read it whole.
    if (!wantsStream && upstream.status === 403) {
      const detail = await upstream.text().catch(() => "")
      if (isAccountBlocked(upstream.status, detail)) {
        this.fail(res, 403, ACCOUNT_BLOCKED_MESSAGE, ACCOUNT_BLOCKED_ERROR_TYPE)
        return "other"
      }
      res.writeHead(403, contentType ? { "Content-Type": contentType } : {})
      res.end(detail)
      return "other"
    }

    if (!wantsStream) {
      const headers: Record<string, string> = {}
      if (contentType) headers["Content-Type"] = contentType
      res.writeHead(upstream.status, headers)
    }

    if (!upstream.body) {
      res.end(Buffer.from(await upstream.arrayBuffer()))
      return upstream.ok ? "delivered" : refusal
    }
    // Only an SSE body has anywhere to put an in-band error; a JSON one is
    // parsed whole, and a short read fails on its own terms at the client.
    const streaming = (contentType ?? "").includes("text/event-stream")
    const watcher = createStreamEndWatcher()
    const stall = createStallWatcher()
    const frozenMs =
      this.heartbeatMs > 0 ? Math.max(this.options.frozenMinMs ?? STREAM_FROZEN_MIN_MS, 3 * this.heartbeatMs) : 0
    const reader = upstream.body.getReader()
    // The part of an SSE event that has arrived but not yet ended
    // (completeEventsEnd): held back, so an error frame never follows half of one.
    let held = Buffer.alloc(0)
    let inBandTransient = false
    let cut: "stalled" | "frozen" | null = null
    try {
      for (;;) {
        // Race the read against the inactivity deadlines. An unraced read on a
        // stream that never speaks again waits forever, which is the bug.
        const quiet = stall.remaining(STREAM_STALL_MS)
        const live = frozenMs > 0 ? stall.remainingLive(frozenMs) : Number.POSITIVE_INFINITY
        // Decided before the wait, not after it: timer jitter would otherwise
        // let one deadline's timeout read as the other's.
        const waitingFor = live < quiet ? "frozen" : "stalled"
        const remaining = Math.min(quiet, live)
        if (remaining <= 0) {
          cut = waitingFor
          break
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        const deadline = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), remaining)
        })
        let result: Awaited<ReturnType<typeof reader.read>> | "timeout"
        try {
          result = await Promise.race([reader.read(), deadline])
        } finally {
          if (timer) clearTimeout(timer)
        }
        if (result === "timeout") {
          cut = waitingFor
          // The read is still outstanding; cancelling releases it and the
          // socket rather than leaving both pinned to a dead response.
          void reader.cancel().catch(() => undefined)
          break
        }
        const { done, value } = result
        if (done) break
        if (!value) continue
        watcher.observe(value)
        stall.observe(value)
        if (!streaming) {
          res.write(Buffer.from(value))
          continue
        }
        held = Buffer.concat([held, Buffer.from(value)])
        const end = completeEventsEnd(held)
        if (end === 0) continue
        const events = held.subarray(0, end)
        if (IN_BAND_TRANSIENT.test(events.toString("latin1"))) inBandTransient = true
        res.write(events)
        held = held.subarray(end)
      }
    } catch (error) {
      // Not fail(): that writes a status code, and the status line went out
      // with the first byte. Falling through to a bare res.end() here is what
      // made a dropped answer indistinguishable from a complete one.
      this.log("model response stream broke", {
        error: error instanceof Error ? error.message : String(error),
        streaming,
        heldBytes: held.byteLength,
        server: this.serverUrl,
      })
      if (streaming) res.write(STREAM_ERROR_FRAME)
      res.end()
      return "lost"
    }
    if (cut) {
      this.log(cut === "frozen" ? "model response connection froze" : "model response stream stalled", {
        budgetMs: cut === "frozen" ? frozenMs : STREAM_STALL_MS,
        heldBytes: held.byteLength,
        server: this.serverUrl,
      })
      if (streaming) res.write(cut === "frozen" ? STREAM_FROZEN_FRAME : STREAM_STALLED_FRAME)
      res.end()
      return "lost"
    }
    // A clean close is not the same as a complete answer. This relay exists
    // because a DPI resets long connections to our host, and an intermediary
    // that closes tidily part-way through an answer looks, from here, exactly
    // like a provider that finished.
    if (streaming && !watcher.ended) {
      this.log("model response stream ended without its terminator", { heldBytes: held.byteLength })
      res.write(STREAM_TRUNCATED_FRAME)
      res.end()
      return "lost"
    }
    // Finished, with a last event its sender never closed with a blank line.
    if (streaming && held.byteLength > 0) res.write(Buffer.concat([held, Buffer.from("\n\n")]))
    res.end()
    if (inBandTransient) return "lost"
    return upstream.ok ? "delivered" : refusal
  }

  /**
   * One upstream request, with a deadline on the WAIT FOR HEADERS only.
   *
   * 2026-09-21, debrief5.md §8.5. STREAM_STALL_MS guards the body once it is
   * flowing; nothing guarded the phase before that, and `doFetch` is plain
   * fetch with no signal. Two turns in one session therefore hung — 81 minutes
   * and 213 minutes — and both ended within two minutes of the app
   * reconnecting, not on any deadline of their own. That is 4h54m of a 10h
   * session spent on two requests that were never coming back, and it looked
   * from the outside like the agent had simply stopped working.
   *
   * The timer is cleared the moment headers arrive, so a long healthy answer
   * is never cut off: from there STREAM_STALL_MS owns the stream. Signals that
   * covered the whole response would kill exactly the slow-but-working case
   * this proxy exists to serve.
   */
  private async fetchWithHeaderDeadline(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(UPSTREAM_SILENT)), UPSTREAM_HEADERS_MS)
    try {
      return await this.doFetch(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  /** Small bodies go straight through; large ones are uploaded in pieces first. */
  private async send(body: Buffer, token: string, session?: string): Promise<Response> {
    // One address for the whole request: the chunks and the POST that assembles them.
    const base = this.serverUrl
    const url = `${base}/llm/v1/chat/completions`
    const sessionHeader: Record<string, string> = session ? { "X-1CCoder-Session": session } : {}
    if (body.byteLength <= this.chunkSize) {
      return this.fetchWithHeaderDeadline(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...sessionHeader },
        body: new Uint8Array(body),
      })
    }

    const uploadId = newUploadId()
    const plan = planChunks(body.byteLength, this.chunkSize)
    for (const piece of plan) {
      const slice = body.subarray(piece.start, piece.end)
      const response = await this.fetchWithHeaderDeadline(`${base}/llm/upload/${uploadId}/${piece.index}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          Authorization: `Bearer ${token}`,
          "X-Total-Chunks": String(plan.length),
        },
        body: new Uint8Array(slice),
      })
      if (!response.ok) return response
    }

    return this.fetchWithHeaderDeadline(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-1CCoder-Upload-Id": uploadId, ...sessionHeader },
    })
  }
}
