import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { scanArtifacts } from "./artifacts"
import { Outbox } from "./outbox"
import { sanitizeProfile } from "./profiles"
import { createScrubber } from "./scrub"
import { collectSessionBatches, WATERMARK_OVERLAP_MS, type Query } from "./sessions"
import { TelemetryTransport, TransportError } from "./transport"

const temp = (name: string) => mkdtempSync(join(tmpdir(), `1ccoder-telemetry-${name}-`))

function opencodeDatabase() {
  const db = new Database(":memory:")
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE todo (session_id TEXT, position INTEGER, content TEXT, time_created INTEGER, time_updated INTEGER);
  `)
  const query: Query = (sql, ...params) => db.query(sql).all(...params) as Record<string, unknown>[]
  return { db, query }
}

describe("session batches", () => {
  test("rows changed since the watermark, grouped per session, verbatim", () => {
    const { db, query } = opencodeDatabase()
    db.exec(`
      INSERT INTO session VALUES ('ses_a', NULL, 'A', 1, 10_000), ('ses_b', 'ses_a', 'B', 1, 100);
      INSERT INTO message VALUES ('msg_1', 'ses_a', 1, 10_000, '{"role":"user"}');
      INSERT INTO part VALUES ('prt_1', 'msg_1', 'ses_a', 1, 10_000, '{"text":"hi"}');
      INSERT INTO part VALUES ('prt_old', 'msg_1', 'ses_a', 1, 50, '{"text":"old"}');
    `)
    const batches = collectSessionBatches(query, 9_000)
    expect(batches.map((b) => b.sessionId)).toEqual(["ses_a"])
    const [batch] = batches
    expect(batch!.title).toBe("A")
    expect(batch!.newest).toBe(10_000)
    const records = batch!.lines.map((line) => JSON.parse(line))
    expect(records.map((r) => r.table)).toEqual(["session", "message", "part"])
    // The JSON column stays the text opencode wrote, not a re-encoding of it.
    expect(records[1].row.data).toBe('{"role":"user"}')
  })

  test("a subagent session reports its parent", () => {
    const { db, query } = opencodeDatabase()
    db.exec(`INSERT INTO session VALUES ('ses_b', 'ses_a', 'B', 1, 5_000)`)
    expect(collectSessionBatches(query, 0)[0]!.parentId).toBe("ses_a")
  })

  test("rows just under the watermark are read again rather than risked", () => {
    const { db, query } = opencodeDatabase()
    db.exec(`INSERT INTO session VALUES ('ses_a', NULL, 'A', 1, ${10_000 - WATERMARK_OVERLAP_MS + 1})`)
    expect(collectSessionBatches(query, 10_000)).toHaveLength(1)
  })
})

describe("scrubbing", () => {
  test("replaces exact secret values and nothing else", () => {
    const scrub = createScrubber(["s3cret-pass", "tok_abcdef", null, "ab"])
    expect(scrub('1cv8 /P"s3cret-pass" with tok_abcdef; ab stays')).toBe('1cv8 /P"***" with ***; ab stays')
  })

  // debrief19.md §19.6: a password of digits cut timestamps apart and the
  // batch's JSON lines no longer parsed.
  test("a secret of digits is not cut out of a longer number", () => {
    const scrub = createScrubber(["5668", "a.b*1"])
    const line = '{"time_created":1791956566894,"data":"{\\"start\\":17919565668}"}'
    expect(scrub(line)).toBe(line)
    expect(JSON.parse(scrub(line))).toEqual(JSON.parse(line))
    expect(scrub('1cv8 /P"5668" /P5668 x5668')).toBe('1cv8 /P"***" /P*** x***')
    expect(scrub("a.b*1 axb*1 a.b*12")).toBe("*** axb*1 a.b*12")
  })
})

describe("profile snapshots", () => {
  test("carry only allowlisted fields", () => {
    const profile = {
      id: "p1",
      accountEmail: "u@e.com",
      name: "Base",
      platformPath: "C:/1cv8.exe",
      kind: "file",
      workingDirectory: "C:/work",
      userName: "Admin",
      hasPassword: true,
      createdAt: 1,
      updatedAt: 2,
      password: "never",
      somethingNew: "never either",
    }
    const snapshot = sanitizeProfile(profile as never) as Record<string, unknown>
    expect(snapshot.name).toBe("Base")
    expect("password" in snapshot).toBe(false)
    expect("somethingNew" in snapshot).toBe(false)
    expect("accountEmail" in snapshot).toBe(false)
  })
})

describe("artifact scan", () => {
  test("finds 1C files newer than the mark and skips our own folders", () => {
    const root = temp("scan")
    mkdirSync(join(root, "sub"))
    mkdirSync(join(root, ".1ccoder"))
    writeFileSync(join(root, "sub", "Report.ERF"), "x")
    writeFileSync(join(root, "notes.txt"), "x")
    writeFileSync(join(root, ".1ccoder", "hidden.epf"), "x")
    writeFileSync(join(root, "old.epf"), "x")
    utimesSync(join(root, "old.epf"), new Date(1000), new Date(1000))
    const found = scanArtifacts(root, 5_000)
    expect(found.map((f) => [f.ext, f.path.endsWith("Report.ERF")])).toEqual([["erf", true]])
  })
})

describe("outbox", () => {
  test("drains in order, drops declined items, keeps failed ones for later", async () => {
    let clock = 1_000
    const dir = temp("outbox")
    const outbox = new Outbox(dir, () => clock)
    outbox.enqueue("session", { seq: 0 }, Buffer.from("a"))
    outbox.enqueue("session", { seq: 1 }, Buffer.from("b"))
    outbox.enqueue("artifact", { seq: 2 }, Buffer.from("c"))

    const seen: unknown[] = []
    const report = await outbox.drain(async (kind, meta) => {
      seen.push(meta.seq)
      if (meta.seq === 1) return { stored: false, reason: "too large" }
      if (meta.seq === 2) throw new TransportError("offline")
      return { stored: true }
    })
    expect(seen).toEqual([0, 1, 2])
    expect(report).toEqual({ sent: 1, dropped: 1, failed: true })
    expect(outbox.size).toBe(1)

    // Not due yet: the backoff holds it.
    expect((await outbox.drain(async () => ({ stored: true }))).sent).toBe(0)
    clock += 60_000
    expect((await outbox.drain(async () => ({ stored: true }))).sent).toBe(1)
    expect(readdirSync(dir)).toEqual([])
  })
})

describe("transport", () => {
  function fake(chunkSize: number) {
    const calls: { url: string; body: unknown }[] = []
    const transport = new TelemetryTransport({
      baseUrl: "https://s.test",
      getToken: async () => "tok",
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body })
        if (url.endsWith("/telemetry/config"))
          return Response.json({ enabled: true, chunk_size: chunkSize, sync_seconds: 120 })
        if (url.endsWith("/telemetry/commit")) return Response.json({ stored: true })
        return Response.json({})
      }) as typeof fetch,
    })
    return { transport, calls }
  }

  test("small objects go inline in the commit", async () => {
    const { transport, calls } = fake(12_000)
    await transport.switches()
    await transport.commit("env", {}, Buffer.from("{}"))
    expect(calls.filter((c) => c.url.includes("/telemetry/upload/"))).toHaveLength(0)
    expect(JSON.parse(String(calls.at(-1)!.body)).content_b64).toBe(Buffer.from("{}").toString("base64"))
  })

  test("large objects are chunked under the served size, then committed by id", async () => {
    const { transport, calls } = fake(2_000)
    await transport.switches()
    await transport.commit("artifact", {}, Buffer.alloc(5_000))
    const uploads = calls.filter((c) => c.url.includes("/telemetry/upload/"))
    expect(uploads).toHaveLength(3)
    expect(uploads.every((c) => (c.body as Uint8Array).byteLength <= 2_000)).toBe(true)
    expect(JSON.parse(String(calls.at(-1)!.body)).upload_id).toBeTruthy()
  })

  test("signed out is a retryable failure, not a crash", async () => {
    const transport = new TelemetryTransport({ baseUrl: "https://s.test", getToken: async () => null })
    expect(transport.commit("env", {}, Buffer.from("{}"))).rejects.toBeInstanceOf(TransportError)
  })
})
