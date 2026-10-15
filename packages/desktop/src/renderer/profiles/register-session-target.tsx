// Hands the new-session screen its profile picker.
//
// Rendered (returning nothing) inside index.tsx's serverScoped slot so it can
// close over the signed-in account, while the picker itself is mounted far away
// by packages/app's new-session view. Registration is undone on cleanup, so a
// sign-out leaves upstream's project picker in place rather than a control with
// no account behind it.

import { onCleanup, onMount } from "solid-js"
import { setSessionDirectoryResolver, setSessionProfileNoteRenderer, setSessionTargetRenderer } from "@opencode-ai/app"

import { CreditsNote } from "../credits/CreditsNote"
import { getBinding, listProfiles } from "./client"
import { SessionProfileNote } from "./SessionProfileNote"
import { SessionProfileSelector } from "./SessionProfileSelector"

export function RegisterSessionTarget(props: { locale: string | undefined; accountEmail: string }) {
  onMount(() => {
    setSessionTargetRenderer((input) => (
      <SessionProfileSelector locale={props.locale} accountEmail={props.accountEmail} {...input} />
    ))

    // The same fact on the other surface: chosen on the new-session screen,
    // reported on a running one. The credits ride in the same slot, on every
    // screen: it is the one place in the composer row the fork owns.
    setSessionProfileNoteRenderer(() => (
      <>
        <SessionProfileNote locale={props.locale} accountEmail={props.accountEmail} />
        <CreditsNote
          locale={props.locale}
          class="flex h-7 shrink-0 items-center px-1.5 text-[13px] font-[440] leading-5 tracking-[-0.04px]"
        />
      </>
    ))

    // Where a promoted session runs. Read from the store at submit time rather
    // than from whatever the draft happens to be pointing at, because the two
    // are set by different surfaces -- the inline selector moves the draft, the
    // first-run modal only records the choice -- and only the store is certain
    // to reflect the profile the user actually picked.
    setSessionDirectoryResolver(async ({ draftId }) => {
      if (!draftId) return undefined
      const binding = await getBinding(`draft:${draftId}`).catch(() => null)
      // A null profileId is "без профиля", a real answer: no profile directory
      // to impose, so upstream's own choice stands.
      if (!binding?.profileId) return undefined
      const profiles = await listProfiles(props.accountEmail).catch(() => [])
      return profiles.find((profile) => profile.id === binding.profileId)?.workingDirectory || undefined
    })
  })
  onCleanup(() => {
    setSessionTargetRenderer(null)
    setSessionProfileNoteRenderer(null)
    setSessionDirectoryResolver(null)
  })
  return null
}
