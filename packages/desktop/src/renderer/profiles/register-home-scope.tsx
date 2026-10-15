// Hands the home screen its left pane: developer profiles where opencode lists
// projects.
//
// Rendered (returning nothing) inside index.tsx's serverScoped slot so it can
// close over the signed-in account, while the pane itself is drawn far away by
// packages/app -- the same arrangement as register-session-target.tsx, and for
// the same reason: only this process can read `window.api.profiles`, and only
// packages/app knows what that pane is supposed to look like.
//
// What the pane does with these items is unchanged from the project list it
// replaces. Each item names a working directory, selecting a row narrows the
// session list to that directory, and selecting it again widens it back out.
// The profile is simply a better answer to "which of these do I want", because
// it is the thing the user set up and named.

import { createMemo, createResource, onCleanup, onMount } from "solid-js"
import { setHomeScopeSource, useLanguage, type HomeScopeItem, type HomeScopeSource } from "@opencode-ai/app"

import { describeTarget } from "../../main/profiles/profile"

import { listProfiles } from "./client"
import { conversationKey } from "./conversation-key"
import { createProfilesTranslator } from "./i18n"
import { openProfiles } from "./open-state"
import { setPendingProfile } from "./pending-choice"
import { profilesRevision } from "./revision"

export function RegisterHomeScope(props: { locale: string | undefined; accountEmail: string }) {
  const t = createProfilesTranslator(props.locale)
  const language = useLanguage()

  // Keyed on the revision as well as the account, so a profile created or
  // deleted anywhere in this window shows up here too.
  const [profiles] = createResource(
    () => [props.accountEmail, profilesRevision()] as const,
    ([email]) => listProfiles(email),
  )

  // A memo, not a plain closure: the pane reads this source many times per
  // render, and a fresh object each time would remount every row whenever any
  // unrelated signal changed.
  const source = createMemo(
    (): HomeScopeSource => ({
      title: t("profiles.home.title"),
      addLabel: t("profiles.action.create"),
      editLabel: t("profiles.action.edit"),
      // Upstream's own wording: this row starts an ordinary session, and calling
      // it something else here would suggest it does not.
      newSessionLabel: language.t("command.session.new"),
      emptyLabel: t("profiles.list.emptyHint"),
      items: (profiles() ?? []).map(
        (profile): HomeScopeItem => ({
          id: profile.id,
          name: profile.name,
          directory: profile.workingDirectory,
          detail: describeTarget(profile),
        }),
      ),
      onAdd: () => openProfiles({ kind: "create" }),
      onEdit: (item) => openProfiles({ kind: "edit", id: item.id }),
      // Clicking a profile row is already the answer to "which profile?", so
      // the draft it opens carries it and is never asked again. The choice is
      // still verified and still switches the agent -- see pending-choice.ts.
      onNewSession: (item, draftId) => {
        const conversation = conversationKey(undefined, draftId)
        if (conversation) setPendingProfile(conversation, item.id)
      },
    }),
  )

  onMount(() => setHomeScopeSource(source))
  onCleanup(() => setHomeScopeSource(null))
  return null
}
