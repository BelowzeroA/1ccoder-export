// A developer profile chosen for a conversation that does not exist yet.
//
// "Новая сессия" on a profile row of the home screen is already an answer to
// "which profile?", but the draft it opens starts with no binding, and the
// picker modal asks about anything unasked -- so the user was asked to name the
// profile they had just named. Recording the choice here lets the draft answer
// for itself the moment it mounts.
//
// Deliberately not a direct setBinding call at the click: that would skip
// verification and leave the session on the wrong agent. What is recorded is
// the *choice*, and use-session-profile then runs the ordinary choose() for it,
// so the profile is still verified, the agent is still switched, and a profile
// that turns out to be broken still surfaces its failure.
//
// A signal rather than a plain Map because the picker's visibility depends on
// it: an entry waiting to be acted on must keep the modal shut.

import { createSignal, untrack } from "solid-js"

type Entry = { readonly profileId: string; readonly claimed: boolean }

const [entries, setEntries] = createSignal<Record<string, Entry>>({})

export function setPendingProfile(conversationKey: string, profileId: string) {
  setEntries((current) => ({ ...current, [conversationKey]: { profileId, claimed: false } }))
}

/** The profile waiting for this conversation, whether or not it has been claimed. */
export function pendingProfile(conversationKey: string | undefined): string | undefined {
  if (!conversationKey) return undefined
  return entries()[conversationKey]?.profileId
}

/**
 * Takes ownership of the choice, once.
 *
 * Two hooks watch the same conversation -- the inline selector under the
 * composer and the modal -- and acting on a profile launches 1C for up to
 * ninety seconds, so exactly one of them may do it.
 */
export function claimPendingProfile(conversationKey: string): string | undefined {
  return untrack(() => {
    const entry = entries()[conversationKey]
    if (!entry || entry.claimed) return undefined
    setEntries((current) => ({ ...current, [conversationKey]: { ...entry, claimed: true } }))
    return entry.profileId
  })
}

/** Called once the choice has been acted on, or found to name a profile that is gone. */
export function clearPendingProfile(conversationKey: string) {
  setEntries((current) => {
    if (!(conversationKey in current)) return current
    const { [conversationKey]: _acted, ...rest } = current
    return rest
  })
}
