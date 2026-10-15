import type { Session } from "@opencode-ai/sdk/v2/client"
import { preloadMarkdown } from "@opencode-ai/session-ui/markdown-cache"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useQuery } from "@tanstack/solid-query"
import { DateTime } from "luxon"
import { type Accessor, createEffect, createMemo, createRoot, createSignal, type JSX, startTransition } from "solid-js"
import { produce } from "solid-js/store"
import { useCommand } from "@/context/command"
import {
  loadHomeSessionIndex,
  retainHomeSessions,
  type HomeSessionEvents,
} from "@/context/global-sync/home-session-index"
import type { LocalProject } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import { sessionHasOpenTab, useTabs } from "@/context/tabs"
import { compareSessionTime, displayName, errorMessage, projectForSession } from "@/pages/layout/helpers"
import { useSessionTabAvatarState } from "@/pages/layout/project-avatar-state"
import { pathKey } from "@/utils/path-key"
import { showToast } from "@/utils/toast"
import { Binary } from "@opencode-ai/core/util/binary"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DialogFooter, DialogHeader, DialogTitleGroup, DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { sessionTitle } from "@/utils/session-title"
import { archiveHomeSession } from "../home-session-archive"
import { deleteHomeSession } from "../home-session-delete"
import type { HomeController } from "./home-controller"
import { homeScopeName } from "./home-scope-slot"

const HOME_SESSION_LIMIT = 64
export type HomeSessionRecord = {
  session: Session
  project: LocalProject
  projectName: string
}

export type HomeSessionGroup = {
  id: "today" | "yesterday" | "older"
  title: string
  sessions: HomeSessionRecord[]
}

export type OpenSessionOptions = { background?: boolean }

