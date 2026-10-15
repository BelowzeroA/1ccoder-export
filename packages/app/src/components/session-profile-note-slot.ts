// The read-only profile note beside the model picker, on a running session.
//
// A session's developer profile is decided when the session starts: it settles
// the working directory and the infobase, and both are fixed for the life of
// the conversation. So on a running session the profile is information, not a
// choice -- shown as plain text next to the model, and not offered for change.
// The new-session screen still asks; that is what session-target-slot.tsx is.
//
// Same seam, same reason, as session-target-slot.tsx: the note reads
// `window.api.profiles`, which exists only in the Electron build, while this
// package also builds as a standalone web app and inside packages/enterprise.
// A consumer that registers nothing simply has no note.

import { createSignal, type JSX } from "solid-js"

export type SessionProfileNoteRenderer = () => JSX.Element

const [renderer, setRenderer] = createSignal<SessionProfileNoteRenderer | null>(null)

/** Registered once by the desktop renderer. Pass null to remove the note. */
export function setSessionProfileNoteRenderer(next: SessionProfileNoteRenderer | null) {
  setRenderer(() => next)
}

export { renderer as sessionProfileNoteRenderer }
