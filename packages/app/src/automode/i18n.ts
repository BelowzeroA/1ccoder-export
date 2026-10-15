// Fork-local copy for the always-ask explanation shown in the permission dock.
//
// Kept out of src/i18n/* deliberately: parity.test.ts requires every English
// key there to exist in all 61 locales, and 1CCoder ships Russian-first and
// needs only ru + en. Parity is enforced at compile time instead, because `ru`
// is typed as Record<keyof typeof en, string>.
//
// The desktop package has its own equivalent (renderer/automode/i18n.ts) for
// the mode indicator and the first-run offer; this one exists separately
// because the dock lives in this package and cannot import from desktop.

import type { AlwaysAskReason } from "./policy"

export const en: Record<AlwaysAskReason, string> = {
  destructive_shell: "AutoMode does not answer this one: the command deletes data.",
  git_history: "AutoMode does not answer this one: the operation reaches the shared repository.",
  infobase_write: "AutoMode does not answer this one: the operation writes to the 1C infobase.",
}

export const ru: Record<AlwaysAskReason, string> = {
  destructive_shell: "Автоматический режим это не подтверждает: команда удаляет данные.",
  git_history: "Автоматический режим это не подтверждает: операция затрагивает общий репозиторий.",
  infobase_write: "Автоматический режим это не подтверждает: операция изменяет данные в базе 1С.",
}

/** Russian is the product default (Phase 1); only an explicit "en" opts out. */
export function alwaysAskExplanation(reason: AlwaysAskReason, locale: string | undefined): string {
  return locale === "en" ? en[reason] : ru[reason]
}

/** The two permission modes, as the composer's switcher shows them. */
export const modeEn = { auto: "AutoMode", manual: "Manual mode", title: "Mode" }
export const modeRu: Record<keyof typeof modeEn, string> = {
  auto: "Автоматический режим",
  manual: "Ручной режим",
  title: "Режим",
}

export function modeLabels(locale: string | undefined): Record<keyof typeof modeEn, string> {
  return locale === "en" ? { ...modeEn } : modeRu
}
