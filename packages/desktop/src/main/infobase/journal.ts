// A record of every write to the base, kept by the plugin rather than by the
// agent's memory.
//
// 2026-09-25, failures_to_tools.md T4 (debrief7.md §6.9, debrief10 "still
// open"). The closing summary is where executed side effects go missing: one
// run reduced a write across every organisation's documents to one clause
// framed as a feature, while disclosing a hypothetical side effect in the same
// message -- it did not recognise its own finished write as a side effect. The
// handover contract asks for «Как откатить», and it was absent exactly when it
// mattered. An honest summary then depends on the model remembering; a
// journal the plugin writes on every approved write makes the list a tool
// result instead, which is the form of fact the agent does act on.
//
// Two lines per write: one when the approved code is sent, one when its result
// comes back. A toolkit that dies mid-write (debrief9.md §9.9e) leaves only the
// first, and the journal then says the outcome is unknown -- which is the true
// state, and the one the agent previously had to discover by counting.
//
// Written into the profile's working directory, beside the rest of the task's
// artefacts, so the user can read it too and it outlives the sidecar.

export interface WriteStarted {
  readonly kind: "started"
  readonly callID: string
  readonly sessionID: string
  readonly at: string
  readonly summary: string
  readonly objects: string
  readonly count: number
  readonly organisations: string
  /** Existing elements the user allowed to be changed, by name. */
  readonly overwrites?: readonly string[]
}

export interface WriteFinished {
  readonly kind: "finished"
  readonly callID: string
  readonly at: string
  readonly failed: boolean
  /** The start of what the code returned -- usually what it created or changed. */
  readonly result: string
}

export type JournalLine = WriteStarted | WriteFinished

export const JOURNAL_DIR = ".1ccoder"
export const JOURNAL_FILE = "writes.jsonl"

export function journalDirectory(workingDirectory: string): string {
  return `${workingDirectory.replace(/[\\/]+$/, "")}/${JOURNAL_DIR}`
}

export function journalPath(workingDirectory: string): string {
  return `${journalDirectory(workingDirectory)}/${JOURNAL_FILE}`
}

export function journalLine(line: JournalLine): string {
  return `${JSON.stringify(line)}\n`
}

export interface JournalEntry extends WriteStarted {
  readonly outcome: "done" | "failed" | "unknown"
  readonly result?: string
}

/** The session's writes, each joined with its outcome. Malformed lines are skipped. */
export function readJournal(text: string, sessionID: string): readonly JournalEntry[] {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as JournalLine
      } catch {
        return null
      }
    })
    .filter((line): line is JournalLine => line !== null && typeof line.callID === "string")
  const finished = new Map(
    lines.filter((line): line is WriteFinished => line.kind === "finished").map((line) => [line.callID, line]),
  )
  return lines
    .filter((line): line is WriteStarted => line.kind === "started" && line.sessionID === sessionID)
    .map((started) => {
      const end = finished.get(started.callID)
      return {
        ...started,
        outcome: !end ? "unknown" : end.failed ? "failed" : "done",
        ...(end?.result ? { result: end.result } : {}),
      }
    })
}

export function describeJournal(entries: readonly JournalEntry[], path: string): string {
  if (!entries.length) return `В этом сеансе записей в базу не было (журнал: ${path}).`
  const outcome = {
    done: "выполнено",
    failed: "НЕ ВЫПОЛНЕНО — код вернул ошибку",
    unknown: "ИСХОД НЕИЗВЕСТЕН — ответа не было (тулкит упал или связь оборвалась); проверь запросом, что записано",
  } as const
  return [
    `Записи в базу за этот сеанс — ${entries.length} (журнал: ${path}):`,
    "",
    ...entries.flatMap((entry, index) => [
      `${index + 1}. ${entry.at} — ${outcome[entry.outcome]}`,
      `   Что: ${entry.summary}`,
      `   Объекты: ${entry.objects}; объектов: ${entry.count}; организации: ${entry.organisations}`,
      ...(entry.overwrites?.length ? [`   Изменены существующие элементы: ${entry.overwrites.join(", ")}`] : []),
      ...(entry.result ? [`   Ответ: ${entry.result.replace(/\s+/g, " ").slice(0, 400)}`] : []),
    ]),
    "",
    "Каждая выполненная запись — пункт «Что сделано» в итоговом отчёте, с объёмом и организациями.",
    "Для «Как откатить» по каждой: что создано — пометить на удаление и вернуть ссылки, которые на",
    "него переключены; что изменено — прежние значения (если ты их не сохранил до записи, так и напиши).",
  ].join("\n")
}
