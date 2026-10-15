// The key a session's profile choice is recorded under.
//
// It is a *conversation* key rather than a session id because a session does
// not exist when the choice is made. opencode creates the session lazily, on
// the first message (packages/app/src/components/prompt-input/submit.ts); the
// "new session" button only opens a local draft tab at /new-session?draftId=…
// So the choice is recorded against the draft first, and carried over to the
// session when the draft is promoted.
//
// The prefixes follow upstream's own convention -- context/tabs.tsx already
// keys drafts as `draft:${draftID}` -- and keep the two namespaces apart, since
// nothing guarantees a draft id and a session id cannot collide.
//
// Kept in its own module, free of any Solid import, so it stays testable: the
// component that uses it pulls in @solidjs/router, which cannot load outside a
// browser.

export function conversationKey(sessionId: string | undefined, draftId: string | undefined): string | undefined {
  if (sessionId) return `session:${sessionId}`
  if (draftId) return `draft:${draftId}`
  return undefined
}

/** True for a key that names a real, created session rather than a draft. */
export function isSessionKey(key: string): boolean {
  return key.startsWith("session:")
}

/**
 * The session id in a router path, or undefined for a route that names none.
 *
 * Read from the location rather than from `useParams`, because the caption and
 * the AutoMode offer render in AppInterface's `serverScoped` slot -- a sibling
 * of the routed subtree rather than a descendant of it. Route params never
 * reach there, so `params.id` was always undefined and a session's choice was
 * never carried over from its draft: the store only ever grew `draft:` keys.
 * The location, unlike params, is global to the router.
 *
 * Both layouts are covered: `/server/:serverKey/session/:id` in the current
 * one, and `/:dir/session/:id?` in the legacy one, where the id may be absent.
 */
export function sessionIdFromPath(pathname: string): string | undefined {
  return /\/session\/([^/?#]+)/.exec(pathname)?.[1]
}
