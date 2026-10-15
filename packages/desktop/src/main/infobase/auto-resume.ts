// Resuming a turn that ended in an error nobody has to decide about.
//
// 2026-09-26, debrief14.md §14.4. A model stream broke mid-answer; the error
// ended the turn, and the session sat idle until the user typed «продолжай» --
// a nudge, not a decision. The agent is meant to work on its own when no human
// decision is needed, so the nudge comes from here. Layer 1 (opencode's retry
// recognising 1ccoder_transient) handles most of these inside the step; this
// is for what is left once that gives up.
//
// It never resumes where a person is needed: the user stopped the turn, a
// permission was refused, the agent asked something, or the error is about
// access, money or quota. And it stops after a small budget, saying so.

import { ACCOUNT_BLOCKED, RETRIES_STOPPED } from "../llm/support"

/** The error as `session.error` carries it. */
export interface SessionErrorLike {
  readonly name?: string
  readonly data?: { readonly message?: unknown; readonly statusCode?: unknown }
  /** Not an error: the turn ended on this announcement of a next step (`announcedStep`). */
  readonly announced?: string
}

export type ResumeVerdict = { readonly resume: true } | { readonly resume: false; readonly reason: string }

// Access, money and quota need a person; so does a refusal the user gave.
const HUMAN_NEEDED =
  /not signed in|not authori[sz]ed|unauthori[sz]ed|forbidden|\b40[13]\b|billing|payment|quota|insufficient|balance|credit|subscription|usage limit|rejected|отклон/i

export function classifyError(error: SessionErrorLike | undefined): ResumeVerdict {
  if (!error) return { resume: false, reason: "нет сведений об ошибке" }
  if (error.name === "MessageAbortedError") return { resume: false, reason: "ход остановлен пользователем" }
  if (error.name === "ProviderAuthError") return { resume: false, reason: "нужен вход или ключ доступа к модели" }
  const message = typeof error.data?.message === "string" ? error.data.message : ""
  // The relay stopped retrying an answer that kept breaking on the way
  // (relay.ts, TRANSIENT_FAILURE_LIMIT); resuming would restart what it stopped.
  if (message.includes(RETRIES_STOPPED)) return { resume: false, reason: "повторы остановлены: связь с сервером 1CCoder нестабильна" }
  // In Russian, so HUMAN_NEEDED would not catch it; only the operator lifts a block.
  if (message.includes(ACCOUNT_BLOCKED)) return { resume: false, reason: "доступ к 1CCoder приостановлен" }
  if (HUMAN_NEEDED.test(message)) return { resume: false, reason: `ошибка требует человека: ${message.slice(0, 160)}` }
  return { resume: true }
}

/** The minimal message shape of `client.session.messages`. */
export interface MessageLike {
  readonly info: {
    readonly role: string
    readonly time?: { readonly created?: number }
    readonly error?: unknown
    readonly finish?: string
  }
  readonly parts: readonly unknown[]
}

/**
 * Whether the turn ended on an empty answer in the middle of work.
 *
 * 2026-09-27, debrief14.md §14.5 (layer 3). After two tool calls the model
 * returned nothing: no text, no reasoning, no tool call, `finish: stop`, and no
 * error. The session went idle mid-diagnosis and stayed so for eight hours until
 * the user typed «продолжай». A deliberate finish says something; an empty
 * answer after tool calls, in the same turn, is never one.
 */
export function endedEmpty(messages: readonly MessageLike[]): boolean {
  const last = messages.at(-1)
  if (!last || last.info.role !== "assistant" || last.info.error) return false
  const parts = last.parts as readonly { type?: string; text?: string }[]
  // Reasoning is not shown to the user, so it doesn't count as saying something.
  const said = parts.some((part) => part.type === "tool" || (part.type === "text" && !!part.text?.trim()))
  if (said) return false
  // Mid-work: this turn already called tools.
  return midWork(messages)
}

/** Whether this turn (since the last user message) called tools before its last message. */
function midWork(messages: readonly MessageLike[]): boolean {
  const turnStart = messages.findLastIndex((message) => message.info.role === "user")
  return messages
    .slice(turnStart + 1, -1)
    .some((message) => (message.parts as readonly { type?: string }[]).some((part) => part.type === "tool"))
}

// First-person verbs of a next step: what an agent says just before the call.
const NEXT_STEP =
  /(?<!\p{L})(проверю|сделаю|посмотрю|запущу|выполню|напечатаю|прочитаю|исправлю|поправлю|соберу|пересоберу|загружу|выгружу|добавлю|перейду|попробую|начну|займусь|сравню|открою|вызову|запишу|сохраню|создам|обновлю|удалю|найду|выясню|уточню)(?!\p{L})/iu

/**
 * The announcement a turn ended on, if it ended on one: text that says what
 * comes next, and no call.
 *
 * 2026-09-29, debrief15.md §15.22. Mid-work, the last message was «Быстрая
 * проверка без пересборки — прочитаю XML макета через СериализаторXDTO и
 * напечатаю:», with `finish: stop` and no tool call. Neither a finish nor a
 * question, and not empty, so `endedEmpty` let it be; the session sat idle
 * until the user asked whether it was stuck. A session stops only when the
 * task is done or the user has to decide.
 */
