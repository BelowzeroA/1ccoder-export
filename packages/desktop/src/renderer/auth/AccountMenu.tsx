// Account menu: who is signed in, developer profiles, about, sign-out.
//
// Lives in the title bar, right after opencode's own ☰ menu, as a menu of its
// own rather than as items inside that one: upstream's menu is built from
// DESKTOP_MENU and its shared i18n keys, and adding to it would mean editing
// both. Windows has no native menu bar to use instead -- main/menu.ts returns
// early unless the platform is darwin.
//
// Mounted through AppInterface's `serverScoped` slot (see ../index.tsx) so it
// sits inside the app's provider tree, and portalled into the empty
// `data-1ccoder-slot="titlebar-account"` element titlebar.tsx renders next to
// the ☰ menu. That one element is the whole upstream change.

import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { createSignal, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"

import { openAbout } from "../about/AboutScreen"
import { clearCredential } from "./credential"
import { openProfiles } from "../profiles/open-state"
import { CreditsNote } from "../credits/CreditsNote"
import { daysRemaining } from "./expiry"
import { createAuthTranslator } from "./i18n"

const SLOT_SELECTOR = '[data-1ccoder-slot="titlebar-account"]'

/**
 * The title-bar slot, tracked as it comes and goes. The title bar renders after
 * this component is created, and is rebuilt when the layout setting switches
 * between its two designs, so a one-time lookup would find nothing or go stale.
 */
function useSlot() {
  const find = () => document.querySelector<HTMLElement>(SLOT_SELECTOR) ?? undefined
  const [slot, setSlot] = createSignal(find())
  const observer = new MutationObserver(() => {
    const current = slot()
    if (current?.isConnected) return
    setSlot(find())
  })
  observer.observe(document.body, { childList: true, subtree: true })
  onCleanup(() => observer.disconnect())
  return slot
}

/** Head-and-shoulders silhouette. Inline so it follows the theme's icon color. */
function PersonIcon() {
  return (
    <svg data-slot="icon-svg" width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <circle cx="10" cy="6.5" r="3.5" />
      <path d="M3 17.5c0-3.6 3.1-6 7-6s7 2.4 7 6v.5H3z" />
    </svg>
  )
}

export function AccountMenu(props: {
  locale: string | undefined
  email: string
  expiresAt: number
  onSignedOut: () => void
}) {
  const t = createAuthTranslator(props.locale)
  const slot = useSlot()
  const [busy, setBusy] = createSignal(false)

  async function signOut() {
    setBusy(true)
    try {
      await clearCredential()
      props.onSignedOut()
    } finally {
      setBusy(false)
    }
  }

  const remaining = () => daysRemaining(props.expiresAt, Date.now())

  return (
    <Show when={slot()} keyed>
      {(mount) => (
        <Portal mount={mount} ref={(el) => (el.style.display = "contents")}>
          <DropdownMenu gutter={4} modal={false} placement="bottom-start">
            {/* Dressed like the ☰ trigger beside it, which has one look per
                title-bar design; the slot's ancestry says which design is up. */}
            <Show
              when={mount.closest('[data-slot="titlebar-v2"]')}
              fallback={
                <DropdownMenu.Trigger
                  as="button"
                  type="button"
                  data-component="icon-button"
                  data-variant="ghost"
                  data-size="normal"
                  class="titlebar-icon rounded-md shrink-0"
                  title={props.email}
                  aria-label={t("auth.account.menu")}
                >
                  <PersonIcon />
                </DropdownMenu.Trigger>
              }
            >
              <div
                data-component="desktop-icon-button"
                class="flex h-7 w-9 shrink-0 items-center justify-center rounded-[6px] px-1"
              >
                <DropdownMenu.Trigger
                  as={IconButtonV2}
                  variant="ghost-muted"
                  size="large"
                  icon={<PersonIcon />}
                  title={props.email}
                  aria-label={t("auth.account.menu")}
                />
              </div>
            </Show>
            <DropdownMenu.Portal>
              {/* desktop-app-menu fixes the width at 160px, sized for the ☰
                  menu's short items; the notes here (email, session end,
                  the nowrap credits line) need more. Overridden here rather
                  than in index.css, which the ☰ menu shares. */}
              <DropdownMenu.Content
                class="desktop-app-menu"
                style={{ width: "max-content", "min-width": "240px", "max-width": "min(360px, calc(100vw - 24px))" }}
              >
                <DropdownMenu.Group>
                  <DropdownMenu.GroupLabel class="desktop-app-menu-heading">
                    {t("auth.account.signedInAs")}
                  </DropdownMenu.GroupLabel>
                  <div class="px-2 pb-1.5 flex flex-col gap-0.5 text-xs">
                    <span class="text-text-strong break-all">{props.email}</span>
                    <span class="text-text-faint">
                      {remaining() <= 1
                        ? t("auth.account.expiresToday")
                        : t("auth.account.expiresIn", { days: remaining() })}
                    </span>
                    <CreditsNote locale={props.locale} />
                  </div>
                </DropdownMenu.Group>
                <DropdownMenu.Separator />
                <DropdownMenu.Item onSelect={() => openProfiles()}>
                  <DropdownMenu.ItemLabel>{t("auth.account.profiles")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => openAbout()}>
                  <DropdownMenu.ItemLabel>{t("auth.account.about")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
                <DropdownMenu.Item disabled={busy()} onSelect={() => void signOut()}>
                  <DropdownMenu.ItemLabel>
                    {busy() ? t("auth.busy") : t("auth.account.signOut")}
                  </DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        </Portal>
      )}
    </Show>
  )
}
