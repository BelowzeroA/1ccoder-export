// The home screen's left pane when a scope source owns it (see
// home-scope-slot.ts). Deliberately shaped like the project pane it stands in
// for — same aside, same 28px rows, same hover-revealed actions — because to
// the user this is the same pane answering a better question.
//
// What it does not copy is drag-to-reorder, the per-server grouping and the
// recently-closed list. A machine has a handful of developer profiles kept in
// one place, not a growing pile of checkouts, and reordering four rows is
// furniture.

import { createSignal, For, Show } from "solid-js"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { ProjectAvatar, PROJECT_AVATAR_VARIANTS } from "@opencode-ai/ui/v2/project-avatar-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { HOME_PROJECT_NAV_LABEL, HomeProjectNavButton, HomeUtilityNav } from "./home-projects-view"
import type { HomeScopeItem, HomeScopeSource } from "./home-scope-slot"

export function HomeScopeView(props: {
  language: ReturnType<typeof useLanguage>
  scope: HomeScopeSource
  selected: (item: HomeScopeItem) => boolean
  onWheel: (event: WheelEvent) => void
  onSelect: (item: HomeScopeItem) => void
  onOpenNewSession: (item: HomeScopeItem) => void
  onOpenSettings: () => void
  onOpenHelp: () => void
}) {
  return (
    <aside
      class={`
        mt-6 flex min-h-0 min-w-0 flex-col gap-4 overflow-hidden
        lg:sticky lg:top-14 lg:mt-14 lg:h-[calc(100cqh-56px)] lg:self-start lg:pt-[52px]
      `}
      aria-label={props.scope.title}
      onWheel={(event) => {
        if (event.target === event.currentTarget) return
        props.onWheel(event)
      }}
    >
      <div class="flex h-7 min-w-0 shrink-0 items-center justify-between pl-1.5 pr-3">
        <div class="text-v2-text-text-muted [font-weight:530]">{props.scope.title}</div>
        {/* The button upstream uses to add a project, kept where it was and
            wired to the new list's own "add". It is never hidden: an empty
            pane is exactly when it is needed most. */}
        <TooltipV2 placement="bottom" value={props.scope.addLabel}>
          <IconButtonV2
            data-action="home-add-project"
            variant="ghost-muted"
            size="large"
            class="titlebar-icon [&_[data-slot=icon-svg]]:text-v2-icon-icon-muted"
            icon={<IconV2 name="folder-add-left" />}
            onClick={() => props.scope.onAdd()}
            aria-label={props.scope.addLabel}
          />
        </TooltipV2>
      </div>
      <ScrollView data-slot="home-scope-scroll" class="min-h-0 min-w-0 shrink">
        <div class="flex min-w-0 flex-col gap-1 pr-3">
          <Show
            when={props.scope.items.length > 0}
            fallback={
              <>
                <HomeProjectNavButton
                  type="button"
                  data-action="home-add-project-row"
                  class="[&>[data-slot=icon-svg]]:text-v2-icon-icon-muted"
                  onClick={() => props.scope.onAdd()}
                >
                  <IconV2 name="folder-add-left" size="small" />
                  <span class={HOME_PROJECT_NAV_LABEL}>{props.scope.addLabel}</span>
                </HomeProjectNavButton>
                <div class="pl-1.5 pr-3 pt-2 text-v2-text-text-faint">{props.scope.emptyLabel}</div>
              </>
            }
          >
            <For each={props.scope.items}>
              {(item) => (
                <HomeScopeRow
                  language={props.language}
                  scope={props.scope}
                  item={item}
                  selected={props.selected(item)}
                  onSelect={props.onSelect}
                  onOpenNewSession={props.onOpenNewSession}
                />
              )}
            </For>
          </Show>
        </div>
      </ScrollView>
      <HomeUtilityNav
        class="mb-8 mt-4 hidden shrink-0 lg:flex"
        onOpenSettings={props.onOpenSettings}
        onOpenHelp={props.onOpenHelp}
        language={props.language}
      />
    </aside>
  )
}

function HomeScopeRow(props: {
  language: ReturnType<typeof useLanguage>
  scope: HomeScopeSource
  item: HomeScopeItem
  selected: boolean
  onSelect: (item: HomeScopeItem) => void
  onOpenNewSession: (item: HomeScopeItem) => void
}) {
  const [menuOpen, setMenuOpen] = createSignal(false)
  return (
    <div class="group/scope relative flex h-7 min-w-0 items-center rounded-[6px]">
      <TooltipV2 placement="right" value={props.item.detail || props.item.directory}>
        <HomeProjectNavButton
          type="button"
          data-component="home-scope-row"
          class="pr-16"
          data-selected={props.selected ? "" : undefined}
          aria-current={props.selected ? "page" : undefined}
          onClick={() => props.onSelect(props.item)}
        >
          <ProjectAvatar fallback={props.item.name} variant={avatarVariant(props.item.id)} />
          <span class={HOME_PROJECT_NAV_LABEL}>{props.item.name}</span>
        </HomeProjectNavButton>
      </TooltipV2>
      <div
        class={`
          hover-reveal absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1
          group-hover/scope:opacity-100 focus-within:opacity-100 data-[menu=true]:opacity-100
        `}
        data-menu={menuOpen()}
      >
        <MenuV2 gutter={6} modal={false} placement="bottom-end" open={menuOpen()} onOpenChange={setMenuOpen}>
          <MenuV2.Trigger
            as={IconButtonV2}
            data-action="home-scope-menu"
            variant="ghost-muted"
            size="small"
            icon={<IconV2 name="outline-dots" />}
            aria-label={props.language.t("common.moreOptions")}
          />
          <MenuV2.Portal>
            <MenuV2.Content>
              <MenuV2.Item onSelect={() => props.onOpenNewSession(props.item)}>
                {props.scope.newSessionLabel}
              </MenuV2.Item>
              <MenuV2.Item onSelect={() => props.scope.onEdit(props.item)}>{props.scope.editLabel}</MenuV2.Item>
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
        <IconButtonV2
          data-action="home-scope-new-session"
          variant="ghost-muted"
          size="small"
          icon={<IconV2 name="edit" />}
          aria-label={props.scope.newSessionLabel}
          onClick={() => props.onOpenNewSession(props.item)}
        />
      </div>
    </div>
  )
}

/**
 * A stable colour per item. Projects take theirs from server metadata; a scope
 * item has none, so it is derived from the id — which keeps a row the same
 * colour across restarts and after the list is reordered or trimmed.
 */
function avatarVariant(id: string) {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.codePointAt(0)!) % 0xffffffff
  return PROJECT_AVATAR_VARIANTS[hash % PROJECT_AVATAR_VARIANTS.length]
}
