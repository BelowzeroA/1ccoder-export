import { expect, test, describe } from "bun:test"

import { AUTH_ERROR_STRINGS, classifyConfirmDetail, classifyStatus, isValidCode, isValidEmail } from "./client"
import { clearCredential, readCredential, writeCredential, AUTH_STORE, CREDENTIAL_KEY, EMAIL_KEY } from "./credential"
import { daysRemaining } from "./expiry"
import { authDict, createAuthTranslator, en, interpolate, ru } from "./i18n"

// Widened views so the tests can iterate keys without unsafe type assertions.
const enStrings: Record<string, string> = en
const ruStrings: Record<string, string> = ru

describe("i18n", () => {
  test("Russian covers every English key and adds none of its own", () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort())
  })

  test("Russian preserves the placeholders used in English", () => {
    const placeholders = (value: string) => (value.match(/\{\{(\w+)\}\}/g) ?? []).sort()
    for (const key of Object.keys(enStrings)) {
      expect({ key, placeholders: placeholders(ruStrings[key]) }).toEqual({
        key,
        placeholders: placeholders(enStrings[key]),
      })
    }
  })

  test("no Russian string was left as its English source", () => {
    // Catches copy that was added to `en` and pasted into `ru` untranslated.
    // "1CCoder" is a brand name; the email and phone placeholders are format
    // examples that read the same in both languages.
    const allowedIdentical = new Set([
      "auth.welcome.title",
      "auth.field.emailPlaceholder",
      "auth.field.phonePlaceholder",
    ])
    const untranslated = Object.keys(enStrings).filter(
      (key) => !allowedIdentical.has(key) && ruStrings[key] === enStrings[key],
    )
    expect(untranslated).toEqual([])
  })

  test("defaults to Russian for any locale that is not explicitly English", () => {
    expect(authDict("ru")["auth.action.login"]).toBe(ru["auth.action.login"])
    expect(authDict(undefined)["auth.action.login"]).toBe(ru["auth.action.login"])
    expect(authDict("de")["auth.action.login"]).toBe(ru["auth.action.login"])
    expect(authDict("en")["auth.action.login"]).toBe(en["auth.action.login"])
  })

  test("interpolates named placeholders and leaves unknown ones intact", () => {
    expect(interpolate("code sent to {{email}}", { email: "a@b.co" })).toBe("code sent to a@b.co")
    expect(interpolate("{{a}} and {{b}}", { a: "1" })).toBe("1 and {{b}}")
    expect(interpolate("no placeholders")).toBe("no placeholders")
  })

  test("translator renders the Russian confirmation line with the address", () => {
    const t = createAuthTranslator("ru")
    expect(t("auth.code.sentTo", { email: "user@example.com" })).toContain("user@example.com")
    expect(t("auth.action.login")).toBe("Зайти в аккаунт")
    expect(t("auth.action.register")).toBe("Создать аккаунт")
  })

  test("every error code maps to a string that exists", () => {
    for (const key of Object.values(AUTH_ERROR_STRINGS)) {
      expect(enStrings[key]).toBeDefined()
      expect(ruStrings[key]).toBeDefined()
    }
  })
})

describe("error classification", () => {
  test("maps HTTP status codes to the right failure", () => {
    expect(classifyStatus(409, "This email is already registered", "/register")).toBe("already-registered")
    expect(classifyStatus(404, "No confirmed account found for this email", "/login")).toBe("no-account")
    expect(classifyStatus(429, "Too many requests, please try again later", "/register")).toBe("rate-limited")
    expect(classifyStatus(500, undefined, "/register")).toBe("server")
    expect(classifyStatus(502, undefined, "/confirm")).toBe("server")
    // The code decides, whichever endpoint refused: a block is not "no account".
    for (const path of ["/register", "/login", "/confirm"])
      expect(classifyStatus(403, "This account is blocked", path, "account_blocked")).toBe("blocked")
    expect(classifyStatus(403, "Forbidden", "/login")).toBe("unknown")
  })

  test("separates the four distinct confirm failures the service returns as 400", () => {
    expect(classifyStatus(400, "Incorrect code", "/confirm")).toBe("incorrect-code")
    expect(classifyStatus(400, "Code has expired, please request a new one", "/confirm")).toBe("expired-code")
    expect(classifyStatus(400, "Too many incorrect attempts, please request a new code", "/confirm")).toBe(
      "too-many-attempts",
    )
    expect(classifyStatus(400, "Invalid or already-used token", "/confirm")).toBe("invalid-token")
  })

  test("falls back to a retryable error when the detail is missing or reworded", () => {
    expect(classifyConfirmDetail(undefined)).toBe("incorrect-code")
    expect(classifyConfirmDetail("some future wording nobody anticipated")).toBe("incorrect-code")
  })
})

