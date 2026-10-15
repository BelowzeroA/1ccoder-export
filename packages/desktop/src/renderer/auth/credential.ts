// Local persistence of the 1CCoder auth credential.
//
// Uses the existing generic electron-store bridge (window.api.storeGet/Set/Delete,
// registered in ../../main/ipc.ts) with a store name of our own, so no new IPC
// handlers or preload surface are required -- the bridge already accepts an
// arbitrary store name and getStore() creates the file on demand under Electron's
// userData path.

export const AUTH_STORE = "1ccoder.auth"
export const CREDENTIAL_KEY = "credential"
export const EMAIL_KEY = "email"
export const EXPIRES_AT_KEY = "expiresAt"

export interface StoredCredential {
  email: string
  credential: string
  /** Epoch milliseconds. Issued by the server; the session lasts 7 days. */
  expiresAt: number
}

type StoreApi = Pick<typeof window.api, "storeGet" | "storeSet" | "storeDelete">

function api(): StoreApi {
  return window.api
}

/**
 * Returns the stored credential, or null when the user is signed out or the
 * session has lapsed.
 *
 * The expiry is enforced here as well as on the server so the sign-in screen
 * appears at launch rather than as a failed request mid-session. The server is
 * still the authority -- it independently refuses credentials past their age
 * limit -- but a client that knows the deadline can be honest about it up front.
 *
 * A stored record with no expiry predates this and is treated as lapsed, which
 * costs one sign-in rather than granting an unbounded session.
 */
export async function readCredential(store: StoreApi = api(), now = Date.now()): Promise<StoredCredential | null> {
  try {
    const [credential, email, expiresAtRaw] = await Promise.all([
      store.storeGet(AUTH_STORE, CREDENTIAL_KEY),
      store.storeGet(AUTH_STORE, EMAIL_KEY),
      store.storeGet(AUTH_STORE, EXPIRES_AT_KEY),
    ])
    if (!credential || !email) return null
    if (credential.length === 0 || email.length === 0) return null

    const expiresAt = Number(expiresAtRaw)
    if (!expiresAtRaw || !Number.isFinite(expiresAt) || expiresAt <= now) {
      // Clear it rather than leaving a dead record around to be re-read on every
      // launch and re-rejected.
      await clearCredential(store).catch(() => undefined)
      return null
    }
    return { email, credential, expiresAt }
  } catch {
    // A failed read must not brick the app into a permanently locked state;
    // treat it as "not signed in" so the user can authenticate again.
    return null
  }
}

export async function writeCredential(value: StoredCredential, store: StoreApi = api()): Promise<void> {
  await store.storeSet(AUTH_STORE, CREDENTIAL_KEY, value.credential)
  await store.storeSet(AUTH_STORE, EMAIL_KEY, value.email)
  await store.storeSet(AUTH_STORE, EXPIRES_AT_KEY, String(value.expiresAt))
}

export async function clearCredential(store: StoreApi = api()): Promise<void> {
  await store.storeDelete(AUTH_STORE, CREDENTIAL_KEY)
  await store.storeDelete(AUTH_STORE, EMAIL_KEY)
  await store.storeDelete(AUTH_STORE, EXPIRES_AT_KEY)
}
