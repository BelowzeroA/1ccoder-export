// The new-session screen's profile picker, sitting where opencode's project
// picker used to.
//
// Deliberately shaped like the control it replaces
// (packages/app/src/components/prompt-project-selector.tsx): a 28px trigger
// showing the current choice with a chevron, a dropdown of radio items with a
// check on the selected one, a divider, and an action that creates a new one.
// Same primitives, same metrics, same type scale, because to the user this is
// the same control answering a better question.
//
// What it does NOT copy is the search field and the per-server grouping. A
// machine has a handful of developer profiles, not a scrollable list of
// repositories, and a search box over four rows is furniture.

import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { For, Show, createSignal, splitProps, type ComponentProps } from "solid-js"

import type { SessionTargetSlotInput } from "@opencode-ai/app"

import { checkCodeKey, createProfilesTranslator, type ProfilesStringKey } from "./i18n"
import { openProfiles } from "./open-state"
import { createSessionProfile } from "./use-session-profile"
import type { DeveloperProfile, VerificationResult } from "./client"

const NONE_KEY = "profile:none"
const ADD_KEY = "action:add"

const itemClass =
  "h-7 gap-2 rounded-sm px-3 text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-base [font-family:var(--v2-font-family-sans)] data-[highlighted]:!bg-v2-overlay-simple-overlay-hover"

export function SessionProfileSelector(
  props: { locale: string | undefined; accountEmail: string } & SessionTargetSlotInput,
) {
  const t = createProfilesTranslator(props.locale)
  const [open, setOpen] = createSignal(false)

  const session = createSessionProfile({
    accountEmail: props.accountEmail,
    selectDirectory: props.selectDirectory,
    defaultDirectory: props.defaultDirectory,
  })

  const label = () => {
    if (session.boundProfile()) return session.boundProfile()!.name
    // "Not asked yet" and "chose to work without a profile" are different
    // states and must not read the same: the first is a prompt, the second is
    // an answer. See main/profiles/session-binding.ts.
    if (session.binding()) return t("session.picker.withoutTitle")
    return t("session.caption.none")
  }

  const pick = async (profile: DeveloperProfile | null) => {
    setOpen(false)
    await session.choose(profile)
  }

  /**
   * The revision signal already reloads the list when a profile is created in
   * this window. This covers what it cannot see: another window's profiles
   * screen writes to the same store, and its signal is not ours.
   */
  const toggle = (next: boolean) => {
    if (next) void session.refetchProfiles()
    setOpen(next)
  }

  return (
    <div data-1ccoder-session-profile class="flex min-w-0 items-center">
      <DropdownMenu open={open()} placement="bottom" gutter={4} modal={false} onOpenChange={toggle}>
        <DropdownMenu.Trigger as={ProfileTrigger} label={label()} bound={Boolean(session.boundProfile())} />
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            id="session-profile-menu"
            class="w-[243px] overflow-hidden rounded-md border-0 bg-v2-background-bg-layer-01 p-0 shadow-[var(--v2-elevation-floating)] focus:outline-none [&[data-closed]]:!animate-none"
          >
            <div class="flex max-h-[224px] flex-col overflow-y-auto p-0.5">
              <DropdownMenu.RadioGroup value={session.boundProfile()?.id ?? (session.binding() ? NONE_KEY : "")}>
                <For each={session.profiles() ?? []}>
                  {(profile) => (
                    <DropdownMenu.RadioItem
                      value={profile.id}
                      class={itemClass}
                      closeOnSelect
                      onSelect={() => void pick(profile)}
                    >
                      <DropdownMenu.ItemLabel class="min-w-0 flex-1 truncate leading-5">
                        {profile.name}
                      </DropdownMenu.ItemLabel>
                      <DropdownMenu.ItemIndicator style={{ width: "14px", height: "14px", right: "12px" }}>
                        <Icon name="check" size="small" class="shrink-0 text-v2-icon-icon-base" />
                      </DropdownMenu.ItemIndicator>
                    </DropdownMenu.RadioItem>
                  )}
                </For>

                {/* Not a lesser option and not styled as one: a profile-less
                    session is how you edit an .epf someone emailed you. */}
                <DropdownMenu.RadioItem
                  value={NONE_KEY}
                  class={itemClass}
                  closeOnSelect
                  onSelect={() => void pick(null)}
                >
                  <DropdownMenu.ItemLabel class="min-w-0 flex-1 truncate leading-5">
                    {t("session.picker.withoutTitle")}
                  </DropdownMenu.ItemLabel>
                  <DropdownMenu.ItemIndicator style={{ width: "14px", height: "14px", right: "12px" }}>
                    <Icon name="check" size="small" class="shrink-0 text-v2-icon-icon-base" />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              </DropdownMenu.RadioGroup>
            </div>

            <div class="h-px bg-v2-border-border-muted" />

            <div class="flex flex-col p-0.5">
              <DropdownMenu.Item
                id={ADD_KEY}
                class={itemClass}
                onSelect={() => {
                  setOpen(false)
                  openProfiles({ kind: "create" })
                }}
              >
                <Icon name="plus" size="small" />
                <DropdownMenu.ItemLabel class="min-w-0 flex-1 truncate leading-5">
                  {t("profiles.action.create")}
                </DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            </div>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>

      <Show when={session.busy()}>
        <span class="ml-2 shrink-0 text-[13px] leading-5 text-v2-text-text-faint">{t("session.picker.checking")}</span>
      </Show>

      <Show when={session.failure()}>{(result) => <FailureDialog t={t} result={result()} session={session} />}</Show>
    </div>
  )
}

