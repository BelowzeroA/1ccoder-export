// Whether the profiles screen is open, and what it should be showing.
//
// A module-level signal rather than a prop, because the things that open the
// screen -- the account menu (bottom-left) and the home screen's profile list
// -- live far from the screen itself, which is mounted next to the other
// 1CCoder controls in index.tsx's serverScoped slot. Threading a prop between
// them would mean touching upstream components that sit in between, which is
// exactly what the fork tries not to do.

import { createSignal } from "solid-js"

const [isOpen, setOpen] = createSignal(false)

export { isOpen as profilesOpen, setOpen as setProfilesOpen }

/**
 * What the screen should show the next time it is opened.
 *
 * A caller that already knows which profile the user means -- "Edit" on a row
 * of the home list -- should not land them on the list to find it again. The
 * intent is a fresh object on every call so that asking twice for the same
 * thing is still a change the screen can react to.
 */
export type ProfilesIntent =
  | { readonly kind: "list" }
  | { readonly kind: "create" }
  | { readonly kind: "edit"; readonly id: string }

const [intent, setIntent] = createSignal<ProfilesIntent>({ kind: "list" })

export function openProfiles(next: ProfilesIntent = { kind: "list" }) {
  setIntent(next)
  setOpen(true)
}

export { intent as profilesIntent }