describe("validation", () => {
  test("accepts ordinary addresses and rejects malformed ones", () => {
    expect(isValidEmail("user@example.com")).toBe(true)
    expect(isValidEmail("  user@example.com  ")).toBe(true)
    expect(isValidEmail("first.last@sub.example.co.uk")).toBe(true)
    expect(isValidEmail("")).toBe(false)
    expect(isValidEmail("user")).toBe(false)
    expect(isValidEmail("user@")).toBe(false)
    expect(isValidEmail("user@example")).toBe(false)
    expect(isValidEmail("user @example.com")).toBe(false)
    expect(isValidEmail("a@b@c.com")).toBe(false)
  })

  test("requires exactly six digits for the confirmation code", () => {
    expect(isValidCode("123456")).toBe(true)
    expect(isValidCode(" 123456 ")).toBe(true)
    expect(isValidCode("12345")).toBe(false)
    expect(isValidCode("1234567")).toBe(false)
    expect(isValidCode("12345a")).toBe(false)
    expect(isValidCode("")).toBe(false)
  })
})

function fakeStore() {
  const data = new Map<string, string>()
  return {
    data,
    storeGet: async (name: string, key: string) => data.get(`${name}:${key}`) ?? null,
    storeSet: async (name: string, key: string, value: string) => {
      data.set(`${name}:${key}`, value)
    },
    storeDelete: async (name: string, key: string) => {
      data.delete(`${name}:${key}`)
    },
  }
}

describe("credential storage", () => {
  test("round-trips a credential through the generic store bridge", async () => {
    const store = fakeStore()
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000
    await writeCredential({ email: "user@example.com", credential: "signed-value", expiresAt }, store)
    expect(store.data.get(`${AUTH_STORE}:${CREDENTIAL_KEY}`)).toBe("signed-value")
    expect(store.data.get(`${AUTH_STORE}:${EMAIL_KEY}`)).toBe("user@example.com")
    expect(await readCredential(store)).toEqual({ email: "user@example.com", credential: "signed-value", expiresAt })
  })

  test("reports no credential on a fresh install", async () => {
    expect(await readCredential(fakeStore())).toBeNull()
  })

  test("treats a half-written record as signed out rather than partially valid", async () => {
    const store = fakeStore()
    store.data.set(`${AUTH_STORE}:${CREDENTIAL_KEY}`, "signed-value")
    expect(await readCredential(store)).toBeNull()
  })

  test("clearing removes both keys so the next launch shows the auth screen", async () => {
    const store = fakeStore()
    await writeCredential(
      { email: "user@example.com", credential: "signed-value", expiresAt: Date.now() + 86400000 },
      store,
    )
    await clearCredential(store)
    expect(await readCredential(store)).toBeNull()
  })

  test("a failing store reads as signed out instead of locking the user out", async () => {
    const broken = {
      storeGet: async () => {
        throw new Error("store unavailable")
      },
      storeSet: async () => {},
      storeDelete: async () => {},
    }
    expect(await readCredential(broken)).toBeNull()
  })
})

describe("session expiry", () => {
  const DAY = 24 * 60 * 60 * 1000

  test("a credential within its 7 days is returned", async () => {
    const store = fakeStore()
    const expiresAt = Date.now() + 7 * DAY
    await writeCredential({ email: "u@e.com", credential: "c", expiresAt }, store)
    expect(await readCredential(store)).toEqual({ email: "u@e.com", credential: "c", expiresAt })
  })

  test("a lapsed credential reads as signed out and is cleared", async () => {
    // Clearing matters: otherwise a dead record is re-read and re-rejected on
    // every launch forever.
    const store = fakeStore()
    await writeCredential({ email: "u@e.com", credential: "c", expiresAt: Date.now() - 1000 }, store)
    expect(await readCredential(store)).toBeNull()
    expect(store.data.size).toBe(0)
  })

  test("a record predating the expiry field is treated as lapsed", async () => {
    const store = fakeStore()
    store.data.set(`${AUTH_STORE}:${CREDENTIAL_KEY}`, "c")
    store.data.set(`${AUTH_STORE}:${EMAIL_KEY}`, "u@e.com")
    expect(await readCredential(store)).toBeNull()
  })

  test("expiry is evaluated against the supplied clock, not only wall time", async () => {
    const store = fakeStore()
    const expiresAt = Date.now() + 2 * DAY
    await writeCredential({ email: "u@e.com", credential: "c", expiresAt }, store)
    expect(await readCredential(store, expiresAt - 1000)).not.toBeNull()
    expect(await readCredential(store, expiresAt + 1000)).toBeNull()
  })

  test("days remaining rounds up, so the last day still reads as one day", () => {
    const now = Date.now()
    expect(daysRemaining(now + 7 * DAY, now)).toBe(7)
    expect(daysRemaining(now + 0.5 * DAY, now)).toBe(1)
    expect(daysRemaining(now - DAY, now)).toBe(0)
  })
})