export function announcedStep(messages: readonly MessageLike[]): string | null {
  const last = messages.at(-1)
  if (!last || last.info.role !== "assistant" || last.info.error || last.info.finish !== "stop") return null
  const parts = last.parts as readonly { type?: string; text?: string }[]
  if (parts.some((part) => part.type === "tool")) return null
  const text = parts.findLast((part) => part.type === "text" && !!part.text?.trim())?.text?.trim() ?? ""
  if (!text || text.endsWith("?") || !midWork(messages)) return null
  // The last sentence: a report or a question earlier in the text doesn't make it a finish.
  const tail = text.split(/(?<=[.!?…])\s+|\n+/).at(-1)?.trim() ?? ""
  if (tail.endsWith(":")) return tail
  // «Сейчас напечатаю.» announces; «Если нужно, поправлю отступы.» offers, and is a finish.
  const now = /^(сейчас|теперь|далее|дальше|затем|следующим шагом)(?!\p{L})/iu.test(tail)
  if (NEXT_STEP.test(tail) && !/(?<!\p{L})если(?!\p{L})/iu.test(tail) && (now || !/[.!]$/.test(tail))) return tail
  return null
}

/** What the resume message names as the reason, for a turn that ended empty. */
export const EMPTY_ANSWER: SessionErrorLike = {
  data: { message: "модель вернула пустой ответ посреди работы, без текста и без вызова инструмента" },
}

/**
 * Whether the latest assistant turn waits on the user: a `question` tool call
 * that never completed, or text that ends by asking.
 */
export function awaitsHuman(messages: readonly MessageLike[]): boolean {
  const last = messages.findLast((message) => message.info.role === "assistant")
  if (!last) return false
  const parts = last.parts as readonly { type?: string; tool?: string; text?: string; state?: { status?: string } }[]
  if (parts.some((part) => part.type === "tool" && part.tool === "question" && part.state?.status !== "completed")) {
    return true
  }
  const text = parts.findLast((part) => part.type === "text" && typeof part.text === "string")?.text?.trim() ?? ""
  return text.endsWith("?")
}

/** Whether someone has spoken since the turn that failed -- then it is theirs to steer. */
export function userSpokeAfterFailure(messages: readonly MessageLike[]): boolean {
  return messages.at(-1)?.info.role === "user"
}

/** Resumes per session within the window, and the pause before each. */
export const RESUME_LIMIT = 3
export const RESUME_WINDOW_MS = 60 * 60 * 1000
export const RESUME_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const

export class ResumeBudget {
  private readonly used = new Map<string, number[]>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly delays: readonly number[] = RESUME_DELAYS_MS,
  ) {}

  /** The pause before the next resume, or null when the budget is spent. */
  next(sessionID: string): { readonly attempt: number; readonly delayMs: number } | null {
    const recent = (this.used.get(sessionID) ?? []).filter((at) => this.now() - at < RESUME_WINDOW_MS)
    this.used.set(sessionID, recent)
    if (recent.length >= RESUME_LIMIT) return null
    return { attempt: recent.length + 1, delayMs: this.delays[recent.length] ?? this.delays.at(-1) ?? 0 }
  }

  record(sessionID: string): void {
    this.used.set(sessionID, [...(this.used.get(sessionID) ?? []), this.now()])
  }
}

export function resumeText(attempt: number, error: SessionErrorLike): string {
  if (error.announced !== undefined) {
    return [
      `[1CCoder, автоматически — попытка ${attempt} из ${RESUME_LIMIT}] Ход закончился объявлением следующего шага без вызова: «${error.announced.slice(0, 200)}».`,
      "Сделай этот шаг сейчас — вызовом инструмента, не пересказом. Ход заканчивается, только когда задача",
      "выполнена (итоговый отчёт) или нужно решение пользователя (вопрос).",
    ].join("\n")
  }
  const message = typeof error.data?.message === "string" ? error.data.message.slice(0, 200) : "без описания"
  return [
    `[1CCoder, автоматически — попытка ${attempt} из ${RESUME_LIMIT}] Ход прервался из-за ошибки, не требующей решения пользователя: ${message}.`,
    "Продолжай с того места, где остановился: сверься со своим списком задач и последними результатами,",
    "не повторяй уже сделанное. Если для продолжения нужно решение пользователя — спроси и остановись.",
  ].join("\n")
}

export function exhaustedText(error: SessionErrorLike): string {
  const message = typeof error.data?.message === "string" ? error.data.message.slice(0, 200) : "без описания"
  return (
    `[1CCoder] Автоматически продолжить не удалось: ${RESUME_LIMIT} попытки за час закончились той же ошибкой ` +
    `(${message}). Работа остановлена; продолжу по вашей команде.`
  )
}
