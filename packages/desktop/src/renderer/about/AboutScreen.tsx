// "About" window: logo, product description, version and website.
//
// Opened from the account menu, which is the only 1CCoder-owned menu in the
// title bar (see ../auth/AccountMenu.tsx for why the ☰ menu is left alone).
// Same open-state pattern as the profiles screen: a module-level signal, so
// the menu and the window need no prop threaded between them.

import { createSignal, onCleanup, onMount, Show } from "solid-js"

import pkg from "../../../package.json"
import { createAuthTranslator } from "../auth/i18n"
import logo from "./logo.png"

const WEBSITE = "https://1ccoder.ru"

const [isOpen, setOpen] = createSignal(false)

export function openAbout() {
  setOpen(true)
}

export function AboutScreen(props: { locale: string | undefined }) {
  const t = createAuthTranslator(props.locale)

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isOpen()) setOpen(false)
    }
    window.addEventListener("keydown", onKeyDown)
    onCleanup(() => window.removeEventListener("keydown", onKeyDown))
  })

  return (
    <Show when={isOpen()}>
      <div
        class="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4 text-xs"
        onClick={(event) => event.target === event.currentTarget && setOpen(false)}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("auth.about.title")}
          class="w-full max-w-sm rounded-lg border border-border-base bg-background-base p-6 flex flex-col items-center gap-3 text-center"
        >
          <img src={logo} alt="" width="96" height="96" />
          <h2 class="text-base font-semibold text-text-strong">1CCoder</h2>
          <p class="text-text-base">{t("auth.about.description")}</p>
          <span class="text-text-weak">{t("auth.about.version", { version: pkg.version })}</span>
          <a
            href={WEBSITE}
            class="text-text-interactive-base hover:underline"
            onClick={(event) => {
              event.preventDefault()
              window.api.openExternal(WEBSITE)
            }}
          >
            1ccoder.ru
          </a>
          <button
            type="button"
            class="mt-2 rounded-md border border-border-base px-3 py-1.5 text-text-base"
            onClick={() => setOpen(false)}
          >
            {t("auth.about.close")}
          </button>
        </div>
      </div>
    </Show>
  )
}
