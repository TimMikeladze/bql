// Read sessions on `/v1` (`docs/p8-read-sessions.md`). The thing worth testing is not that a
// session serves a statement but that it is a *point* rather than a floor: a write committed
// between one request and another is invisible inside it and visible outside it, at the same
// instant. Everything else here is the bound that keeps that from being a resource leak, and the
// caller the surface exists for.
//
// The mechanism is R10's, unchanged — `test/hrana/forward.test.ts` covers it on a leased reader
// and against a replica. What is new is the route layer, so these drive it over HTTP.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { ErrorBody, QueryResult } from "../../src/client/protocol.ts"
import { createDb, startTestServer, stopAll, type TestServer } from "./harness.ts"

interface ReadBeginResult {
  read: string
  expiresInMs: number
  idleTimeoutMs: number
}

let server: TestServer

beforeAll(async () => {
  // Long leashes: every test here holds a session across several round trips on purpose, and the
  // one test that wants an expiry starts its own server with a short one.
  server = await startTestServer({
    limits: { txIdleTimeoutMs: 10_000, readTxTimeoutMs: 20_000 },
  })
  await createDb(server, "acme", "create table t(id integer primary key, v text, ord integer)")
})
afterAll(stopAll)

async function begin(db = "acme", token?: string | null): Promise<ReadBeginResult> {
  const response = await server.fetch(`/v1/db/${db}/read`, {
    method: "POST",
    body: JSON.stringify({}),
    ...(token !== undefined ? { token } : {}),
  })
  if (response.status !== 200) throw new Error(`begin: ${response.status} ${await response.text()}`)
  return (await response.json()) as ReadBeginResult
}

function inSession(
  read: string,
  sql: string,
  args?: unknown[],
  db = "acme",
): Promise<Response> {
  return server.fetch(`/v1/db/${db}/read/${read}`, {
    method: "POST",
    body: JSON.stringify({ sql, ...(args ? { args } : {}) }),
  })
}

async function readOne(read: string, sql: string, args?: unknown[]): Promise<number> {
  const response = await inSession(read, sql, args)
  if (response.status !== 200) throw new Error(`${sql}: ${response.status} ${await response.text()}`)
  const result = (await response.json()) as QueryResult
  return Number((result.rows[0] as unknown[])[0])
}

function end(read: string, db = "acme"): Promise<Response> {
  return server.fetch(`/v1/db/${db}/read/${read}`, { method: "DELETE" })
}

async function write(sql: string, args?: unknown[]): Promise<void> {
  const response = await server.fetch("/v1/db/acme/query", {
    method: "POST",
    body: JSON.stringify({ sql, ...(args ? { args } : {}) }),
  })
  if (response.status !== 200) throw new Error(`${sql}: ${response.status} ${await response.text()}`)
}

async function countOutside(): Promise<number> {
  const result = await server.json<QueryResult>("/v1/db/acme/query", {
    method: "POST",
    body: JSON.stringify({ sql: "select count(*) from t" }),
  })
  return Number((result.rows[0] as unknown[])[0])
}