function ProfileTrigger(props: ComponentProps<"button"> & { label: string; bound: boolean }) {
  const [local, rest] = splitProps(props, ["label", "bound", "class", "classList"])
  return (
    <button
      {...rest}
      data-action="session-profile"
      type="button"
      class="flex h-7 min-w-0 max-w-[203px] items-center gap-1.5 rounded-sm px-1.5 text-[13px] font-[440] leading-5 tracking-[-0.04px] transition-colors hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
      classList={{ ...local.classList, "text-v2-text-text-faint": !local.bound }}
    >
      <Icon name="server" size="small" class="shrink-0 text-v2-icon-icon-muted" />
      <span class="min-w-0 truncate leading-5">{local.label}</span>
      <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
    </button>
  )
}

/**
 * A rejected profile cannot be dismissed silently: the user asked for a target
 * and did not get one, so they are told which check failed and offered the two
 * ways out that make sense.
 */
function FailureDialog(props: {
  t: ReturnType<typeof createProfilesTranslator>
  result: VerificationResult
  session: ReturnType<typeof createSessionProfile>
}) {
  const t = props.t
  return (
    <div class="fixed inset-0 z-[65] flex items-center justify-center bg-black/40 p-4 text-xs">
      <div class="flex w-full max-w-lg max-h-[85vh] flex-col gap-2 overflow-auto rounded-lg border border-border-base bg-background-base p-4">
        <span class="text-icon-critical-base">{t("session.picker.failedTitle")}</span>
        <For each={props.result.checks.filter((check) => check.status !== "pass")}>
          {(check) => {
            const messageKey = checkCodeKey(check.code)
            return (
              <div class="flex flex-col gap-0.5">
                <span class="text-text-base">
                  {t(`profiles.check.${check.id}` as ProfilesStringKey)}: {messageKey ? t(messageKey) : check.code}
                </span>
                <Show when={check.detail}>
                  <span class="whitespace-pre-wrap break-all text-text-faint">{check.detail}</span>
                </Show>
              </div>
            )
          }}
        </For>
        <div class="flex gap-2 pt-1">
          <button
            type="button"
            class="rounded-md bg-background-stronger px-3 py-1.5 font-medium text-text-strong disabled:opacity-60"
            disabled={props.session.busy()}
            onClick={() => void props.session.choose(null)}
          >
            {t("session.picker.startAnyway")}
          </button>
          <button
            type="button"
            class="rounded-md px-2 py-1 text-text-weak hover:bg-surface-base-hover"
            onClick={() => {
              props.session.setFailure(null)
              openProfiles()
            }}
          >
            {t("session.picker.editProfile")}
          </button>
        </div>
      </div>
    </div>
  )
}
