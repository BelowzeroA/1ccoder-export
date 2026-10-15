import { expect, test } from "bun:test"

import { creditFigures } from "./format"

const periodEnd = new Date(2026, 10, 1, 3, 0).getTime()

test("Russian figures use a decimal comma and the day.month of the period end", () => {
  const figures = creditFigures({ spent: 3.2, limit: 20, left: 16.8, periodEnd }, "ru")
  expect(figures.text).toEqual({ left: "16,8", limit: "20", spent: "3,2", until: "01.11" })
  expect(figures.exhausted).toBe(false)
})

test("an overdraft shows as zero left and counts as used up", () => {
  const figures = creditFigures({ spent: 10.04, limit: 10, left: -0.04, periodEnd }, "ru")
  expect(figures.text.left).toBe("0")
  expect(figures.exhausted).toBe(true)
})
