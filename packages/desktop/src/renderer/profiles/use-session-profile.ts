// The session's developer-profile binding: reading it, and changing it.
//
// Extracted from SessionProfileControl so two surfaces can share it. The inline
// selector on the new-session screen (SessionProfileSelector) and the caption
// plus modal picker on a running session (SessionProfileControl) ask exactly
// the same questions of the same store, and duplicating the verify -> bind ->
// switch-agent sequence in both would be two places to get it wrong.
//
// The profile also decides where the session runs. A profile names a working
// directory, so choosing one points the session at it; choosing "without a
// profile" points the session at the default project. That is why opencode's
// own project picker is gone from this screen -- see
// packages/app/src/components/session-target-slot.tsx.

import { createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { useLocation, useSearchParams } from "@solidjs/router"
import { useServerSDK } from "@opencode-ai/app"

import { agentForBinding, DEFAULT_AGENT, isProfileAgent, NOPROFILE_AGENT } from "../../main/skills/agents"
import { MCP_CLIENT_NAME, mcpUrl } from "../../main/mcp/toolkit"

import {
  draftFromProfile,
  ensureToolkit,
  getBinding,
  linkToolkit,
  listProfiles,
  setBinding,
  toolkitHealth,
  verifyProfile,
  type DeveloperProfile,
  type VerificationResult,
} from "./client"
import { ToolkitLink, TOOLKIT_POLL_MS } from "./toolkit-link"
import { conversationKey, isSessionKey, sessionIdFromPath } from "./conversation-key"
import { claimPendingProfile, clearPendingProfile, pendingProfile } from "./pending-choice"
import { bindingsRevision, bumpBindingsRevision, profilesRevision } from "./revision"

/**
 * The profile whose toolkit each session folder's `1c` MCP client was last
 * pointed at from this window, by folder ("" when the sidecar gave none).
 */
const linkedProfiles = new Map<string, string>()

export interface SessionProfileInput {
  readonly accountEmail: string
  /**
   * Where to send the session once a profile is chosen. Absent on surfaces that
   * cannot move it -- a running session's directory is already fixed, and
   * changing it under a live conversation is not something a caption should do.
   */
  readonly selectDirectory?: (worktree: string) => void
  /** The directory a session with no profile falls back to. */
  readonly defaultDirectory?: () => string | undefined
}

export function createSessionProfile(input: SessionProfileInput) {
  const location = useLocation()
  const [search] = useSearchParams<{ draftId?: string }>()
  const sdk = useServerSDK()

  // Derived from the path, not from useParams -- see sessionIdFromPath for why
  // params are empty on one of the two surfaces this hook serves.
  const sessionId = createMemo(() => sessionIdFromPath(location.pathname))
  const key = createMemo(() => conversationKey(sessionId(), search.draftId))

  // The draft this window was last on, remembered because promoteDraft swaps
  // the tab in place and the draftId leaves the URL -- without this, the choice
  // made on the draft page would be lost the moment the session is created.
  let lastDraftKey: string | undefined
  createEffect(() => {
    const draftId = search.draftId
    if (draftId) lastDraftKey = `draft:${draftId}`
  })

  // Keyed on the revision as well as the account, so creating or deleting a
  // profile anywhere in this window reloads the list here too.
  const [profiles, { refetch: refetchProfiles }] = createResource(
    () => [input.accountEmail, profilesRevision()] as const,
    ([email]) => listProfiles(email),
  )

  // Re-read whenever the conversation changes: switching sessions must switch
  // the caption, and a conversation never asked must raise the picker.
  // Keyed on the revision as well as the conversation, so a choice made on
  // either surface is seen by both. The source stays undefined until there is a
  // conversation, which is what keeps the resource from fetching too early.
  const [binding, { refetch: refetchBinding }] = createResource(
    () => {
      const conversation = key()
      return conversation ? ([conversation, bindingsRevision()] as const) : undefined
    },
    async ([conversationKey]) => {
      const existing = await getBinding(conversationKey)
      if (existing) {
        // A session bound in an earlier run of the app arrives here with its
        // agent already decided -- unless the switch never happened, which is
        // exactly what a bound session still sitting on the default agent
        // means. Reconciling only that case leaves an agent the user picked
        // themselves alone, and repairs the sessions our own carry-over broke.
        if (isSessionKey(conversationKey)) void reconcileAgent(existing.profileId ?? null)
        return existing
      }

      // The draft just became a session. Carry the choice over rather than asking
      // again for a conversation the user has already answered for.
      if (isSessionKey(conversationKey) && lastDraftKey) {
        const carried = await getBinding(lastDraftKey)
        if (carried) {
          const moved = await setBinding(conversationKey, carried.profileId)
          lastDraftKey = undefined
          bumpBindingsRevision()
          // The choice was made on the draft, where there was no session to
          // switch and no infobase to open. Both are due now, and both are
          // derived from the binding rather than from something remembered in
          // this window: the draft may well have been answered in a previous
          // run of the app, and a variable does not survive that.
          await applyAgent(await agentFor(carried.profileId))
          return moved
        }
      }

      return null
    },
  )

  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<VerificationResult | null>(null)

  // A profile chosen before this conversation existed -- "Новая сессия" on a
  // profile row of the home screen (see pending-choice.ts). Answering it here
  // rather than at the click keeps one path for every choice: the same
  // verification, the same agent switch, the same failure report when the
  // profile does not work.
  createEffect(() => {
    const conversation = key()
    if (!conversation || binding.loading || binding()) return
    const list = profiles()
    if (!list || !pendingProfile(conversation)) return
    const claimed = claimPendingProfile(conversation)
    if (!claimed) return
    const profile = list.find((item) => item.id === claimed)
    if (!profile) {
      // The profile was deleted between the click and the draft opening. Let
      // the picker ask, rather than starting on something that is gone.
      clearPendingProfile(conversation)
      return
    }
    void choose(profile).finally(() => clearPendingProfile(conversation))
  })

  const boundProfile = () => {
    const id = binding()?.profileId
    if (!id) return null
    return profiles()?.find((profile) => profile.id === id) ?? null
  }

  /**
   * Points the conversation at the agent that matches the choice.
   *
   * The two agents differ in which skills they can see and whether they may
   * write to an infobase (see main/skills/agents.ts).
   *
   * This goes through the server rather than through `useLocal`, which would be
   * the obvious choice and does not work here: LocalProvider is mounted inside
   * the /:dir route (pages/directory-layout.tsx) while the caption renders in
   * the serverScoped slot, which is a sibling of that subtree. Calling useLocal
   * from there throws "Local context must be used within a context provider".
   * That same structural position is why the session id comes from the path.
   *
   * Before the session exists there is nothing to switch; the binding carries
   * the choice instead, and the carry-over above applies it the moment the
   * draft becomes a session. It used to be remembered in a variable here, which
   * worked only while the app stayed open -- a draft answered yesterday was
   * promoted today onto the default agent, with no infobase prompt and none of
   * the 1CCoder skills.
   */
  async function applyAgent(name: string) {
    const sessionID = sessionId()
    if (!sessionID) return
    try {
      await sdk().api.session.switchAgent({ sessionID, agent: name })
    } catch {
      // The agent list comes from the sidecar's config. If our agents are not
      // there yet, the choice still stands -- it is the binding that decides
      // what may run, and the caption must not fail over a preference.
    }
  }

  /**
   * The agent a binding calls for, from the profile as stored right now.
   *
   * Read fresh rather than from `profiles()`: the configuration is detected in
   * the main process (mcp/ipc.ts detectConfiguration) and nothing bumps the
   * list's revision when it lands, so the cached list can be a detection behind.
   */
  async function agentFor(profileId: string | null): Promise<string> {
    if (!profileId) return agentForBinding(null)
    const fresh = await listProfiles(input.accountEmail).catch(() => profiles() ?? [])
    return agentForBinding(profileId, fresh.find((item) => item.id === profileId)?.configuration?.name)
  }

  /**
   * Puts an already-bound session on the agent its binding calls for, if
   * nobody has chosen one.
   *
   * The restraint matters: a session whose agent the user changed themselves
   * must keep it, so this acts only on the default agent -- which is what a
   * session sits on when our own switch never happened. That is a state real
   * sessions are in, since the carry-over above used to skip the switch
   * entirely.
   */
  async function reconcileAgent(profileId: string | null) {
    const sessionID = sessionId()
    if (!sessionID) return
    const wanted = await agentFor(profileId)
    try {
      const session = await sdk().api.session.get({ sessionID })
      const current = session.agent
      // Also moves a session between our own profile agents: a configuration
      // detected since the session began upgrades it to the pack's agent. Any
      // agent the user picked themselves is still left alone.
      if (current && current !== DEFAULT_AGENT && !isProfileAgent(current)) return
      if (current === wanted) return
      await sdk().api.session.switchAgent({ sessionID, agent: wanted })
    } catch {
      // Same reasoning as applyAgent: a preference must not break the caption.
    }
  }

  /**
   * Opens the toolkit for a profile, and makes sure the sidecar notices it.
   *
   * Not awaited by callers: opening 1C takes tens of seconds and the session is
   * usable long before that. The link below is what turns a toolkit that came
   * up late into tools the agent can actually call.
   *
   * No longer called when a profile is bound. Binding a profile is not asking
   * for an infobase: most sessions start with file work, and opening 1C for
   * them put a window on screen before the user had typed anything. It is worse
   * than merely early -- the current MCP_Toolkit.epf ignores the startup
   * parameter we pass and only serves once someone presses "Подключиться" on
   * its form, so the eager launch produced a window that did nothing at all.
   */
  function startToolkit(profileId: string) {
    void ensureToolkit(profileId)
      .catch(() => undefined)
      .then(() => link.sync())
      .catch(() => undefined)
  }

  /** The instance the sidecar runs this session in -- the one whose MCP client matters. */
  async function sessionDirectory(sessionID: string): Promise<string | undefined> {
    try {
      return (await sdk().api.session.get({ sessionID })).location?.directory
    } catch {
      return undefined
    }
  }

  async function setToolkitConnection(connected: boolean) {
    const sessionID = sessionId()
    if (!sessionID) return
    const directory = await sessionDirectory(sessionID)
    const target = { name: MCP_CLIENT_NAME, ...(directory ? { directory } : {}) }
    const client = sdk().client
    const profileId = binding()?.profileId
    // Each profile's toolkit listens on its own port (main/mcp/toolkit-ports.ts),
    // while opencode's config names one address for every folder. So the
    // folder's client is re-pointed at this profile's port, not just connected.
    const port = connected && profileId ? await linkToolkit(directory, profileId).catch(() => null) : null
    if (port && profileId) {
      await client.mcp.add({ ...target, config: { type: "remote", url: mcpUrl(port), enabled: true } })
      linkedProfiles.set(directory ?? "", profileId)
      return
    }
    await (connected ? client.mcp.connect(target) : client.mcp.disconnect(target))
    if (!connected) linkedProfiles.delete(directory ?? "")
  }

  const link = new ToolkitLink({
    // The bound profile lets the app detect which configuration the toolkit
    // serves -- see main/mcp/ipc.ts noticeHealth.
    health: () => toolkitHealth(binding()?.profileId ?? undefined),
    connect: () => setToolkitConnection(true),
    disconnect: () => setToolkitConnection(false),
    // What the sidecar really holds, not what the last connect call answered --
    // see toolkit-link.ts.
    sidecarConnected: async () => {
      const sessionID = sessionId()
      if (!sessionID) return false
      const directory = await sessionDirectory(sessionID)
      // Connected, but to another profile's toolkit (two sessions in one
      // folder): not this session's link, so it is made again.
      if (linkedProfiles.get(directory ?? "") !== binding()?.profileId) return false
      const status = await sdk().client.mcp.status(directory ? { directory } : undefined)
      return (status.data as Record<string, { status?: string }> | undefined)?.[MCP_CLIENT_NAME]?.status === "connected"
    },
  })

  // While a profile session is open, keep asking whether the toolkit is there.
  // The sidecar connects a remote MCP server once and never retries, so this
  // poll is the only thing standing between "the toolkit is running" and "the
  // agent has its tools" -- including when the user starts the toolkit by hand
  // after a failed launch.
  createEffect(() => {
    const sessionID = sessionId()
    const profileId = binding()?.profileId
    if (!sessionID || !profileId) return
    void link.sync().catch(() => undefined)
    const timer = setInterval(() => {
      void link.sync().catch(() => undefined)
    }, TOOLKIT_POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  /**
   * Records the choice. Returns false when a profile was rejected by
   * verification, so a caller showing a picker knows to keep it open.
   */
  async function choose(profile: DeveloperProfile | null): Promise<boolean> {
    const conversationKey = key()
    if (!conversationKey) return false

    setFailure(null)

    if (!profile) {
      await setBinding(conversationKey, null)
      bumpBindingsRevision()
      void applyAgent(NOPROFILE_AGENT)
      // A profile-less session still needs somewhere to be. The default project
      // is that somewhere.
      const fallback = input.defaultDirectory?.()
      if (fallback) input.selectDirectory?.(fallback)
      await refetchBinding()
      return true
    }

    setBusy(true)
    try {
      // The same check that gates saving a profile. A path that was valid last
      // week may not be today -- a moved file infobase, a cluster that is down,
      // a password changed by an administrator.
      const result = await verifyProfile(draftFromProfile(profile), profile.id)
      if (!result.ok) {
        setFailure(result)
        return false
      }
      await setBinding(conversationKey, profile.id)
      bumpBindingsRevision()
      void agentFor(profile.id).then(applyAgent)
      // The toolkit is deliberately NOT started here -- see startToolkit. The
      // poll below still connects one the moment it appears, whoever started
      // it, so a session that does need the infobase loses nothing but the
      // head start.
      // The profile's working directory is where this session belongs.
      if (profile.workingDirectory) input.selectDirectory?.(profile.workingDirectory)
      await refetchBinding()
      return true
    } finally {
      setBusy(false)
    }
  }

  return {
    key,
    profiles,
    refetchProfiles,
    binding,
    boundProfile,
    busy,
    failure,
    setFailure,
    choose,
    /** True once we know the conversation has never been asked. */
    unasked: () => !binding.loading && binding() === null,
    /** A choice already made for this conversation and not yet applied. */
    pending: () => pendingProfile(key()),
  }
}

export type SessionProfile = ReturnType<typeof createSessionProfile>
