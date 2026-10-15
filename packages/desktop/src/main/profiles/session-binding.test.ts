import { describe, expect, test } from "bun:test"

import { SessionBindingStore, type BindingStoreDeps, type SessionBinding } from "./session-binding"

function fakeStore(seed: SessionBinding[] = []) {
  let rows = [...seed]
  let clock = 1_000
  const deps: BindingStoreDeps = {
    read: () => rows.map((row) => ({ ...row })),
    write: (next) => {
      rows = next.map((row) => ({ ...row }))
    },
    now: () => clock++,
  }
  return { store: new SessionBindingStore(deps), rows: () => rows }
}

describe("SessionBindingStore", () => {
  test("a session with no record still needs to be asked", () => {
    const { store } = fakeStore()
    expect(store.needsChoice("s1")).toBe(true)
    expect(store.get("s1")).toBeNull()
  })

  // The distinction this store exists for: "no profile" is an answer, and
  // someone who gave it must not be asked again.
  test("choosing 'without a profile' counts as having chosen", () => {
    const { store } = fakeStore()
    store.set("s1", null)
    expect(store.needsChoice("s1")).toBe(false)
    expect(store.get("s1")).toMatchObject({ conversationId: "s1", profileId: null })
  })

  test("binding to a profile counts as having chosen", () => {
    const { store } = fakeStore()
    store.set("s1", "p1")
    expect(store.needsChoice("s1")).toBe(false)
    expect(store.get("s1")?.profileId).toBe("p1")
  })

  test("choosing again replaces rather than duplicates", () => {
    const { store, rows } = fakeStore()
    store.set("s1", "p1")
    store.set("s1", "p2")
    expect(rows()).toHaveLength(1)
    expect(store.get("s1")?.profileId).toBe("p2")
  })

  test("sessions do not interfere with each other", () => {
    const { store } = fakeStore()
    store.set("s1", "p1")
    store.set("s2", null)
    expect(store.get("s1")?.profileId).toBe("p1")
    expect(store.get("s2")?.profileId).toBeNull()
    expect(store.needsChoice("s3")).toBe(true)
  })

  test("deleting a profile forgets the sessions bound to it, and only those", () => {
    const { store } = fakeStore()
    store.set("s1", "p1")
    store.set("s2", "p2")
    store.set("s3", null)

    expect(store.forgetProfile("p1")).toEqual(["s1"])
    expect(store.needsChoice("s1")).toBe(true)
    expect(store.get("s2")?.profileId).toBe("p2")
    // A profile-less session is untouched: it was never bound to anything.
    expect(store.needsChoice("s3")).toBe(false)
  })

  test("forgetting a profile nothing points at changes nothing", () => {
    const { store, rows } = fakeStore()
    store.set("s1", "p1")
    expect(store.forgetProfile("other")).toEqual([])
    expect(rows()).toHaveLength(1)
  })

  test("remove reports whether it removed anything", () => {
    const { store } = fakeStore()
    store.set("s1", "p1")
    expect(store.remove("s1")).toBe(true)
    expect(store.remove("s1")).toBe(false)
  })

  test("trims oldest-first so the store cannot grow without bound", () => {
    const { store, rows } = fakeStore()
    for (let i = 0; i < 520; i++) store.set(`s${i}`, null)
    expect(rows()).toHaveLength(500)
    expect(store.needsChoice("s0")).toBe(true)
    expect(store.needsChoice("s519")).toBe(false)
  })
})
