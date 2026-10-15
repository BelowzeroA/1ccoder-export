// The developer profile of a running session, beside the model picker.
//
// Text, not a control. A session's profile is settled when the session starts:
// it decides the working directory the agent writes into and the infobase the
// `1c_*` tools talk to, and a conversation that has already run against one
// cannot be moved to another without invalidating everything in it. So here the
// profile is reported, and the way to work against a different one is to start
// a session with it -- which is what the new-session screen's picker is for.
//
// It replaces a floating caption that sat pinned over the middle of the window
// and carried a "Изменить" button. The caption was in the way, and the button
// offered a change that should never have been on offer.

import { Show } from "solid-js"

import { isSessionKey } from "./conversation-key"
import { createProfilesTranslator } from "./i18n"
import { createSessionProfile } from "./use-session-profile"

export function SessionProfileNote(props: { locale: string | undefined; accountEmail: string }) {
  const t = createProfilesTranslator(props.locale)

  // No selectDirectory: a running session's directory is fixed, and this
  // surface has no business moving it even if something asked it to.
  const session = createSessionProfile({ accountEmail: props.accountEmail })

  const label = () => {
    const profile = session.boundProfile()
    if (profile) return profile.name
    // "Never asked" and "chose to work without a profile" are different answers
    // and must not read alike -- see main/profiles/session-binding.ts.
    if (session.binding()) return t("session.picker.withoutTitle")
    return t("session.note.none")
  }

  // Sessions only. The same composer renders on the new-session screen, where
  // the profile is still a choice and SessionProfileSelector sits right below
  // it -- two of them, one offering a change and one refusing it, would be one
  // too many and the wrong one might be believed.
  return (
    <Show when={session.key()} keyed>
      {(key) => (
        <Show when={isSessionKey(key)}>
          <span
            data-1ccoder-session-profile-note
            title={label()}
            class="flex h-7 min-w-0 max-w-[180px] shrink items-center px-1.5 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-faint"
          >
            <span class="min-w-0 truncate">{label()}</span>
          </span>
        </Show>
      )}
    </Show>
  )
}
