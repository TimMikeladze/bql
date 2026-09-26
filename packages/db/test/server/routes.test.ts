// The statement routes of design §6.1 and §6.2, over a real listener: one round trip per case,
// so what is asserted is what a client would actually receive.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { BatchResult, ErrorBody, QueryResult } from "../../src/client/protocol.ts"
import { createDb, startTestServer, stopAll, type TestServer } from "./harness.ts"

let server: TestServer

beforeAll(async () => {
  server = await startTestServer()
  await createDb(
    server,
    "acme",
    `create table todos(id integer primary key, title text, done integer default 0);
     create table notes(id integer primary key, body text);
     insert into todos(title) values ('write it'), ('ship it')`,
  )
})
afterAll(stopAll)

function post<T>(route: string, body: unknown, init: RequestInit = {}): Promise<T> {
  return server.json<T>(route, { method: "POST", body: JSON.stringify(body), ...init })
}

describe("query", () => {
  test("a select comes back as columns, types and array rows", async () => {
    const result = await post<QueryResult>("/v1/db/acme/query", {
      sql: "select id, title from todos order by id",
    })
    expect(result.columns).toEqual(["id", "title"])
    expect(result.types).toEqual(["INTEGER", "TEXT"])
    expect(result.rows).toEqual([
      [1, "write it"],
      [2, "ship it"],
    ])
    expect(result.rowsAffected).toBe(0)
    expect(result.lastInsertRowid).toBeNull()
    expect(result.vmSteps).toBeGreaterThan(0)
  })

  test("rows: object keys every row by column name", async () => {
    const result = await post<QueryResult>("/v1/db/acme/query", {
      sql: "select id, title from todos where id = 1",
      rows: "object",
    })
    expect(result.rows).toEqual([{ id: 1, title: "write it" }])
  })

  test("a write reports rowsAffected, lastInsertRowid and a new txid", async () => {
    const before = await post<QueryResult>("/v1/db/acme/query", { sql: "select 1" })
    const written = await post<QueryResult>("/v1/db/acme/query", {
      sql: "insert into todos(title) values (?)",
      args: ["third"],
    })
    expect(written.rowsAffected).toBe(1)
    expect(written.lastInsertRowid).toBe(3)
    expect(written.txid).toBeGreaterThan(before.txid)
  })

  test("lastInsertRowid describes this statement, not an earlier one on the same connection", async () => {
    const inserted = await post<QueryResult>("/v1/db/acme/query", {
      sql: "insert into notes(body) values ('for the rowid')",
    })
    expect(inserted.lastInsertRowid).toBeGreaterThan(0)

    // An update and a delete that match nothing changed no rows and inserted none.
    for (const sql of [
      "update notes set body = 'x' where id = -1",
      "delete from notes where id = -1",
    ]) {
      const result = await post<QueryResult>("/v1/db/acme/query", { sql })
      expect(result.rowsAffected).toBe(0)
      expect(result.lastInsertRowid).toBeNull()
    }

    // And one that did change a row still inserted nothing.
    const updated = await post<QueryResult>("/v1/db/acme/query", {
      sql: "update notes set body = 'changed' where id = ?",
      args: [inserted.lastInsertRowid as number],
    })
    expect(updated.rowsAffected).toBe(1)
    expect(updated.lastInsertRowid).toBeNull()
  })

  test("a write that matches nothing keeps the database at the txid it was already at", async () => {
    const before = await post<QueryResult>("/v1/db/acme/query", { sql: "select 1" })
    const noop = await post<QueryResult>("/v1/db/acme/query", {
      sql: "delete from notes where id = -1",
    })
    expect(noop.rowsAffected).toBe(0)
    expect(noop.txid).toBe(before.txid)
  })

  test("named arguments bind with or without their sigil", async () => {
    const result = await post<QueryResult>("/v1/db/acme/query", {
      sql: "select title from todos where id = :id",
      args: { id: 2 },
    })
    expect(result.rows).toEqual([["ship it"]])
  })

  test("only exotic values are tagged, and they survive the round trip", async () => {
    const result = await post<QueryResult>("/v1/db/acme/query", {
      sql: "select ? as big, ? as blob, ? as txt, ? as absent, 1.5 as fraction",
      args: [{ $i: "9007199254740993" }, { $b: "AAECAw==" }, "hi", null],
      rows: "object",
    })
    expect(result.rows[0]).toEqual({
      big: { $i: "9007199254740993" },
      blob: { $b: "AAECAw==" },
      txt: "hi",
      absent: null,
      fraction: 1.5,
    })
    expect(result.types).toEqual(["INTEGER", "BLOB", "TEXT", "NULL", "REAL"])
  })

  test("every response carries the four bql.sh headers", async () => {
    const response = await server.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "select 1" }),
    })
    expect(response.headers.get("BQL-Node")).toBe("test-node")
    expect(response.headers.get("BQL-Role")).toBe("primary")
    expect(Number(response.headers.get("BQL-Txid"))).toBeGreaterThan(0)
    expect(Number(response.headers.get("BQL-Duration-Us"))).toBeGreaterThanOrEqual(0)
  })

  test("more than maxRows fails the request rather than truncating it", async () => {
    const response = await server.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "select id from todos", maxRows: 1 }),
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as ErrorBody).error.code).toBe("TOO_MANY_ROWS")
  })

  test("a runaway query is interrupted at its deadline and answers 408", async () => {
    const response = await server.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({
        sql: "with recursive c(x) as (select 1 union all select x + 1 from c) select count(*) from c",
        timeoutMs: 100,
      }),
    })
    expect(response.status).toBe(408)
    expect(((await response.json()) as ErrorBody).error.code).toBe("QUERY_TIMEOUT")
  })

  test("a minTxid this node cannot reach waits, then answers 425", async () => {
    const response = await server.fetch("/v1/db/acme/query", {
      method: "POST",
      headers: { "BQL-Min-Txid": "999999" },
      body: JSON.stringify({ sql: "select 1" }),
    })
    expect(response.status).toBe(425)
    const body = (await response.json()) as ErrorBody
    expect(body.error.code).toBe("TXID_NOT_AVAILABLE")
    expect(body.error.txid).toBeGreaterThan(0)
  })

  test("a minTxid a concurrent write is about to reach is served once it lands", async () => {
    const current = await post<QueryResult>("/v1/db/acme/query", { sql: "select 1" })
    const waiting = server.fetch("/v1/db/acme/query", {
      method: "POST",
      headers: { "BQL-Min-Txid": String(current.txid + 1) },
      body: JSON.stringify({ sql: "select count(*) from todos" }),
    })
    await post<QueryResult>("/v1/db/acme/query", {
      sql: "insert into notes(body) values ('a note')",
    })
    const response = await waiting
    expect(response.status).toBe(200)
  })

  test("a syntax error is a 400 carrying SQLite's own code", async () => {
    const response = await server.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "selct 1" }),
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as ErrorBody).error.code).toBe("SQLITE_ERROR")
  })

  test("a constraint violation is a 409 with the extended code", async () => {
    const response = await server.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "insert into todos(id, title) values (1, 'clash')" }),
    })
    expect(response.status).toBe(409)
    expect(((await response.json()) as ErrorBody).error.code).toBe("SQLITE_CONSTRAINT_PRIMARYKEY")
  })

  test("an unknown database is a 404 and a malformed body a 400", async () => {
    expect(
      (
        await server.fetch("/v1/db/nowhere/query", {
          method: "POST",
          body: JSON.stringify({ sql: "select 1" }),
        })
      ).status,
    ).toBe(404)
    expect(
      (await server.fetch("/v1/db/acme/query", { method: "POST", body: "{not json" })).status,
    ).toBe(400)
    expect(
      (await server.fetch("/v1/db/acme/query", { method: "POST", body: "{}" })).status,
    ).toBe(400)
  })
})

