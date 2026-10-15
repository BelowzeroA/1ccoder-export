import { createPromptProjectController } from "@/components/prompt-project-selector"
import type { SessionTargetSlotInput } from "@/components/session-target-slot"
import { useTitlebarRightMount } from "@/components/titlebar"
import { useSettings } from "@/context/settings"
import { createEffect, createResource } from "solid-js"
import { createNewSessionDraftController } from "./new-session/new-session-draft-controller"
import { NewSessionStatus, NewSessionView } from "./new-session/new-session-view"
import { createNewSessionWorkspaceController } from "./new-session/new-session-workspace-controller"
import { useNewSessionCommands } from "./new-session/use-new-session-commands"

/** The draft-only V2 session page. Submitting promotes the draft into a real session. */
export default function NewSessionPage() {
  const settings = useSettings()
  const rightMount = useTitlebarRightMount()
  const workspace = createNewSessionWorkspaceController()
  const draft = createNewSessionDraftController({
    worktree: workspace.selection.value,
    resetWorktree: workspace.selection.reset,
  })
  const project = createPromptProjectController({
    controls: draft.project.controls,
    onDone: draft.input.restoreFocus,
  })
  useNewSessionCommands({
    restoreFocus: draft.input.restoreFocus,
    project: {
      empty: project.empty,
      open: () => project.setOpen(true),
    },
  })
  createEffect(() => {
    if (!draft.prompt.ready()) return
    draft.input.restoreFocus()
  })

  // 1CCoder replaces the project picker with a developer-profile picker, which
  // supplies the directory itself. This is everything that picker needs in
  // order to move the draft, expressed without knowing what the picker is.
  const target: SessionTargetSlotInput = {
    selectDirectory: (worktree) => draft.project.controls().select(worktree),
    currentDirectory: () => draft.project.controls().directory,
    // A session with no profile lands on the default project -- the folder the
    // desktop app creates on first launch. Matched by name because that is what
    // identifies it; the most recent project, and then the current directory,
    // are the fallbacks if it is gone.
    defaultDirectory: () => {
      const available = draft.project.controls().available
      const named = available.find((project) => /[\\/]Default Project[\\/]?$/.test(project.worktree))
      return named?.worktree ?? available[0]?.worktree ?? draft.project.controls().directory
    },
  }
  const ready = Promise.resolve()
  const [suspendUntilPromptReady] = createResource(
    () => draft.prompt.readyPromise() ?? ready,
    (promise) => promise.then(() => true),
  )

  return (
    <div class="relative size-full overflow-hidden flex flex-col">
      {suspendUntilPromptReady()}
      <NewSessionStatus mount={rightMount} visible={settings.visibility.status} />
      <div class="flex-1 min-h-0 flex flex-col gap-2 p-2">
        <NewSessionView input={draft.input} project={project} workspace={workspace} target={target} />
      </div>
    </div>
  )
}
