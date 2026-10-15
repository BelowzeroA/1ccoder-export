// The account's credits, in the composer's row beside the session's profile.
//
// Text, not a control: there is nothing to do about a balance from here. The
// tooltip carries the long form, and when the period's credits are used up or
// the account is blocked the note says so and names the support contact, so the
// refusal the next request will meet is not a surprise.

import { Show } from "solid-js"

import { SUPPORT_CONTACT } from "../../main/llm/support"
import { creditFigures } from "./format"
import { createCreditsTranslator } from "./i18n"
import { useCredits } from "./use-credits"

export function CreditsNote(props: { locale: string | undefined; class?: string }) {
  const t = createCreditsTranslator(props.locale)
  const balance = useCredits()

  return (
    <Show when={balance()} keyed>
      {(current) => {
        const figures = creditFigures(current, props.locale)
        // A block outranks the figures: they are not what stops the next request.
        const title = current.blocked
          ? t("credits.blockedTitle", { support: SUPPORT_CONTACT })
          : figures.exhausted
            ? t("credits.exhaustedTitle", { until: figures.text.until, support: SUPPORT_CONTACT })
            : t("credits.noteTitle", figures.text)
        const text = current.blocked
          ? t("credits.blocked")
          : figures.exhausted
            ? t("credits.exhausted", { until: figures.text.until })
            : t("credits.note", figures.text)
        const critical = current.blocked || figures.exhausted
        return (
          <span
            data-1ccoder-credits-note
            title={title}
            classList={{
              "whitespace-nowrap": true,
              "text-v2-text-text-faint": !critical,
              "text-text-critical-base": critical,
              [props.class ?? ""]: Boolean(props.class),
            }}
          >
            {text}
          </span>
        )
      }}
    </Show>
  )
}
