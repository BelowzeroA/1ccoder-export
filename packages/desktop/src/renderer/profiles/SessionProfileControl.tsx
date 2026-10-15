// The session's developer profile on a running session: the caption that shows
// it, and the modal that demands a choice the first time.
//
// Phase 7 does NOT require a session to have an infobase. It requires an
// explicit choice, which is a different thing: editing an .epf someone emailed
// you, on a machine with no infobase in reach, is legitimate work. So "без
// профиля" is a real answer, remembered like any other, and a session that has
// given it is never asked again.
//
// The modal appears when a conversation has no binding yet (see
// main/profiles/session-binding.ts for why "not asked" and "chose nothing" must
// stay distinguishable). It is the enforcement of that explicit choice, so it
// still runs on the new-session screen even though the inline selector there
// could also answer the question.
//
// The caption, by contrast, is suppressed on the new-session screen:
// SessionProfileSelector already sits under the composer showing the same
// thing, and two captions saying one thing is one too many.
//
// Verification runs when a profile is picked -- the same procedure that gates
// saving a profile. A profile that fails does not start the session; the user
// is offered the two ways out that make sense: start without a profile, or open
// the profiles screen and fix it.

import { For, Show } from "solid-js"
import { useLocation, useSearchParams } from "@solidjs/router"
import { useTabs } from "@opencode-ai/app"

import { type DeveloperProfile, type VerificationResult } from "./client"
import { sessionIdFromPath } from "./conversation-key"
import { checkCodeKey, createProfilesTranslator, type ProfilesStringKey } from "./i18n"
import { openProfiles } from "./open-state"
import { createSessionProfile } from "./use-session-profile"

const primaryClass = "rounded-md bg-background-stronger px-3 py-1.5 text-text-strong font-medium disabled:opacity-60"
const secondaryClass = "rounded-md border border-border-base px-3 py-1.5 text-text-base disabled:opacity-60"
const ghostClass = "rounded-md px-2 py-1 text-text-weak hover:bg-surface-base-hover disabled:opacity-60"

export function SessionProfileControl(props: { locale: string | undefined; accountEmail: string }) {
  const t = createProfilesTranslator(props.locale)
  const [search] = useSearchParams<{ draftId?: string }>()
  const location = useLocation()
  const tabs = useTabs()
  // The directory is not moved from here. A running session's directory is
  // fixed, and the new-session screen has its own control that does move it.
  const session = createSessionProfile({ accountEmail: props.accountEmail })

  /**
   * Open only when the conversation has never been asked.
   *
   * There is no longer a way to reopen it deliberately: the profile decides the
   * working directory and the infobase, and a conversation that has already run
   * against one cannot be moved to another without invalidating what it did. So
   * this is the first-time gate and nothing else -- a different profile means a
   * new session. A conversation started from a profile row has been answered
   * already (see pending-choice.ts) and is never asked.
   */
  const pickerOpen = () => Boolean(session.key()) && session.unasked() && !session.pending()

  async function choose(profile: DeveloperProfile | null) {
    await session.choose(profile)
  }

  /**
   * Backing out.
   *
   * The picker only ever opens as the gate on a conversation that has never
   * chosen, so dismissing it has to undo whatever raised it -- otherwise
   * "Отмена" leaves the user sitting on the session they just declined to
   * start. Closing the tab is that undo, for a draft and for a session alike.
   */
  function cancel() {
    session.setFailure(null)
    const draftId = search.draftId
    const sessionId = sessionIdFromPath(location.pathname)
    const index = tabs.store.findIndex((tab) =>
      draftId ? tab.type === "draft" && tab.draftID === draftId : tab.type === "session" && tab.sessionId === sessionId,
    )
    if (index !== -1) tabs.closeTab(index)
  }

  return (
    <Show when={session.key()}>
      <Show when={pickerOpen()}>{renderPicker()}</Show>
    </Show>
  )

  function renderPicker() {
    return (
      <div class="fixed inset-0 z-[65] flex items-center justify-center bg-black/40 p-4 text-xs">
        <div class="w-full max-w-lg max-h-[85vh] overflow-auto rounded-lg border border-border-base bg-background-base p-4 flex flex-col gap-3">
          <div class="flex flex-col gap-0.5">
            <h2 class="text-base font-semibold text-text-strong">{t("session.picker.title")}</h2>
            <p class="text-text-weak">{t("session.picker.subtitle")}</p>
          </div>

          <Show when={session.failure()}>{(result) => renderFailure(result())}</Show>

          <Show
            when={(session.profiles()?.length ?? 0) > 0}
            fallback={
              <div class="rounded-md border border-border-base p-3 flex flex-col gap-2">
                <span class="text-text-base">{t("session.picker.noProfiles")}</span>
                <button
                  type="button"
                  class={secondaryClass}
                  onClick={() => openProfiles({ kind: "create" })}
                >
                  {t("session.picker.create")}
                </button>
              </div>
            }
          >
            <div class="flex flex-col gap-1">
              <For each={session.profiles()}>
                {(profile) => (
                  <button
                    type="button"
                    disabled={session.busy()}
                    class="w-full rounded-md border border-border-base px-3 py-2 text-left hover:bg-surface-base-hover disabled:opacity-60 flex flex-col gap-0.5"
                    onClick={() => void choose(profile)}
                  >
                    <span class="text-text-strong">{profile.name}</span>
                    <span class="text-text-faint break-all">
                      {profile.kind === "file"
                        ? profile.filePath
                        : `${profile.serverCluster}\\${profile.serverDatabase}`}
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>

          {/* Not a lesser option, and not styled as one: a profile-less session
              is how you edit a file someone sent you. */}
          <button
            type="button"
            disabled={session.busy()}
            class="w-full rounded-md border border-border-base px-3 py-2 text-left hover:bg-surface-base-hover disabled:opacity-60 flex flex-col gap-0.5"
            onClick={() => void choose(null)}
          >
            <span class="text-text-strong">{t("session.picker.withoutTitle")}</span>
            <span class="text-text-faint">{t("session.picker.withoutHint")}</span>
          </button>

          <div class="flex items-center gap-2 pt-1">
            <button type="button" class={ghostClass} disabled={session.busy()} onClick={cancel}>
              {t("profiles.action.cancel")}
            </button>
            <Show when={session.busy()}>
              <span class="text-text-weak">{t("session.picker.checking")}</span>
            </Show>
          </div>
        </div>
      </div>
    )
  }

  function renderFailure(result: VerificationResult) {
    return (
      <div class="rounded-md border border-border-base p-3 flex flex-col gap-2">
        <span class="text-icon-critical-base">{t("session.picker.failedTitle")}</span>
        <For each={result.checks.filter((check) => check.status !== "pass")}>
          {(check) => {
            const messageKey = checkCodeKey(check.code)
            return (
              <div class="flex flex-col gap-0.5">
                <span class="text-text-base">
                  {t(`profiles.check.${check.id}` as ProfilesStringKey)}: {messageKey ? t(messageKey) : check.code}
                </span>
                <Show when={check.detail}>
                  <span class="text-text-faint break-all whitespace-pre-wrap">{check.detail}</span>
                </Show>
              </div>
            )
          }}
        </For>
        <div class="flex gap-2">
          <button type="button" class={primaryClass} disabled={session.busy()} onClick={() => void choose(null)}>
            {t("session.picker.startAnyway")}
          </button>
          <button
            type="button"
            class={ghostClass}
            onClick={() => openProfiles()}
          >
            {t("session.picker.editProfile")}
          </button>
        </div>
      </div>
    )
  }
}
