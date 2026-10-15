// Native file and folder dialogs for the profile form's path fields.
//
// Typing a path by hand is how a profile ends up holding `d:\Work\stage\`
// while the platform and opencode both call the same place
// `D:\Work\stage` -- a lowercase drive letter and a trailing separator that
// Windows ignores and string comparison does not. A dialog returns the
// canonical form, so the paths a profile carries match the ones everything
// else reports.
//
// Kept out of the component so the token protocol lives in one place rather
// than at three call sites.

/**
 * A folder, or undefined when the user cancelled.
 *
 * Errors are deliberately NOT swallowed. The bridge these dialogs use was
 * built for prompt attachments and can reject -- the file picker enforces a
 * 20MB attachment budget, for instance -- and a caught-and-ignored rejection
 * would show up as a Browse button that does nothing at all, which is the
 * worst way to report a problem. Callers surface it.
 */
export async function pickDirectory(options: { title: string; defaultPath?: string }): Promise<string | undefined> {
  const result = await window.api.openDirectoryPicker({
    multiple: false,
    title: options.title,
    defaultPath: options.defaultPath || undefined,
  })
  // The bridge is typed to allow an array because it also serves the
  // multiple-selection case, which this one never asks for.
  const path = Array.isArray(result) ? result[0] : result
  return path || undefined
}

/**
 * A file, or undefined when the user cancelled. Errors propagate, as above.
 *
 * The bridge hands back a token granting read access to what was picked, for
 * callers that want the contents. We only want the path, so the token is
 * released immediately rather than left to expire.
 */
export async function pickFile(options: {
  title: string
  defaultPath?: string
  extensions?: string[]
}): Promise<string | undefined> {
  let token: string | undefined
  try {
    const result = await window.api.openFilePicker({
      multiple: false,
      title: options.title,
      defaultPath: options.defaultPath || undefined,
      extensions: options.extensions,
    })
    if (!result) return undefined
    token = result.token
    return result.files[0]?.path || undefined
  } finally {
    if (token) await window.api.releasePickedFiles(token).catch(() => undefined)
  }
}

/**
 * The folder a dialog should open in, given whatever is in the field.
 *
 * A path to a file is not a useful starting folder, so for the platform field
 * the parent is used. An empty or partial value yields undefined, which lets
 * the dialog fall back to its own default.
 */
export function dialogStart(value: string | undefined, kind: "file" | "directory"): string | undefined {
  const trimmed = (value ?? "").trim()
  if (!trimmed) return undefined
  if (kind === "directory") return trimmed
  const cut = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"))
  return cut > 0 ? trimmed.slice(0, cut) : undefined
}
