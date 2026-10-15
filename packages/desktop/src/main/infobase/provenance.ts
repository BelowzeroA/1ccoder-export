// Which .epf files the launcher may start without a second look.
//
// 2026-09-25, failures_to_tools.md G4 (debrief4.md §2, debrief5.md §4.2).
// `checkPath` refuses a path that does not exist, and that neutralised most of
// the historical wrong-tool calls. It cannot refuse the most damaging one: a
// REAL processing from the working directory, one the agent had listed and
// dismissed as unrelated hours before, launched when it meant to run a query.
// That processing opened its own form modally over the base.
//
// The launcher's legitimate use is narrow -- run the processing you just built
// -- and "just built" is checkable: the file changed during this session. A
// file that did not is either the wrong-tool emission or a processing the user
// handed over, and those two are told apart by the only party who knows, via
// `user_supplied`, which travels into the permission prompt the user reads.

export interface EpfProvenance {
  /** When the file was last written, or null when that cannot be read. */
  readonly modifiedMs: number | null
  /** When this sidecar first saw the session. */
  readonly sessionStartedMs: number
  /** The caller said the user named this file. */
  readonly userSupplied: boolean
}

/**
 * Slack for clocks and for a sidecar that noticed the session a moment after
 * the build began. Short on purpose: the case being guarded is a file that is
 * hours old, not seconds.
 */
const SLACK_MS = 2 * 60 * 1000

/** A reason to refuse, or null when the launch may go to the permission prompt. */
export function provenanceRefusal(path: string, facts: EpfProvenance): string | null {
  if (facts.userSupplied) return null
  if (facts.modifiedMs !== null && facts.modifiedMs >= facts.sessionStartedMs - SLACK_MS) return null
  return [
    `Отклонено: ${path} не менялся в этом сеансе — ты его не собирал.`,
    "",
    "Этот инструмент запускает обработку, которую ты только что собрал. Чужая обработка может",
    "открыть свою форму модально и заблокировать сеанс 1С вместе с MCP Toolkit.",
    "",
    "- Хотел выполнить запрос или код — это 1c_execute_query / 1c_execute_code, а не запуск файла.",
    "- Пользователь сам назвал этот файл и просил его запустить — повтори вызов с",
    "  `user_supplied: true`; пользователь увидит это в запросе разрешения.",
  ].join("\n")
}