describe("a read session is a point, not a floor", () => {
  test("a write committed between request one and request three is invisible inside and visible outside", async () => {
    await write("delete from t")
    await write("insert into t(id, v, ord) values (1, 'a', 1)")
    const { read } = await begin()
    try {
      // Request one: the session takes its snapshot here, at `BEGIN DEFERRED`'s first read.
      expect(await readOne(read, "select count(*) from t")).toBe(1)

      // Request two, from outside: a write that commits while the session is open. It is not
      // refused and does not wait, which is the behaviour a writer transaction would not have.
      await write("insert into t(id, v, ord) values (2, 'b', 2)")

      // Request three: the same session, a later HTTP request, the same database as of request
      // one. Both halves of the claim, at the same instant.
      expect(await readOne(read, "select count(*) from t")).toBe(1)
      expect(await countOutside()).toBe(2)

      // And the row itself, not only the count — a `select` for the new id finds nothing inside.
      expect(await readOne(read, "select count(*) from t where id = 2")).toBe(0)
    } finally {
      await end(read)
    }
    // Once the session is over the same client sees the write it was hiding from itself.
    expect(await countOutside()).toBe(2)
  })

  test("two sessions opened either side of a write disagree, and each is internally consistent", async () => {
    await write("delete from t")
    await write("insert into t(id, v, ord) values (1, 'a', 1)")
    const early = await begin()
    expect(await readOne(early.read, "select count(*) from t")).toBe(1)
    await write("insert into t(id, v, ord) values (2, 'b', 2)")
    const late = await begin()
    try {
      expect(await readOne(late.read, "select count(*) from t")).toBe(2)
      // `BQL-Min-Txid` could not tell these apart: both satisfy any floor the earlier one does.
      expect(await readOne(early.read, "select count(*) from t")).toBe(1)
    } finally {
      await end(early.read)
      await end(late.read)
    }
  })

  test("the begin answer carries both leashes, and ending it is idempotent only once", async () => {
    const session = await begin()
    expect(session.read).toMatch(/^[0-9a-f]{32}$/)
    expect(session.expiresInMs).toBe(20_000)
    expect(session.idleTimeoutMs).toBe(10_000)
    const ended = await end(session.read)
    expect(ended.status).toBe(200)
    expect(await ended.json()).toEqual({ read: session.read, ended: true })
    // The baton is gone, and says the same thing a baton that never existed says.
    const again = await end(session.read)
    expect(again.status).toBe(404)
    expect(((await again.json()) as ErrorBody).error.code).toBe("TX_NOT_FOUND")
  })
})

describe("keyset pagination across requests — the caller the session exists for", () => {
  const ROWS = 300
  const PAGE = 50

  async function seed(): Promise<void> {
    await write("delete from t")
    const values = Array.from({ length: ROWS }, (_, i) => `(${i + 1}, 'v${i + 1}', ${i + 1})`)
    await write(`insert into t(id, v, ord) values ${values.join(",")}`)
  }

  /** The keyset predicate for a compound, *mutable* key — which is where per-page snapshots fail. */
  const PAGE_SQL =
    "select id, ord from t where (ord > ?) or (ord = ? and id > ?) order by ord, id limit ?"

  /**
   * Walks the table one page per request, perturbing it between pages exactly as a concurrent
   * writer would: rows already read move to the end (a duplicate, if each page is its own
   * snapshot) and rows not yet read move to the front (a skip).
   */
  async function paginate(page: (sql: string, args: unknown[]) => Promise<QueryResult>): Promise<number[]> {
    const seen: number[] = []
    let ord = -1e9
    let id = 0
    for (let guard = 0; guard < 50; guard++) {
      const result = await page(PAGE_SQL, [ord, ord, id, PAGE])
      const rows = result.rows as unknown[][]
      if (rows.length === 0) break
      for (const row of rows) seen.push(Number(row[0]))
      const last = rows[rows.length - 1] as unknown[]
      ord = Number(last[1])
      id = Number(last[0])

      // The concurrent writer. Deterministic, so the control below is not a flake: ten rows this
      // page just returned are pushed past the end, and ten it has not reached are pulled to the
      // front. Neither changes the *set* of rows in the table, only where a fresh snapshot would
      // find them.
      const moved = rows.slice(0, 10).map((row) => Number(row[0]))
      if (moved.length > 0) {
        await write(`update t set ord = ord + 1000000 where id in (${moved.join(",")})`)
      }
      const ahead = Array.from({ length: 10 }, (_, i) => id + PAGE + i + 1).filter((n) => n <= ROWS)
      if (ahead.length > 0) {
        await write(`update t set ord = -id where id in (${ahead.join(",")})`)
      }
    }
    return seen
  }

  test("inside a session the scan neither skips nor duplicates a row", async () => {
    await seed()
    const { read } = await begin()
    let seen: number[]
    try {
      seen = await paginate(async (sql, args) => {
        const response = await inSession(read, sql, args)
        expect(response.status).toBe(200)
        return (await response.json()) as QueryResult
      })
    } finally {
      await end(read)
    }
    expect(seen.length).toBe(ROWS)
    expect(new Set(seen).size).toBe(ROWS)
    expect([...seen].sort((a, b) => a - b)).toEqual(
      Array.from({ length: ROWS }, (_, i) => i + 1),
    )
  })

  test("the control: the same loop on per-request snapshots skips and duplicates", async () => {
    await seed()
    const seen = await paginate(async (sql, args) =>
      server.json<QueryResult>("/v1/db/acme/query", {
        method: "POST",
        body: JSON.stringify({ sql, args }),
      }),
    )
    // Rows pushed past the end are read a second time; rows pulled to the front are never read.
    expect(new Set(seen).size).toBeLessThan(ROWS)
    expect(seen.length).toBeGreaterThan(new Set(seen).size)
  })
})