export function createHomeSessionsController(home: HomeController) {
  const tabs = useTabs()
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()
  const projectDirectories = createMemo(() => {
    const project = home.project.selected()
    if (!project) return home.project.list().flatMap(directories)
    return directories(project)
  })
  const projectByID = createMemo(
    () => new Map(home.project.list().flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
  )
  const homeSessions = () => home.server.focusedSync().homeSessions
  const sessionEventLoad = useQuery(() => ({
    queryKey: homeSessions().eventsKey,
    queryFn: async (): Promise<HomeSessionEvents> => ({ sequence: 0, entries: [] }),
    initialData: { sequence: 0, entries: [] } satisfies HomeSessionEvents,
    enabled: false,
  }))
  const sessionLoad = useQuery(() => ({
    queryKey: homeSessions().indexKey,
    enabled: !!home.server.focusedContext(),
    queryFn: async ({ signal }) => {
      const ctx = home.server.focusedContext()
      if (!ctx) return { sessions: [], eventSequence: 0 }
      const cache = homeSessions()
      const eventSequence = cache.eventSequence()
      const index = await loadHomeSessionIndex(
        (input, options) => ctx.sdk.client.v2.session.list(input, options),
        eventSequence,
        signal,
      )
      cache.complete(eventSequence)
      return index
    },
    retry: false,
    staleTime: 30_000,
    refetchOnMount: true,
    refetchOnReconnect: true,
  }))
  /**
   * Sessions this window has just removed, so the row goes at once.
   *
   * The index cache keeps its own set, but nothing about it is reactive, and
   * its query-data update only lands when the session was in the fetched index
   * -- a session created during this run need not be. Both paths left the row
   * on screen for a session the server had already deleted. This signal is what
   * the list actually reads, so a removal always redraws.
   */
  const [removedSessions, setRemovedSessions] = createSignal<ReadonlySet<string>>(new Set())
  const forgetSession = (sessionID: string) => {
    homeSessions().remove(sessionID)
    setRemovedSessions((current) => (current.has(sessionID) ? current : new Set(current).add(sessionID)))
  }
  const indexedSessions = createMemo(() => {
    const gone = removedSessions()
    const listed = homeSessions().sessions(sessionLoad.data, sessionEventLoad.data)
    return retainHomeSessions(
      gone.size === 0 ? listed : listed.filter((session) => !gone.has(session.id)),
      HOME_SESSION_LIMIT,
      Date.now(),
    )
  })
  const allRecords = createMemo(() =>
    buildHomeSessionRecords({
      sessions: indexedSessions,
      projectDirectories,
      projects: home.project.list,
      projectByID,
    }),
  )
  const records = createMemo(() => allRecords().slice(0, HOME_SESSION_LIMIT))
  const groups = createMemo(() => groupSessions(records(), language))
  const prefetched = new Set<string>()

  createEffect(() => {
    const ctx = home.server.focusedContext()
    const conn = home.server.focused()
    if (!ctx || !conn) return
    records()
      .slice(0, 2)
      .forEach((record) => {
        const key = `${ServerConnection.key(conn)}\0${record.session.id}`
        if (prefetched.has(key)) return
        prefetched.add(key)
        createRoot((dispose) => {
          try {
            void ctx.sync.session
              .sync(record.session.id)
              .then(() =>
                Promise.all(
                  (ctx.sync.session.data.message[record.session.id] ?? []).flatMap((message) =>
                    (ctx.sync.session.data.part[message.id] ?? []).flatMap((part) => {
                      if (part.type !== "text" || !part.text) return []
                      return preloadMarkdown(part.text, part.id)
                    }),
                  ),
                ),
              )
              .catch(() => {})
              .finally(dispose)
          } catch {
            dispose()
          }
        })
      })
  })

  command.register("home.palette", () => [
    {
      id: "command.palette",
      title: language.t("command.palette"),
      hidden: true,
      onSelect: async () => {
        const conn = home.server.focused()
        if (!conn) return
        const ctx = home.server.focusedContext()
        if (!ctx) return
        const { DialogHomeCommandPaletteV2 } = await import("@/components/dialog-command-palette-v2")
        void dialog.show(() => (
          <DialogHomeCommandPaletteV2
            server={conn}
            onSelectSession={(entry) => {
              if (!entry.sessionID || !entry.directory || !entry.server) return
              const sessionID = entry.sessionID
              const server = entry.server
              const directory = entry.project?.worktree ?? entry.directory
              ctx.projects.open(directory)
              ctx.projects.touch(directory)
              void startTransition(() => {
                const tab = tabs.addSessionTab({ server, sessionId: sessionID })
                tabs.select(tab)
              })
            }}
          />
        ))
      },
    },
  ])

  return {
    copy: {
      language,
    },
    data: {
      records,
      groups,
      loading: () => sessionLoad.isLoading,
      searchRecords: allRecords,
    },
    session: {
      showProjectName: () => !home.project.selected(),
      server: () => home.selection.value().server,
      canCreate: () => !!home.project.newSession(),
      create: home.project.openNewSession,
      open: (session: Session, options?: OpenSessionOptions) => {
        const directoryKey = pathKey(session.directory)
        const project =
          home.project
            .list()
            .find(
              (item) =>
                pathKey(item.worktree) === directoryKey ||
                item.sandboxes?.some((sandbox) => pathKey(sandbox) === directoryKey),
            ) ?? projectForSession(session, home.project.list(), projectByID())
        const conn = home.server.focused()
        if (!conn) return
        const directory = project?.worktree ?? session.directory
        const ctx = home.server.focusedContext()
        if (!ctx) return
        ctx.projects.open(directory)
        if (options?.background) {
          tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })
          return
        }
        ctx.projects.touch(directory)
        void startTransition(() => {
          const tab = tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })
          tabs.select(tab)
        })
      },
      archive: async (session: Session) => {
        const conn = home.server.focused()
        const ctx = home.server.focusedContext()
        if (!conn || !ctx) return
        const [, setStore] = ctx.sync.child(session.directory)
        if ((await ctx.sdk.protocol) !== "v1") return
        await archiveHomeSession({
          server: ServerConnection.key(conn),
          session,
          archive: (sessionID) =>
            ctx.sdk.client.session.update({
              sessionID,
              directory: session.directory,
              time: { archived: Date.now() },
            }),
          remove: () => {
            setStore(
              produce((draft) => {
                const match = Binary.search(draft.session, session.id, (item) => item.id)
                if (match.found) draft.session.splice(match.index, 1)
              }),
            )
            forgetSession(session.id)
          },
          onError: (cause) =>
            showToast({
              title: language.t("common.requestFailed"),
              description: errorMessage(cause, language.t("common.requestFailed")),
            }),
        })
      },
      // Unlike archiving, this cannot be undone, so it asks first -- the same
      // confirmation the session page already shows for the same action.
      remove: async (session: Session) => {
        const conn = home.server.focused()
        const ctx = home.server.focusedContext()
        if (!conn || !ctx) return
        const name = sessionTitle(session.title) || language.t("command.session.new")

        // show() resolves when its transition settles, not when the dialog is
        // dismissed -- the answer arrives through onClose, which fires for the
        // buttons, Escape and the overlay alike. Anything but the danger button
        // therefore means "no".
        const confirmed = await new Promise<boolean>((resolve) => {
          let answer = false
          void dialog.show(
            () => (
              <DialogV2 fit>
                <DialogHeader hideClose>
                  <DialogTitleGroup
                    title={language.t("session.delete.title")}
                    description={language.t("session.delete.confirm", { name })}
                  />
                </DialogHeader>
                <DialogFooter>
                  <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
                    {language.t("common.cancel")}
                  </ButtonV2>
                  <ButtonV2
                    variant="danger"
                    onClick={() => {
                      answer = true
                      dialog.close()
                    }}
                  >
                    {language.t("session.delete.button")}
                  </ButtonV2>
                </DialogFooter>
              </DialogV2>
            ),
            () => resolve(answer),
          )
        })
        if (!confirmed) return

        // The per-directory sync store only exists on a v1 server -- which is
        // why archive() bails out entirely when the protocol is not v1.
        const legacyStore = (await ctx.sdk.protocol) === "v1"

        await deleteHomeSession({
          server: ServerConnection.key(conn),
          session,
          remove: (sessionID) => ctx.sdk.api.session.remove({ sessionID, directory: session.directory }),
          forget: () => {
            // This is the removal the row actually follows: the Home list is
            // built from the session index, not from the sync store.
            forgetSession(session.id)
            if (!legacyStore) return
            const [, setStore] = ctx.sync.child(session.directory)
            setStore(
              produce((draft) => {
                const match = Binary.search(draft.session, session.id, (item) => item.id)
                if (match.found) draft.session.splice(match.index, 1)
              }),
            )
          },
          onError: (cause) =>
            showToast({
              title: language.t("session.delete.failed.title"),
              description: errorMessage(cause, language.t("common.requestFailed")),
            }),
        })
      },
    },
    tab: {
      isOpen: (record: HomeSessionRecord) =>
        sessionHasOpenTab(tabs.store, home.selection.value().server, record.session),
    },
  }
}

