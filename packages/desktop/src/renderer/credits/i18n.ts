// 1CCoder strings for the credits note. Fork-local for the same reasons as
// ../auth/i18n.ts, and with the same parity check: `ru` is typed against `en`.

import { interpolate } from "../auth/i18n"

const en = {
  "credits.note": "Credits: {{left}} of {{limit}} · until {{until}}",
  "credits.noteTitle": "{{left}} of {{limit}} credits left this period, {{spent}} spent. New credits arrive {{until}}.",
  "credits.exhausted": "Credits used up · new ones {{until}}",
  "credits.exhaustedTitle": "This period's credits are used up. New credits arrive {{until}}; for more sooner, write to {{support}}.",
  "credits.blocked": "Access suspended",
  "credits.blockedTitle": "1CCoder access for this account is suspended. If this is a mistake, write to {{support}}.",
}

const ru: Record<keyof typeof en, string> = {
  "credits.note": "Кредиты: {{left}} из {{limit}} · до {{until}}",
  "credits.noteTitle": "Осталось {{left}} из {{limit}} кредитов этого периода, потрачено {{spent}}. Новые поступят {{until}}.",
  "credits.exhausted": "Кредиты закончились · новые {{until}}",
  "credits.exhaustedTitle": "Кредиты этого периода закончились. Новые поступят {{until}}; чтобы получить раньше, напишите в {{support}}.",
  "credits.blocked": "Доступ приостановлен",
  "credits.blockedTitle": "Доступ к 1CCoder для этой учётной записи приостановлен. Если это ошибка, напишите в {{support}}.",
}

export type CreditsStringKey = keyof typeof en

/** Russian unless "en" is asked for explicitly, as in ../auth/i18n.ts. */
export function createCreditsTranslator(locale: string | undefined) {
  const dict = locale === "en" ? en : ru
  return (key: CreditsStringKey, params?: Record<string, string | number>) => interpolate(dict[key], params)
}
