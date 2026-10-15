// The telemetry queue: objects waiting to be uploaded, kept on disk.
//
// On disk so a pilot who is offline for a day, or quits mid-upload, loses
// nothing; drained in the background so the model's requests never wait on
// it. Each item is two files: <id>.json (kind, meta, attempts, when to retry)
// and <id>.bin (the content).

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { TransportError, type CommitResult } from "./transport"

interface Item {
  kind: string
  meta: Record<string, unknown>
  attempts: number
  nextAt: number
}

/** Above this the oldest items are dropped: a queue that never drains must not fill the disk. */
export const OUTBOX_MAX_BYTES = 300 * 1024 * 1024
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000]

export class Outbox {
  private sequence = 0

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(dir, { recursive: true })
  }

  enqueue(kind: string, meta: Record<string, unknown>, content: Uint8Array) {
    // Sortable names keep the queue in order: a session's batch 3 must not
    // overtake its batch 2, or the server would keep the older rows.
    const id = `${String(this.now()).padStart(15, "0")}-${String(this.sequence++).padStart(6, "0")}`
    writeFileSync(join(this.dir, `${id}.bin`), content)
    writeFileSync(join(this.dir, `${id}.json`), JSON.stringify({ kind, meta, attempts: 0, nextAt: 0 } satisfies Item))
    this.trim()
  }

  get size(): number {
    return this.ids().length
  }

  /**
   * Uploads what is due, oldest first. A transport failure ends the round: the
   * network or the server is down, and the next item would fail the same way.
   * An item the server declines (switched off, too large, malformed) is
   * dropped, not retried.
   */
  async drain(commit: (kind: string, meta: Record<string, unknown>, content: Uint8Array) => Promise<CommitResult>) {
    const report = { sent: 0, dropped: 0, failed: false }
    for (const id of this.ids()) {
      const item = this.read(id)
      if (!item || item.nextAt > this.now()) continue
      try {
        const result = await commit(item.kind, item.meta, readFileSync(join(this.dir, `${id}.bin`)))
        this.remove(id)
        if (result.stored) report.sent++
        else report.dropped++
      } catch (error) {
        if (!(error instanceof TransportError)) throw error
        item.attempts++
        item.nextAt = this.now() + BACKOFF_MS[Math.min(item.attempts - 1, BACKOFF_MS.length - 1)]!
        writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(item))
        report.failed = true
        break
      }
    }
    return report
  }

  private ids(): string[] {
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5))
      .sort()
  }

  private read(id: string): Item | null {
    try {
      return JSON.parse(readFileSync(join(this.dir, `${id}.json`), "utf8")) as Item
    } catch {
      this.remove(id)
      return null
    }
  }

  private remove(id: string) {
    rmSync(join(this.dir, `${id}.json`), { force: true })
    rmSync(join(this.dir, `${id}.bin`), { force: true })
  }

  private trim() {
    const ids = this.ids()
    const sizes = ids.map((id) => {
      try {
        return statSync(join(this.dir, `${id}.bin`)).size
      } catch {
        return 0
      }
    })
    const total = sizes.reduce((a, b) => a + b, 0)
    if (total <= OUTBOX_MAX_BYTES) return
    // Oldest first, until what is left fits.
    sizes.reduce((left, size, index) => {
      if (left <= OUTBOX_MAX_BYTES) return left
      this.remove(ids[index]!)
      return left - size
    }, total)
  }
}
