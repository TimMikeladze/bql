// A real three-worker node (`docs/c4-workers.md`): the listener, the sockets and the catalog on
// the main thread, the databases on three worker threads, and every surface answering the same as
// it does on a single-threaded node.
//
// The point of each case is the *boundary*: a database created on one worker, listed by the
// router; a change committed on one worker, seen by a subscriber the router holds; a transaction
// begun on one worker, rolled back by a socket closing on another thread.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { QueryResult } from "../../src/client/protocol.ts"
import { shardOf } from "../../src/server/workers/shard.ts"
import { startTestServer, stopAll, type TestServer } from "./harness.ts"

const WORKERS = 3
let server: TestServer

/** Three names that land on three different workers, so every case actually crosses a boundary. */
const NAMES: string[] = []
for (let i = 0; NAMES.length < WORKERS && i < 500; i++) {
  const name = `db${i}`
  if (!NAMES.some((one) => shardOf(one, WORKERS) === shardOf(name, WORKERS))) NAMES.push(name)
}
const [FIRST, SECOND, THIRD] = NAMES as [string, string, string]

function post<T>(route: string, body: unknown): Promise<T> {
  return server.json<T>(route, { method: "POST", body: JSON.stringify(body) })
}

function query(db: string, sql: string, args?: unknown[]): Promise<QueryResult> {
  return post<QueryResult>(`/v1/db/${db}/query`, { sql, ...(args ? { args } : {}) })
}

beforeAll(async () => {
  server = await startTestServer({ server: { workers: WORKERS } })
  for (const name of NAMES) {
    await post("/v1/db", { name })
    await query(name, "create table t(id integer primary key, v text)")
  }
})
afterAll(stopAll)

describe("the shards are real", () => {
  test("the three databases are on three different workers", () => {
    const shards = new Set(NAMES.map((name) => shardOf(name, WORKERS)))
    expect(shards.size).toBe(WORKERS)
  })

  test("the node reports how many workers it is running", () => {
    expect(server.handle.workers).toBe(WORKERS)
  })
})

describe("HTTP across the boundary", () => {
  test("a write and a read on every shard", async () => {
    for (const name of NAMES) {
      const written = await query(name, "insert into t(v) values (?)", [`hello-${name}`])
      expect(written.rowsAffected).toBe(1)
      expect(written.txid).toBeGreaterThan(0)
      const read = await query(name, "select v from t order by id")
      expect(read.rows).toEqual([[`hello-${name}`]])
    }
  })

  test("the router lists every worker's databases from the one catalog", async () => {
    const body = await server.json<{ databases: { name: string }[] }>("/v1/db")
    const listed = body.databases.map((one) => one.name)
    for (const name of NAMES) expect(listed).toContain(name)
  })

  test("a database is deleted on the worker that owns it and leaves the catalog", async () => {
    await post("/v1/db", { name: "doomed" })
    const gone = await server.fetch("/v1/db/doomed", { method: "DELETE" })
    expect(gone.status).toBe(200)
    const body = await server.json<{ databases: { name: string }[] }>("/v1/db")
    expect(body.databases.map((one) => one.name)).not.toContain("doomed")
  })

  test("a name no shard has is still a 404, not a hang", async () => {
    const response = await server.fetch(`/v1/db/nosuch/query`, {
      method: "POST",
      body: JSON.stringify({ sql: "select 1" }),
    })
    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe("DB_NOT_FOUND")
  })

  test("a database dump streams back through the router as a real SQLite file", async () => {
    const response = await server.fetch(`/v1/db/${FIRST}/dump`)
    expect(response.status).toBe(200)
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(bytes.length).toBeGreaterThan(0)
    expect(new TextDecoder().decode(bytes.slice(0, 15))).toBe("SQLite format 3")
  })

  test("metrics are every worker's counters added together", async () => {
    const body = await (await server.fetch("/metrics")).text()
    const writes = /bunql_writes_total\{[^}]*\} (\d+)/.exec(body)
    const tenants = /bunql_tenants\{[^}]*\} (\d+)/.exec(body)
    // Each shard ran its own writes; one worker's count alone could not reach the total.
    expect(Number(writes?.[1] ?? 0)).toBeGreaterThanOrEqual(NAMES.length)
    expect(Number(tenants?.[1] ?? 0)).toBeGreaterThanOrEqual(NAMES.length)
  })

  test("the generated data API answers on a worker's database", async () => {
    const rows = await server.json<unknown[]>(`/v1/db/${SECOND}/api/t`)
    expect(Array.isArray(rows)).toBe(true)
    const document = await server.json<{ openapi: string }>(`/v1/db/${SECOND}/openapi.json`)
    expect(document.openapi).toBe("3.1.0")
  })
})

describe("the change feed crosses the boundary", () => {
  test("an SSE stream on the router sees a commit made on a worker", async () => {
    const response = await server.fetch(`/v1/db/${THIRD}/changes?include=row`)
    expect(response.status).toBe(200)
    const reader = (response.body as ReadableStream<Uint8Array>).getReader() as {
      read(): Promise<{ done: boolean; value?: Uint8Array }>
      cancel(): Promise<void>
    }
    // Wait for the stream to be established before committing, or the event predates the reader.
    await Bun.sleep(150)
    await query(THIRD, "insert into t(v) values ('sse')")
    const text = await readUntil(reader, "sse", 3000)
    await reader.cancel()
    expect(text).toContain('"op":"insert"')
    expect(text).toContain("sse")
  })
})

