// Session rows changed since the last sync, grouped into one batch per session.
//
// The rows go up exactly as opencode stores them -- column names, JSON columns
// as the text it wrote -- because the server's pull-session rebuilds a database
// in opencode's own layout from them, and the debrief method then runs on a
// pilot's session as it does on a local one (next_steps.md 3d). Translating
// them into a format of our own would break that the first time upstream adds
// a column.

/** Runs one read-only query. A function, so tests can back it with bun:sqlite. */
export type Query = (sql: string, ...params: (string | number)[]) => Record<string, unknown>[]

export interface SessionBatch {
  readonly sessionId: string
  readonly parentId: string | null
  readonly title: string | null
  /** JSONL lines: {"table": ..., "row": {...}}. */
  readonly lines: string[]
  /** Newest time_updated among the rows, the next watermark candidate. */
  readonly newest: number
}

const TABLES = ["session", "message", "part", "todo"] as const

/**
 * Rows a sync picks up again from before the watermark. Two writes in the same
 * millisecond, one before and one after a sync read, would otherwise split
 * across the boundary and the second be lost; the server keeps the last copy of
 * a row by its key, so sending one twice costs bytes, not correctness.
 */
export const WATERMARK_OVERLAP_MS = 2_000

export function collectSessionBatches(query: Query, since: number): SessionBatch[] {
  const from = Math.max(0, since - WATERMARK_OVERLAP_MS)
  const bySession = new Map<string, { lines: string[]; newest: number }>()
  for (const table of TABLES) {
    const column = table === "session" ? "id" : "session_id"
    for (const row of query(`SELECT * FROM "${table}" WHERE time_updated >= ?`, from)) {
      const sessionId = String(row[column] ?? "")
      if (!sessionId) continue
      const entry = bySession.get(sessionId) ?? { lines: [], newest: 0 }
      entry.lines.push(JSON.stringify({ table, row }))
      entry.newest = Math.max(entry.newest, Number(row.time_updated ?? 0))
      bySession.set(sessionId, entry)
    }
  }
  return [...bySession].map(([sessionId, entry]) => {
    const session = query(`SELECT parent_id, title FROM "session" WHERE id = ?`, sessionId)[0]
    return {
      sessionId,
      parentId: typeof session?.parent_id === "string" ? session.parent_id : null,
      title: typeof session?.title === "string" ? session.title : null,
      lines: entry.lines,
      newest: entry.newest,
    }
  })
}
