// HTTP client for the 1CCoder auth service (see ../../../../auth-service).
//
// Endpoints, per that service:
//   POST /register {email, phone?} -> {token}   409 if already an active account
//   POST /login    {email}         -> {token}   404 if no active account
//   POST /confirm  {token, code}   -> {email, credential}
//   any of the three: 403 {code: "account_blocked"} once the operator blocks the account
//   GET  /health

import type { AuthStringKey } from "./i18n"

import { SERVER_URLS } from "../../main/endpoints"

// Baked in at build time (ONECCODER_SERVER_URLS); the first is the preferred route.
const DEFAULT_AUTH_BASE_URL = SERVER_URLS[0] ?? ""

/**
 * An explicit override first; then the address the relay chose, so sign-in
 * takes the route that works on this network (the Moscow relay past the
 * per-connection cap, or the direct one when the relay is down); then the
 * direct address, when main has nothing to say.
 */
export async function authBaseUrl(): Promise<string> {
  const override = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_1CCODER_AUTH_URL
  if (override && override.length > 0) return override.replace(/\/+$/, "")
  const chosen = await window.api?.credits?.serverUrl?.().catch(() => null)
  return chosen ?? DEFAULT_AUTH_BASE_URL
}

export type AuthErrorCode =
  | "network"
  | "already-registered"
  | "no-account"
  | "incorrect-code"
  | "expired-code"
  | "too-many-attempts"
  | "invalid-token"
  | "rate-limited"
  | "blocked"
  | "server"
  | "unknown"

/** Maps a failure to the i18n key the UI should show. */
export const AUTH_ERROR_STRINGS: Record<AuthErrorCode, AuthStringKey> = {
  network: "auth.error.network",
  "already-registered": "auth.error.alreadyRegistered",
  "no-account": "auth.error.noAccount",
  "incorrect-code": "auth.error.incorrectCode",
  "expired-code": "auth.error.expiredCode",
  "too-many-attempts": "auth.error.tooManyAttempts",
  "invalid-token": "auth.error.invalidToken",
  "rate-limited": "auth.error.rateLimited",
  blocked: "auth.error.blocked",
  server: "auth.error.server",
  unknown: "auth.error.unknown",
}

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    readonly detail?: string,
  ) {
    super(detail ?? code)
    this.name = "AuthError"
  }
}

/**
 * The service returns 400 for four materially different confirm failures and
 * distinguishes them only in the human-readable `detail` string. The
 * distinction matters for UX -- an expired code needs a resend, a wrong code
 * needs a retry -- so we match on the detail text, falling back to the generic
 * "incorrect code" rather than guessing wrong.
 *
 * This is inherently brittle: rewording a message server-side silently
 * degrades the client to the fallback. The durable fix is a machine-readable
 * `code` field in the service's error responses; until then this stays a
 * best-effort refinement over a safe default.
 */
export function classifyConfirmDetail(detail: string | undefined): AuthErrorCode {
  const text = (detail ?? "").toLowerCase()
  if (text.includes("expired")) return "expired-code"
  if (text.includes("too many incorrect")) return "too-many-attempts"
  if (text.includes("already-used") || text.includes("invalid or already")) return "invalid-token"
  if (text.includes("incorrect code")) return "incorrect-code"
  return "incorrect-code"
}

export function classifyStatus(status: number, detail: string | undefined, path: string, code?: string): AuthErrorCode {
  if (code === "account_blocked") return "blocked"
  if (status === 409) return "already-registered"
  if (status === 404) return "no-account"
  if (status === 429) return "rate-limited"
  if (status >= 500) return "server"
  if (status === 400 && path === "/confirm") return classifyConfirmDetail(detail)
  if (status === 422) return "unknown" // request body failed the service's own validation
  return "unknown"
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${await authBaseUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    })
  } catch {
    // fetch only rejects for transport-level failures (DNS, TLS, offline).
    throw new AuthError("network")
  }

  if (response.ok) return (await response.json()) as T

  let detail: string | undefined
  let code: string | undefined
  try {
    const payload = (await response.json()) as { detail?: unknown; code?: unknown }
    if (typeof payload.detail === "string") detail = payload.detail
    if (typeof payload.code === "string") code = payload.code
  } catch {
    // Non-JSON error body (e.g. an nginx 502 page); status alone drives the code.
  }
  throw new AuthError(classifyStatus(response.status, detail, path, code), detail)
}

export interface TokenResponse {
  token: string
}

export interface CredentialResponse {
  email: string
  credential: string
  /** Epoch SECONDS from the server; the client stores milliseconds. */
  expires_at: number
}

export function register(email: string, phone: string | undefined, signal?: AbortSignal): Promise<TokenResponse> {
  const trimmedPhone = phone?.trim()
  return post<TokenResponse>(
    "/register",
    { email, phone: trimmedPhone && trimmedPhone.length > 0 ? trimmedPhone : null },
    signal,
  )
}

export function login(email: string, signal?: AbortSignal): Promise<TokenResponse> {
  return post<TokenResponse>("/login", { email }, signal)
}

export function confirm(token: string, code: string, signal?: AbortSignal): Promise<CredentialResponse> {
  return post<CredentialResponse>("/confirm", { token, code }, signal)
}

/** Mirrors the service's own EmailStr validation closely enough to catch typos client-side. */
export function isValidEmail(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 254) return false
  if (/\s/.test(trimmed)) return false
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(trimmed)
}

export function isValidCode(value: string): boolean {
  return /^\d{6}$/.test(value.trim())
}
