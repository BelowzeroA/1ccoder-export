// Electron bindings for the profile store.
//
// Kept apart from profile-store.ts on purpose: importing `electron` outside an
// Electron process throws, and the store's rules -- including what it does when
// encryption is unavailable -- deserve to be unit-tested. This file is the only
// part that cannot be.

import { randomUUID } from "node:crypto"
import { safeStorage } from "electron"

import { getStore } from "../store"
import { PROFILES_KEY, PROFILE_STORE, type SecretBox, type StoreDeps, type StoredProfile } from "./profile-store"
import { BINDINGS_KEY, BINDING_STORE, type BindingStoreDeps, type SessionBinding } from "./session-binding"

export function electronSecretBox(): SecretBox {
  return {
    available: () => {
      try {
        return safeStorage.isEncryptionAvailable()
      } catch {
        return false
      }
    },
    encrypt: (plain) => safeStorage.encryptString(plain).toString("base64"),
    decrypt: (cipher) => {
      try {
        return safeStorage.decryptString(Buffer.from(cipher, "base64"))
      } catch {
        // A profile copied from another machine, or a Windows profile whose DPAPI
        // keys have changed: the record is fine, the secret is simply unreadable.
        return null
      }
    },
  }
}

export function electronStoreDeps(secrets: SecretBox = electronSecretBox()): StoreDeps {
  return {
    read: () => {
      const raw = getStore(PROFILE_STORE).get(PROFILES_KEY)
      return Array.isArray(raw) ? (raw as StoredProfile[]) : []
    },
    write: (profiles) => getStore(PROFILE_STORE).set(PROFILES_KEY, profiles),
    secrets,
    now: () => Date.now(),
    newId: () => randomUUID(),
  }
}

export function electronBindingDeps(): BindingStoreDeps {
  return {
    read: () => {
      const raw = getStore(BINDING_STORE).get(BINDINGS_KEY)
      return Array.isArray(raw) ? (raw as SessionBinding[]) : []
    },
    write: (bindings) => getStore(BINDING_STORE).set(BINDINGS_KEY, bindings),
    now: () => Date.now(),
  }
}