function directories(project: LocalProject) {
  return [project.worktree, ...(project.sandboxes ?? [])]
}

function buildHomeSessionRecords(input: {
  sessions: () => Session[]
  projectDirectories: () => string[]
  projects: () => LocalProject[]
  projectByID: () => Map<string, LocalProject>
}) {
  const directories = new Set(input.projectDirectories().map(pathKey))
  const sessions = input.sessions().filter((session) => directories.has(pathKey(session.directory)))
  return [...new Map(sessions.map((session) => [session.id, session] as const)).values()]
    .sort(compareSessionTime)
    .flatMap((session) => {
      const directory = pathKey(session.directory)
      const project =
        input
          .projects()
          .find(
            (item) =>
              pathKey(item.worktree) === directory || item.sandboxes?.some((sandbox) => pathKey(sandbox) === directory),
          ) ?? projectForSession(session, input.projects(), input.projectByID())
      if (!project) return []
      // 1CCoder names the row after the developer profile the directory belongs
      // to, not the directory's basename. See home-scope-slot.ts.
      return { session, project, projectName: homeScopeName(project.worktree) ?? displayName(project) }
    })
}

export function homeSessionSearchKey(record: HomeSessionRecord) {
  return `${pathKey(record.session.directory)}:${record.session.id}`
}

function groupSessions(records: HomeSessionRecord[], language: ReturnType<typeof useLanguage>): HomeSessionGroup[] {
  const now = DateTime.local()
  const yesterday = now.minus({ days: 1 })
  const todaySessions = records.filter((record) =>
    DateTime.fromMillis(record.session.time.updated ?? record.session.time.created).hasSame(now, "day"),
  )
  const yesterdaySessions = records.filter((record) =>
    DateTime.fromMillis(record.session.time.updated ?? record.session.time.created).hasSame(yesterday, "day"),
  )
  const olderSessions = records.filter((record) => {
    const time = DateTime.fromMillis(record.session.time.updated ?? record.session.time.created)
    return !time.hasSame(now, "day") && !time.hasSame(yesterday, "day")
  })
  const olderTitle =
    todaySessions.length === 0 && yesterdaySessions.length === 0
      ? language.t("sidebar.project.recentSessions")
      : language.t("home.sessions.group.older")
  return [
    { id: "today" as const, title: language.t("home.sessions.group.today"), sessions: todaySessions },
    { id: "yesterday" as const, title: language.t("home.sessions.group.yesterday"), sessions: yesterdaySessions },
    { id: "older" as const, title: olderTitle, sessions: olderSessions },
  ].filter((group) => group.sessions.length > 0)
}

export type HomeSessionsController = ReturnType<typeof createHomeSessionsController>

export function HomeSessionStatusController(props: {
  server: Accessor<ServerConnection.Key>
  record: HomeSessionRecord
  isOpenTab: (record: HomeSessionRecord) => boolean
  render: (state: { unread: Accessor<boolean>; loading: Accessor<boolean>; open: Accessor<boolean> }) => JSX.Element
}) {
  const avatar = useSessionTabAvatarState(
    props.server,
    () => props.record.session.directory,
    () => props.record.session.id,
  )
  return props.render({
    unread: avatar.unread,
    loading: avatar.loading,
    open: () => props.isOpenTab(props.record),
  })
}
