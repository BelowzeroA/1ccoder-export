// Who chooses what a new session is aimed at.
//
// Upstream asks for a *project* — a directory, resolved into a project record
// by packages/core/src/project.ts. 1CCoder asks for a *developer profile*,
// which already names the working directory the session should run in (see
// packages/desktop/src/main/profiles/profile.ts). Asking both was asking the
// same question twice, so on the desktop the profile picker takes the project
// picker's place and supplies the directory itself.
//
// The picker cannot live in this package. It reads `window.api.profiles`, which
// exists only in the Electron build, while this package also builds as a
// standalone web app and inside packages/enterprise. So this module is only the
// seam: the desktop renderer registers a renderer at startup, and any consumer
// that registers nothing keeps upstream's project picker untouched.

import { createSignal, type JSX } from "solid-js"

export interface SessionTargetSlotInput {
  /** Point the draft at this directory; opencode resolves it into a project. */
  readonly selectDirectory: (worktree: string) => void
  /** Where a session with no profile goes. */
  readonly defaultDirectory: () => string | undefined
  /** The directory currently selected. */
  readonly currentDirectory: () => string
}

export type SessionTargetRenderer = (input: SessionTargetSlotInput) => JSX.Element

const [renderer, setRenderer] = createSignal<SessionTargetRenderer | null>(null)

/** Registered once by the desktop renderer. Pass null to fall back to upstream. */
export function setSessionTargetRenderer(next: SessionTargetRenderer | null) {
  setRenderer(() => next)
}

export { renderer as sessionTargetRenderer }

/**
 * Where a new session should run, according to the developer profile bound to
 * the draft it is being promoted from.
 *
 * This is the override that retires the project entity as a user-facing idea.
 * Upstream derives a new session's directory from the selected project (and
 * then from any worktree chosen beside it); 1CCoder derives it from the bound
 * profile, because a profile already names the working directory the agent is
 * supposed to use, and having two answers to "where does this run" is how they
 * came to disagree. Returning undefined means no profile is bound, and
 * upstream's behaviour stands.
 */
export type SessionDirectoryResolver = (conversation: { draftId?: string }) => Promise<string | undefined>

const [resolver, setResolver] = createSignal<SessionDirectoryResolver | null>(null)

/** Registered once by the desktop renderer. Pass null to restore upstream. */
export function setSessionDirectoryResolver(next: SessionDirectoryResolver | null) {
  setResolver(() => next)
}

export { resolver as sessionDirectoryResolver }