describe("the bounds, and what is refused inside a session", () => {
  test("the seventeenth session on one database is 409 TX_BUSY", async () => {
    await createDb(server, "bounded", "create table t(id integer primary key)")
    const open: string[] = []
    try {
      for (let i = 0; i < 16; i++) open.push((await begin("bounded")).read)
      const seventeenth = await server.fetch("/v1/db/bounded/read", {
        method: "POST",
        body: JSON.stringify({}),
      })
      expect(seventeenth.status).toBe(409)
      expect(seventeenth.headers.get("retry-after")).toBe("1")
      expect(((await seventeenth.json()) as ErrorBody).error.code).toBe("TX_BUSY")

      // Ending one makes room, which is what `Retry-After: 1` is promising.
      await end(open.pop() as string, "bounded")
      const retried = await server.fetch("/v1/db/bounded/read", {
        method: "POST",
        body: JSON.stringify({}),
      })
      expect(retried.status).toBe(200)
      open.push(((await retried.json()) as ReadBeginResult).read)
    } finally {
      for (const read of open) await end(read, "bounded")
    }
  })

  test("a session left past readTxTimeoutMs is gone, and its next statement says so", async () => {
    // A short hard leash and a long idle one, so the expiry under test is unambiguously the
    // `readTxTimeoutMs` wall rather than `txIdleTimeoutMs`.
    const short = await startTestServer({
      limits: { readTxTimeoutMs: 200, txIdleTimeoutMs: 10_000 },
    })
    await createDb(short, "acme", "create table t(id integer primary key)")
    const begun = await short.fetch("/v1/db/acme/read", {
      method: "POST",
      body: JSON.stringify({}),
    })
    const { read } = (await begun.json()) as ReadBeginResult
    // Busy, not idle: a statement every 50 ms keeps the idle timer reset the whole time.
    const deadline = Date.now() + 400
    let last: Response | null = null
    while (Date.now() < deadline) {
      last = await short.fetch(`/v1/db/acme/read/${read}`, {
        method: "POST",
        body: JSON.stringify({ sql: "select 1" }),
      })
      if (last.status !== 200) break
      await last.text()
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(last?.status).toBe(404)
    expect(((await (last as Response).json()) as ErrorBody).error.code).toBe("TX_NOT_FOUND")
    // The tenant is clear afterwards: the reader went back to the pool rather than leaking.
    const stats = await short.json<{ readSessions: number }>("/v1/db/acme")
    expect(stats.readSessions).toBe(0)
  })

  test("a write inside a session is refused, and the session survives it", async () => {
    const { read } = await begin()
    try {
      const refused = await inSession(read, "insert into t(id, v, ord) values (9999, 'x', 9999)")
      expect(refused.status).toBe(403)
      expect(((await refused.json()) as ErrorBody).error.code).toBe("SQLITE_READONLY")
      // Nothing landed, on either side of the session.
      expect(await readOne(read, "select count(*) from t where id = 9999")).toBe(0)
      const outside = await server.json<QueryResult>("/v1/db/acme/query", {
        method: "POST",
        body: JSON.stringify({ sql: "select count(*) from t where id = 9999" }),
      })
      expect(Number((outside.rows[0] as unknown[])[0])).toBe(0)
      // A refused statement leaves the session usable, as a failed statement does a transaction.
      expect(await readOne(read, "select 1")).toBe(1)
    } finally {
      await end(read)
    }
  })

  test("a write as the session's *first* statement is refused, which is the case that would land", async () => {
    // The dangerous one, and not obviously so. Once a session has read, SQLite itself refuses to
    // promote the deferred read transaction and the write fails `503 BUSY` — a misleading answer,
    // but an answer. Before the first read there is no read transaction to promote, and without
    // `assertReadOnlyStatement` the insert simply **succeeds**: measured, `200` with
    // `rowsAffected: 1`, on a pooled reader, outside the tenant's writer and therefore outside
    // the WAL tailer, the log, the change feed and replication. On a replica that is a row the
    // primary has never heard of. A fresh database, because a warm one hides it behind a lock.
    await createDb(server, "firstwrite", "create table t(id integer primary key, v text)")
    const { read } = await begin("firstwrite")
    const refused = await inSession(read, "insert into t(id, v) values (1, 'ghost')", [], "firstwrite")
    expect(refused.status).toBe(403)
    expect(((await refused.json()) as ErrorBody).error.code).toBe("SQLITE_READONLY")
    await end(read, "firstwrite")
    const after = await server.json<QueryResult>("/v1/db/firstwrite/query", {
      method: "POST",
      body: JSON.stringify({ sql: "select count(*) from t" }),
    })
    expect(Number((after.rows[0] as unknown[])[0])).toBe(0)
  })

  test("a read-only token can open and use one; the routes need `ro`, not `rw`", async () => {
    const { token } = await server.token({ dbs: ["acme"], scope: "ro" })
    const begun = await server.fetch("/v1/db/acme/read", {
      method: "POST",
      body: JSON.stringify({}),
      token,
    })
    expect(begun.status).toBe(200)
    const { read } = (await begun.json()) as ReadBeginResult
    const statement = await server.fetch(`/v1/db/acme/read/${read}`, {
      method: "POST",
      body: JSON.stringify({ sql: "select count(*) from t" }),
      token,
    })
    expect(statement.status).toBe(200)
    expect((await server.fetch(`/v1/db/acme/read/${read}`, { method: "DELETE", token })).status).toBe(200)
  })

  test("an unknown baton is 404 TX_NOT_FOUND on both the statement route and the end route", async () => {
    const bogus = "0".repeat(32)
    const statement = await inSession(bogus, "select 1")
    expect(statement.status).toBe(404)
    expect(((await statement.json()) as ErrorBody).error.code).toBe("TX_NOT_FOUND")
    expect((await end(bogus)).status).toBe(404)
  })
})

describe("GET /v1/db/:db reports open read sessions", () => {
  test("the counter rises and falls with the sessions on that database", async () => {
    await createDb(server, "counted", "create table t(id integer primary key)")
    const before = await server.json<{ readSessions: number }>("/v1/db/counted")
    expect(before.readSessions).toBe(0)
    const one = await begin("counted")
    const two = await begin("counted")
    const during = await server.json<{ readSessions: number }>("/v1/db/counted")
    expect(during.readSessions).toBe(2)
    // Per database, not per node: another database's sessions do not show up here.
    const elsewhere = await begin("acme")
    expect((await server.json<{ readSessions: number }>("/v1/db/counted")).readSessions).toBe(2)
    await end(elsewhere.read)
    await end(one.read, "counted")
    await end(two.read, "counted")
    expect((await server.json<{ readSessions: number }>("/v1/db/counted")).readSessions).toBe(0)
  })
})
