// Who owns the home screen's left pane.
//
// Upstream lists *projects* there: directories resolved into project records by
// packages/core/src/project.ts, added by hand with a folder picker. 1CCoder
// lists *developer profiles* instead — a profile already names the working
// directory its sessions run in (see
// packages/desktop/src/main/profiles/profile.ts), so the directory stays what
// sessions are grouped by internally while the profile becomes the thing the
// user actually picks. Same seam, same reasoning, as
// components/session-target-slot.tsx.
//
// The list cannot live in this package: it reads `window.api.profiles`, which
// exists only in the Electron build, while this package also builds as a
// standalone web app and inside packages/enterprise. So this module is only the
// seam — the desktop renderer registers a source at startup, and any consumer
// that registers nothing keeps upstream's project list untouched.

import { createSignal, type Accessor } from "solid-js"
import { pathKey } from "@/utils/path-key"

/** One row in the pane. */
export interface HomeScopeItem {
  readonly id: string
  readonly name: string
  /** Where this item's sessions live. Filtering the session list uses this. */
  readonly directory: string
  /** A second line for the row's tooltip — for a profile, the infobase it points at. */
  readonly detail?: string
}

/**
 * Everything the pane renders. Plain values rather than accessors: the whole
 * source is produced by one accessor, so reading any field of it tracks.
 */
export interface HomeScopeSource {
  /** Heading above the list. */
  readonly title: string
  readonly addLabel: string
  readonly editLabel: string
  readonly newSessionLabel: string
  readonly emptyLabel: string
  readonly items: readonly HomeScopeItem[]
  readonly onAdd: () => void
  readonly onEdit: (item: HomeScopeItem) => void
  /**
   * Called once the draft for a new session on this item exists.
   *
   * The row the user clicked already named the item, so this is where a
   * consumer records that as the draft's own choice rather than letting
   * whatever asks about it ask again.
   */
  readonly onNewSession?: (item: HomeScopeItem, draftId: string) => void
}

const [source, setSource] = createSignal<Accessor<HomeScopeSource> | null>(null)

/** Registered once by the desktop renderer. Pass null to restore upstream's project list. */
export function setHomeScopeSource(next: Accessor<HomeScopeSource> | null) {
  setSource(() => next)
}

export { source as homeScopeSource }

/** The registered source's current value, or undefined when nothing is registered. */
export function homeScope(): HomeScopeSource | undefined {
  return source()?.()
}

/**
 * The item a directory belongs to.
 *
 * Session rows and the search placeholder name the thing the user chose, and
 * once the pane lists profiles that is the profile — not the basename of the
 * directory behind it, which is derived from the profile's name and only looks
 * the same until someone renames one.
 */
export function homeScopeName(directory: string): string | undefined {
  const scope = homeScope()
  if (!scope) return undefined
  const key = pathKey(directory)
  return scope.items.find((item) => pathKey(item.directory) === key)?.name
}