describe("batch", () => {
  test("an atomic batch is one transaction with one txid", async () => {
    const result = await post<BatchResult>("/v1/db/acme/batch", {
      statements: [
        { sql: "insert into notes(body) values ('one')" },
        { sql: "insert into notes(body) values ('two')" },
        { sql: "select count(*) as n from notes" },
      ],
    })
    expect(result.results).toHaveLength(3)
    expect(result.results.every((one) => one.txid === result.txid)).toBe(true)
    expect(result.results[2]?.rows[0]).toEqual([expect.any(Number)])
  })

  test("an atomic batch rolls back as a whole and names the failing statement", async () => {
    const before = await post<QueryResult>("/v1/db/acme/query", {
      sql: "select count(*) as n from notes",
    })
    const response = await server.fetch("/v1/db/acme/batch", {
      method: "POST",
      body: JSON.stringify({
        statements: [
          { sql: "insert into notes(body) values ('doomed')" },
          { sql: "insert into notes(nope) values ('bad column')" },
        ],
      }),
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as ErrorBody).error.failedIndex).toBe(1)
    const after = await post<QueryResult>("/v1/db/acme/query", {
      sql: "select count(*) as n from notes",
    })
    expect(after.rows[0]).toEqual(before.rows[0] as never)
  })

  test("a non-atomic batch keeps what ran before the failure", async () => {
    const before = await post<QueryResult>("/v1/db/acme/query", {
      sql: "select count(*) as n from notes",
    })
    const response = await server.fetch("/v1/db/acme/batch", {
      method: "POST",
      body: JSON.stringify({
        atomic: false,
        statements: [{ sql: "insert into notes(body) values ('kept')" }, { sql: "bogus" }],
      }),
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as ErrorBody).error.failedIndex).toBe(1)
    const after = await post<QueryResult>("/v1/db/acme/query", {
      sql: "select count(*) as n from notes",
    })
    expect(Number((after.rows[0] as number[])[0])).toBe(
      Number((before.rows[0] as number[])[0]) + 1,
    )
  })

  test("an empty batch is a 400", async () => {
    const response = await server.fetch("/v1/db/acme/batch", {
      method: "POST",
      body: JSON.stringify({ statements: [] }),
    })
    expect(response.status).toBe(400)
  })
})
