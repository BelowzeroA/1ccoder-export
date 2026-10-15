// Pure formatting for the credits note, apart from the component so it can be
// tested without the UI library.

export function creditFigures(
  balance: { spent: number; limit: number; left: number; periodEnd: number },
  locale: string | undefined,
) {
  const tag = locale === "en" ? "en-GB" : "ru-RU"
  const number = new Intl.NumberFormat(tag, { maximumFractionDigits: 2, minimumFractionDigits: 0 })
  const end = new Date(balance.periodEnd)
  const text: Record<"left" | "limit" | "spent" | "until", string> = {
    // Never below zero on screen: the last request of a period may overdraft
    // by one step, and "-0,04 of 10" reads as a fault rather than "used up".
    left: number.format(Math.max(0, balance.left)),
    limit: number.format(balance.limit),
    spent: number.format(balance.spent),
    until: `${String(end.getDate()).padStart(2, "0")}.${String(end.getMonth() + 1).padStart(2, "0")}`,
  }
  return { text, exhausted: balance.left <= 0 }
}
