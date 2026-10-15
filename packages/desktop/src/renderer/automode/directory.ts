// Pure helpers for resolving and naming the active project directory.
//
// Kept in their own module rather than in AutoModeControl.tsx so they can be
// unit-tested: importing the component pulls in @opencode-ai/app, which loads
// Vite worker assets that a plain `bun test` process cannot resolve.

/** URL-safe base64, matching @opencode-ai/core/util/encode's base64Encode. */
export function decodeDirectory(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"))
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
  } catch {
    return undefined
  }
}

/** The trailing path segment, which is what a person calls the project. */
export function projectName(directory: string): string {
  const parts = directory.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? directory
}
