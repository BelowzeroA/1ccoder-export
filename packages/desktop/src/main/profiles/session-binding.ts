// Which developer profile a session is bound to.
//
// Phase 7 dropped the earlier requirement that a session must have an
// infobase. What is required is an *explicit choice*, and that distinction is
// the whole reason this store exists:
//
//   no record          -> the user has not chosen yet; the picker must be shown
//   { profileId: null } -> the user chose "без профиля"; do not ask again
//   { profileId: "…" }  -> bound to that profile
//
// A boolean or a bare string could not express the middle case, and conflating
// it with "not chosen" would mean re-asking someone who already answered.
//
// Bindings are stored locally so they survive an app restart. They are
// deliberately NOT stored inside the session on the server: the profile is a
// property of this machine's setup (a platform path, a local infobase,
// credentials), and means nothing to another machine that opens the same
// session.
//
// The key is a CONVERSATION key, not a session id, because a session does not
// exist when the choice is made. opencode creates the session lazily, on the
// first message (packages/app/src/components/prompt-input/submit.ts): the "new
// session" button only opens a local draft tab. So the choice is recorded
// against `draft:<draftID>` first and carried over to `session:<sessionID>`
// when the draft is promoted. The prefixes follow upstream's own convention in
// context/tabs.tsx, which already keys drafts as `draft:${draftID}`.

export const BINDING_STORE = "1ccoder.sessions"
export const BINDINGS_KEY = "bindings"

export interface SessionBinding {
  readonly conversationId: string
  /** null is a real answer: the session runs without a profile. */
  readonly profileId: string | null
  readonly chosenAt: number
}

export interface BindingStoreDeps {
  readonly read: () => SessionBinding[]
  readonly write: (bindings: SessionBinding[]) => void
  readonly now: () => number
}

/**
 * How many bindings to keep. Sessions are created freely and never garbage
 * collected here, so the store is trimmed oldest-first to stop it growing
 * without bound over months of use.
 */
const MAX_BINDINGS = 500

export class SessionBindingStore {
  constructor(private readonly deps: BindingStoreDeps) {}

  /** The binding, or null when the user has not chosen for this session yet. */
  get(conversationId: string): SessionBinding | null {
    return this.deps.read().find((binding) => binding.conversationId === conversationId) ?? null
  }

  /** True when this session still needs to be asked. */
  needsChoice(conversationId: string): boolean {
    return this.get(conversationId) === null
  }

  set(conversationId: string, profileId: string | null): SessionBinding {
    const binding: SessionBinding = { conversationId, profileId, chosenAt: this.deps.now() }
    const rest = this.deps.read().filter((existing) => existing.conversationId !== conversationId)
    const next = [...rest, binding]
    this.deps.write(next.length > MAX_BINDINGS ? next.slice(next.length - MAX_BINDINGS) : next)
    return binding
  }

  remove(conversationId: string): boolean {
    const bindings = this.deps.read()
    const next = bindings.filter((binding) => binding.conversationId !== conversationId)
    if (next.length === bindings.length) return false
    this.deps.write(next)
    return true
  }

  /**
   * Drops every binding pointing at a profile that no longer exists, so a
   * deleted profile cannot leave sessions pointing at nothing. Returns the
   * sessions that were affected, which the caller may need to re-ask.
   */
  forgetProfile(profileId: string): string[] {
    const bindings = this.deps.read()
    const affected = bindings.filter((binding) => binding.profileId === profileId).map((b) => b.conversationId)
    if (!affected.length) return []
    this.deps.write(bindings.filter((binding) => binding.profileId !== profileId))
    return affected
  }
}
