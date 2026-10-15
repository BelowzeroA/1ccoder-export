// Counters that change whenever the stored profiles or session bindings do.
//
// The profiles screen owns every mutation, but it is not the only thing reading
// the list: the session profile selector under the composer shows the same
// profiles and lives in a different part of the tree. Without this, creating a
// profile left that selector holding the list it had loaded at mount, so the
// new profile could not be picked until the app was reloaded.
//
// A module-level signal for the same reason as open-state.ts: the two surfaces
// have no common ancestor to thread a prop through that is not upstream's.

import { createSignal } from "solid-js"

const [revision, setRevision] = createSignal(0)

/** Call after the stored profile list has changed. */
export function bumpProfilesRevision() {
  setRevision((value) => value + 1)
}

export { revision as profilesRevision }

const [bindings, setBindings] = createSignal(0)

/**
 * Call after a session's profile binding has changed.
 *
 * Two surfaces read the same binding through separate hook instances -- the
 * inline selector under the composer and the modal that demands the first
 * choice -- and each holds its own resource. Without this, answering the modal
 * left the selector showing the null it had loaded at mount, which reads as
 * "не выбран" for a session that is in fact bound.
 */
export function bumpBindingsRevision() {
  setBindings((value) => value + 1)
}

export { bindings as bindingsRevision }
