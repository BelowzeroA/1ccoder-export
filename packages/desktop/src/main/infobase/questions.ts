// An unanswered question is not an answer.
//
// 2026-09-25, failures_to_tools.md T8 (debrief4.md §4). A confirmation was
// asked with three options that differed in reversibility; the call was
// interrupted and never returned an answer. Hours later the user typed one
// word -- «продолжай» -- and the agent treated it as approval of the option
// marked recommended, which was the destructive one. The prompt now says not
// to do that; this makes the fact visible in the conversation itself, at the
// moment it matters, so the rule has evidence to fire on.

/** The minimal shape of the messages the transform hook hands over. */
export interface TransformMessage {
  readonly info: { readonly id: string; readonly sessionID: string; readonly role: string }
  readonly parts: unknown[]
}

interface ToolPartLike {
  readonly type: "tool"
  readonly tool: string
  readonly state: { readonly status: string; readonly input?: unknown }
}

function isQuestionPart(part: unknown): part is ToolPartLike {
  if (!part || typeof part !== "object") return false
  const candidate = part as { type?: unknown; tool?: unknown; state?: unknown }
  return candidate.type === "tool" && candidate.tool === "question" && typeof candidate.state === "object" && candidate.state !== null
}

export const UNANSWERED_NOTICE = [
  "Предыдущий вопрос пользователю (инструмент question) остался БЕЗ ОТВЕТА: вызов прерван или отклонён.",
  "Сообщение пользователя ниже — не выбор варианта. Если от ответа зависело, что делать дальше, и",
  "варианты различались по обратимости, не выбирай за пользователя: задай вопрос снова.",
].join("\n")

/**
 * Adds the notice to the latest user message when the last question before it
 * never completed. Mutates the list it is given, as the hook expects, and only
 * the copy the model sees: nothing is stored.
 */
export function markUnansweredQuestion(messages: TransformMessage[]): boolean {
  const lastUser = messages.findLastIndex((message) => message.info.role === "user")
  if (lastUser <= 0) return false
  // Only the turn the user is replying to. A question left unanswered further
  // back has already been replied to by some later message, one way or another.
  const previousUser = messages.slice(0, lastUser).findLastIndex((message) => message.info.role === "user")
  const question = messages
    .slice(previousUser + 1, lastUser)
    .flatMap((message) => message.parts)
    .findLast(isQuestionPart)
  if (!question || question.state.status === "completed") return false

  const target = messages[lastUser]!
  target.parts.push({
    id: `prt_1ccoder_unanswered_${target.info.id}`,
    sessionID: target.info.sessionID,
    messageID: target.info.id,
    type: "text",
    text: UNANSWERED_NOTICE,
    synthetic: true,
  })
  return true
}
