// Exact-secret scrubbing for everything telemetry uploads.
//
// Not redaction of the data: the decision is a full upload (next_steps.md,
// 2026-09-30). This removes only the values that are ours to protect and that
// a tool's output can echo verbatim -- an infobase password inside a /P
// argument, the proxy token, the account credential. Each is replaced where it
// appears, exactly, and nothing else is touched.

/** Shorter values would match ordinary text and gut the data for nothing. */
export const MIN_SECRET_LENGTH = 4

export function createScrubber(secrets: readonly (string | null | undefined)[]) {
  const values = [...new Set(secrets.filter((s): s is string => typeof s === "string" && s.length >= MIN_SECRET_LENGTH))]
    // Longest first, so a secret containing another is replaced whole.
    .sort((a, b) => b.length - a.length)
  const patterns = values.map((secret) => new RegExp(digitGuarded(secret), "g"))
  return (text: string) => patterns.reduce((out, pattern) => out.replace(pattern, "***"), text)
}

// debrief19.md §19.6: a password of digits matched the middle of timestamps
// (`1791956***94`), which broke the JSON lines it was in. A secret that starts
// or ends with a digit is not replaced where it continues a longer number: that
// number is not the secret, and cutting it corrupts what is uploaded.
function digitGuarded(secret: string) {
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return (/^\d/.test(secret) ? "(?<!\\d)" : "") + escaped + (/\d$/.test(secret) ? "(?!\\d)" : "")
}
