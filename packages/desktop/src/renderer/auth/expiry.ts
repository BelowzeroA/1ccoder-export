// Kept apart from AccountMenu.tsx so tests can import it without pulling in
// the UI library, which touches the DOM at module load.

const DAY_MS = 24 * 60 * 60 * 1000

/** Whole days remaining, rounded up: "ends in 1 d." should hold until it ends. */
export function daysRemaining(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / DAY_MS))
}
