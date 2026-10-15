// AutoMode: the per-project permission mode, its indicator, and the one-time
// offer shown the first time a project is opened (Phase 5).
//
// Injected through AppInterface's `serverScoped` slot (see ../index.tsx) for the
// same reasons as the account control: it must sit inside the app's provider
// tree -- it reads the permission context -- while being positioned
// independently of a layout this fork does not own.
//
// The mode itself is a single persisted boolean per project directory, held by
// packages/app's permission context. Three states matter: `true` (AutoMode),
// `false` (manual, chosen), `undefined` (never asked -- offer it once). What
// AutoMode actually permits, and the three classes that keep asking regardless,
// live in packages/app/src/automode/policy.ts.

import { useParams, useSearchParams } from "@solidjs/router"
import { usePermission, useServerSync, useTabs } from "@opencode-ai/app"
import { createMemo, createSignal, For, Show } from "solid-js"

import { decodeDirectory, projectName } from "./directory"
import { createAutoModeTranslator } from "./i18n"

export function AutoModeControl(props: { locale: string | undefined }) {
  const t = createAutoModeTranslator(props.locale)
  const permission = usePermission()
  const serverSync = useServerSync()
  const tabs = useTabs()
  const params = useParams<{ dir?: string; id?: string }>()
  const [search] = useSearchParams<{ draftId?: string }>()
  const [open, setOpen] = createSignal(false)

  // The active project directory. Three routes can be showing: the legacy
  // directory route carries it base64-encoded in the URL, a session route
  // carries only a session id, and a draft tab carries it on the tab.
  const directory = createMemo(() => {
    const fromParams = decodeDirectory(params.dir)
    if (fromParams) return fromParams

    if (params.id) {
      const fromSession = serverSync().session.lineage.peek(params.id)?.session.directory
      if (fromSession) return fromSession
    }

    if (search.draftId) {
      const draft = tabs.store.find((tab) => tab.type === "draft" && tab.draftID === search.draftId)
      if (draft?.type === "draft") return draft.directory
    }

    return undefined
  })

  // `undefined` means the project has never been asked. Guarded on `ready()`
  // because the persisted store starts empty: offering AutoMode before it has
  // loaded would re-ask a project that already answered, on every launch, which
  // is exactly the nagware the decision in Phase 5 rules out.
  const choice = createMemo(() => {
    const dir = directory()
    if (!dir || !permission.ready()) return undefined
    return permission.directoryAutoAcceptChoice(dir)
  })

  const undecided = createMemo(() => {
    const dir = directory()
    if (!dir || !permission.ready()) return false
    return choice() === undefined
  })

  const auto = createMemo(() => choice() === true)

  const decide = (enabled: boolean) => {
    const dir = directory()
    if (!dir) return
    permission.setAutoAcceptDirectory(dir, enabled)
    setOpen(false)
  }

  const alwaysAsks = () => [
    t("automode.offer.asksDestructive"),
    t("automode.offer.asksGit"),
    t("automode.offer.asksInfobase"),
  ]

  return (
    <Show when={directory()} keyed>
      {(dir) => (
        <>
          <Show when={undecided()}>
            <div
              data-1ccoder-automode-offer
              role="dialog"
              aria-modal="true"
              aria-label={t("automode.offer.title")}
              class="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
            >
              <div class="w-full max-w-md rounded-lg border border-border-base bg-surface-base p-5 shadow-xl flex flex-col gap-3 text-sm">
                <div class="flex flex-col gap-1">
                  <span class="text-text-strong text-base">{t("automode.offer.title")}</span>
                  <span class="text-text-faint text-xs">
                    {t("automode.offer.project")}: <span class="break-all">{projectName(dir)}</span>
                  </span>
                </div>

                <p class="text-text-base">{t("automode.offer.body")}</p>

                <div class="flex flex-col gap-1">
                  <span class="text-text-weak">{t("automode.offer.asksTitle")}</span>
                  <ul class="list-disc ps-5 text-text-base flex flex-col gap-0.5">
                    <For each={alwaysAsks()}>{(item) => <li>{item}</li>}</For>
                  </ul>
                </div>

                <p class="text-text-faint text-xs">{t("automode.offer.scope")}</p>

                <div class="flex flex-col gap-2 pt-1">
                  <button
                    type="button"
                    data-action="automode-offer-enable"
                    class="w-full rounded-md bg-surface-base-hover border border-border-base px-3 py-2 text-text-strong hover:bg-surface-base-active"
                    onClick={() => decide(true)}
                  >
                    {t("automode.offer.enable")}
                  </button>
                  <button
                    type="button"
                    data-action="automode-offer-decline"
                    class="w-full rounded-md px-3 py-2 text-text-weak hover:bg-surface-base-hover"
                    onClick={() => decide(false)}
                  >
                    {t("automode.offer.decline")}
                  </button>
                </div>
              </div>
            </div>
          </Show>

          <div data-1ccoder-automode class="fixed bottom-3 right-3 z-50 text-xs flex flex-col items-end">
            <Show when={open()}>
              <div class="mb-2 w-72 rounded-md border border-border-base bg-surface-base p-3 shadow-lg flex flex-col gap-2">
                <div class="flex flex-col gap-0.5">
                  <span class="text-text-strong">
                    {auto() ? t("automode.panel.autoTitle") : t("automode.panel.manualTitle")}
                  </span>
                  <span class="text-text-weak">
                    {auto() ? t("automode.panel.autoBody") : t("automode.panel.manualBody")}
                  </span>
                  <span class="text-text-faint break-all">
                    {t("automode.offer.project")}: {projectName(dir)}
                  </span>
                </div>

                <Show when={auto()}>
                  <div class="flex flex-col gap-0.5">
                    <span class="text-text-weak">{t("automode.panel.alwaysAsks")}</span>
                    <ul class="list-disc ps-4 text-text-base flex flex-col gap-0.5">
                      <For each={alwaysAsks()}>{(item) => <li>{item}</li>}</For>
                    </ul>
                  </div>
                </Show>

                <button
                  type="button"
                  data-action="automode-toggle"
                  class="w-full rounded-md border border-border-base px-2 py-1.5 text-text-base hover:bg-surface-base-hover"
                  onClick={() => decide(!auto())}
                >
                  {auto() ? t("automode.panel.disable") : t("automode.panel.enable")}
                </button>
                <span class="text-text-faint">{t("automode.panel.scope")}</span>
                <button
                  type="button"
                  class="w-full rounded-md px-2 py-1.5 text-text-weak hover:bg-surface-base-hover"
                  onClick={() => setOpen(false)}
                >
                  {t("automode.panel.close")}
                </button>
              </div>
            </Show>

            {/* The indicator is deliberately not subtle when AutoMode is on: an
                agent that silently stopped asking is alarming if the user did
                not realise they enabled it. */}
            <button
              type="button"
              data-action="automode-indicator"
              data-mode={auto() ? "auto" : "manual"}
              aria-label={auto() ? t("automode.mode.auto") : t("automode.mode.manual")}
              class="rounded-full border px-2.5 py-1 transition-opacity"
              classList={{
                "border-border-base bg-surface-base text-text-strong": auto(),
                "border-border-weak-base bg-surface-base/80 text-text-weak opacity-60 hover:opacity-100": !auto(),
              }}
              onClick={() => setOpen((value) => !value)}
            >
              <span aria-hidden="true">{auto() ? "● " : "○ "}</span>
              {auto() ? t("automode.mode.auto") : t("automode.mode.manual")}
            </button>
          </div>
        </>
      )}
    </Show>
  )
}
