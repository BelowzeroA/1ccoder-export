import { createEffect, untrack } from "solid-js"
import { useGlobal } from "@/context/global"
import { ServerConnection } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { pathKey } from "@/utils/path-key"
import type { HomeController } from "./home-controller"
import { homeScopeSource, type HomeScopeItem } from "./home-scope-slot"

/**
 * The left pane when a scope source has taken it over — 1CCoder's developer
 * profiles in place of opencode's project list. See home-scope-slot.ts.
 *
 * The connection between the pane and the session list is unchanged: selecting
 * a row still narrows the sessions to one directory, and selecting nothing
 * still shows every directory the pane knows about. What changes is only where
 * that directory comes from. Each item's directory is therefore opened as a
 * project on the focused server — sessions are indexed and grouped by project
 * (see home-sessions-controller.tsx), so a profile whose directory was never
 * opened would have no sessions to show even when it plainly has some.
 */
export function createHomeScopeController(home: HomeController) {
  const global = useGlobal()
  const tabs = useTabs()
  const source = () => homeScopeSource()?.()

  createEffect(() => {
    const items = source()?.items
    const conn = home.server.focused()
    if (!items?.length || !conn) return
    // The list this reads is the same one opening a project writes to; reading
    // it reactively would re-run this effect on its own writes.
    untrack(() => {
      const ctx = global.ensureServerCtx(conn)
      const known = new Set(ctx.projects.list().map((project) => pathKey(project.worktree)))
      items
        .filter((item) => item.directory && !known.has(pathKey(item.directory)))
        .forEach((item) => ctx.projects.open(item.directory))
    })
  })

  function open(item: HomeScopeItem) {
    const conn = home.server.focused()
    if (!conn || !item.directory) return undefined
    global.ensureServerCtx(conn).projects.open(item.directory)
    return conn
  }

  return {
    source,
    selected: (item: HomeScopeItem) => {
      const conn = home.server.focused()
      if (!conn) return false
      const selection = home.selection.value()
      return (
        selection.server === ServerConnection.key(conn) &&
        !!selection.directory &&
        pathKey(selection.directory) === pathKey(item.directory)
      )
    },
    // Toggles, exactly as selecting a project row does: picking the selected
    // row again widens the session list back to every profile.
    select: (item: HomeScopeItem) => {
      const conn = open(item)
      if (conn) home.project.select(conn, item.directory)
    },
    // Not home.project.openProjectNewSession: the draft's id has to come back
    // so the source can record which item the session was started from.
    // Without it the user is asked to name the profile they just clicked.
    openNewSession: (item: HomeScopeItem) => {
      const conn = open(item)
      if (!conn) return
      global.ensureServerCtx(conn).projects.touch(item.directory)
      void tabs
        .newDraft({ server: ServerConnection.key(conn), directory: item.directory })
        .then((tab) => source()?.onNewSession?.(item, tab.draftID))
    },
  }
}

export type HomeScopeController = ReturnType<typeof createHomeScopeController>