describe("the socket relay", () => {
  test("one socket subscribes, writes and transacts across three workers", async () => {
    const socket = await open()
    try {
      await socket.send({ op: "hello", id: 1, token: server.adminKey })
      expect(await socket.wait((m) => m.event === "hello")).toBeTruthy()

      const subscribed = await socket.call({
        op: "subscribe",
        id: 2,
        db: FIRST,
        kind: "changes",
        include: "row",
      })
      expect(subscribed.ok).toBe(true)

      const live = await socket.call({
        op: "subscribe",
        id: 3,
        db: SECOND,
        kind: "live",
        sql: "select count(*) as n from t",
      })
      expect(live.ok).toBe(true)

      // A write on the *first* database, over the same socket, reaching the worker that owns it.
      const written = await socket.call({
        op: "query",
        id: 4,
        db: FIRST,
        sql: "insert into t(v) values ('over-ws')",
      })
      expect(written.ok).toBe(true)

      const change = await socket.wait((m) => m.event === "change", 3000)
      expect(JSON.stringify(change.data)).toContain("over-ws")

      // A write on the *second* database re-runs the live query on its own worker.
      await socket.call({ op: "query", id: 5, db: SECOND, sql: "insert into t(v) values ('live')" })
      const rows = await socket.wait((m) => m.event === "rows" || m.event === "diff", 3000)
      expect(rows).toBeTruthy()

      // And a transaction on the third, routed by the baton the worker minted.
      const begun = await socket.call({ op: "tx.begin", id: 6, db: THIRD })
      expect(begun.ok).toBe(true)
      const inTx = await socket.call({
        op: "query",
        id: 7,
        tx: begun.tx,
        sql: "insert into t(v) values ('in-tx')",
      })
      expect(inTx.ok).toBe(true)
      const committed = await socket.call({ op: "tx.commit", id: 8, tx: begun.tx })
      expect(committed.ok).toBe(true)

      const after = await query(THIRD, "select v from t where v = 'in-tx'")
      expect(after.rows).toEqual([["in-tx"]])
    } finally {
      socket.close()
    }
  }, 20_000)

  test("a transaction rolls back when the socket closes on the router's thread", async () => {
    const socket = await open()
    await socket.send({ op: "hello", id: 1, token: server.adminKey })
    await socket.wait((m) => m.event === "hello")
    const begun = await socket.call({ op: "tx.begin", id: 2, db: FIRST })
    expect(begun.ok).toBe(true)
    const inTx = await socket.call({
      op: "query",
      id: 3,
      tx: begun.tx,
      sql: "create table rolled(a integer)",
    })
    expect(inTx.ok).toBe(true)
    socket.close()
    await Bun.sleep(400)

    const tables = await query(FIRST, "select name from sqlite_master where name = 'rolled'")
    expect(tables.rows).toEqual([])
    // And the writer the transaction held is free again, which is the half a leaked baton breaks.
    const after = await query(FIRST, "insert into t(v) values ('after-rollback')")
    expect(after.rowsAffected).toBe(1)
  }, 20_000)

  test("a frame naming a baton this node never minted is refused, not dropped", async () => {
    const socket = await open()
    try {
      await socket.send({ op: "hello", id: 1, token: server.adminKey })
      await socket.wait((m) => m.event === "hello")
      const answer = await socket.call({ op: "tx.commit", id: 2, tx: "0".repeat(32) })
      expect(answer.ok).toBe(false)
      expect((answer.error as { code: string }).code).toBe("BAD_REQUEST")
    } finally {
      socket.close()
    }
  })
})

// ── a very small socket client ─────────────────────────────────────────────────────────────────

interface Frame {
  id?: number
  ok?: boolean
  event?: string
  [key: string]: unknown
}

async function open(): Promise<{
  send(frame: unknown): Promise<void>
  call(frame: { id: number } & Record<string, unknown>): Promise<Frame>
  wait(match: (frame: Frame) => boolean, timeoutMs?: number): Promise<Frame>
  close(): void
}> {
  const socket = new WebSocket(server.wsUrl(), "bunql.v1")
  const seen: Frame[] = []
  const waiters: { match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }[] = []
  socket.onmessage = (event) => {
    const frame = JSON.parse(String(event.data)) as Frame
    seen.push(frame)
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i] as (typeof waiters)[number]
      if (!waiter.match(frame)) continue
      waiters.splice(i, 1)
      waiter.resolve(frame)
    }
  }
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error("the socket would not open"))
  })

  const wait = (match: (frame: Frame) => boolean, timeoutMs = 5000): Promise<Frame> => {
    const already = seen.find(match)
    if (already) return Promise.resolve(already)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), timeoutMs)
      waiters.push({
        match,
        resolve: (frame) => {
          clearTimeout(timer)
          resolve(frame)
        },
      })
    })
  }

  return {
    async send(frame: unknown) {
      socket.send(JSON.stringify(frame))
    },
    async call(frame) {
      socket.send(JSON.stringify(frame))
      return wait((one) => one.id === frame.id)
    },
    wait,
    close() {
      socket.close()
    },
  }
}

async function readUntil(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
  needle: string,
  timeoutMs: number,
): Promise<string> {
  const decoder = new TextDecoder()
  let text = ""
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
    if (text.includes(needle)) return text
  }
  return text
}
