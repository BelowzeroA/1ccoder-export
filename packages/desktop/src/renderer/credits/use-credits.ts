// The account's balance as a signal, shared by every surface that shows it.
//
// One subscription for the whole renderer: the main process pushes the balance
// after each model request settles (llm/relay.ts scheduleBalanceRefresh), and
// the first reader asks for the current figure so the note is not empty until
// the first request of the day.

import { createSignal } from "solid-js"

import type { CreditBalance } from "../../preload/1ccoder-credits"

const [balance, setBalance] = createSignal<CreditBalance | null>(null)
let started = false

export function useCredits() {
  if (!started && window.api?.credits) {
    started = true
    window.api.credits.subscribe(setBalance)
    void window.api.credits
      .get()
      .then((current) => {
        if (current && !balance()) setBalance(current)
      })
      .catch(() => undefined)
  }
  return balance
}
