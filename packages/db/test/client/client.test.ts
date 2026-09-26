// The client SDK of design §9.1 against a live server: every verb, the value codec under each
// `intMode`, batches, and the read-your-writes header the client is supposed to send on its own.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { BqlClientError, createClient } from "../../src/client/index.ts"
import { HEADERS } from "../../src/client/protocol.ts"
import { failure, plain, startClientFixture, stopAll, type ClientFixture } from "./harness.ts"

let fixture: ClientFixture

beforeAll(async () => {
  fixture = await startClientFixture()
  const db = fixture.client.db("acme")
  await db.sql`insert into todos(title) values (${"write it"}), (${"ship it"})`
})
afterAll(stopAll)

describe("tagged templates", () => {
  test("a select comes back as rows with the statement's metadata", async () => {
    const db = fixture.client.db("acme")
    const rows = await db.sql`select id, title from todos order by id`
    expect(plain(rows)).toEqual([
      { id: 1, title: "write it" },
      { id: 2, title: "ship it" },
    ])
    expect(rows.count).toBe(2)
    expect(rows.command).toBe("SELECT")
    expect(rows.columns).toEqual(["id", "title"])
    expect(rows.types).toEqual(["INTEGER", "TEXT"])
    expect(rows.affectedRows).toBe(0)
    expect(rows.txid).toBeGreaterThan(0)
    expect(rows.vmSteps).toBeGreaterThan(0)
  })

  test("interpolated values are bound, not spliced into the SQL", async () => {
    const db = fixture.client.db("acme")
    const hostile = "'; drop table todos; --"
    const rows = await db.sql`select id from todos where title = ${hostile}`
    expect(plain(rows)).toEqual([])
    const still = await db.sql`select count(*) as n from todos`.first()
    expect(still).toEqual({ n: 2 })
  })

  test("values() returns arrays and first() returns one row or null", async () => {
    const db = fixture.client.db("acme")
    const values = await db.sql`select id, title from todos order by id`.values()
    expect(plain(values)).toEqual([
      [1, "write it"],
      [2, "ship it"],
    ])
    expect(values.columns).toEqual(["id", "title"])
    expect(await db.sql`select title from todos where id = ${1}`.first()).toEqual({
      title: "write it",
    })
    expect(await db.sql`select title from todos where id = ${999}`.first()).toBeNull()
  })

  test("raw() is values() under the other name", async () => {
    const db = fixture.client.db("acme")
    expect(plain(await db.sql`select id from todos order by id`.raw())).toEqual([[1], [2]])
  })

  test("a write reports affectedRows, lastInsertRowid and a new txid", async () => {
    const db = fixture.client.db("acme")
    const before = db.txid
    const written = await db.sql`insert into todos(title) values (${"third"})`.run()
    expect(written.command).toBe("INSERT")
    expect(written.affectedRows).toBe(1)
    expect(written.lastInsertRowid).toBe(3)
    expect(written.txid).toBeGreaterThan(before)
    await db.sql`delete from todos where id = ${3}`.run()
  })

  test("a statement runs once however many times it is awaited", async () => {
    const db = fixture.client.db("acme")
    const query = db.sql`insert into notes(body) values (${"once"})`
    await query
    await query
    const count = await db.sql`select count(*) as n from notes where body = ${"once"}`.first()
    expect(count).toEqual({ n: 1 })
  })
})

describe("execute", () => {
  test("positional and named arguments both bind", async () => {
    const db = fixture.client.db("acme")
    expect(await db.execute("select title from todos where id = ?", [2]).first()).toEqual({
      title: "ship it",
    })
    expect(
      await db.execute("select title from todos where id = :id", { id: 2 }).first(),
    ).toEqual({ title: "ship it" })
  })

  test("unsafe is execute for SQL that is already a string", async () => {
    const db = fixture.client.db("acme")
    const rows = await db.unsafe("select 1 as one")
    expect(plain(rows)).toEqual([{ one: 1 }])
  })

  test("a SQLite failure arrives as a BqlClientError with the server's code", async () => {
    const db = fixture.client.db("acme")
    const error = await failure(db.sql`select * from nope`)
    expect(error).toBeInstanceOf(BqlClientError)
    expect(error.code).toBe("SQLITE_ERROR")
    expect(error.status).toBe(400)
    expect(error.message).toContain("nope")
  })

  // The server validates every request against the schema it publishes and reports *every* problem
  // it found (`docs/h8-validated-requests.md`). Dropping them here would leave a caller re-guessing
  // which field was wrong out of a summary message.
  test("a schema refusal keeps every problem the server listed", () => {
    const error = BqlClientError.fromBody(
      {
        error: {
          code: "BAD_REQUEST",
          message: "body.sql expected a string, got a number (and 1 more problem)",
          status: 400,
          problems: [
            { path: "body.sql", message: "expected a string, got a number" },
            { path: "body.timeoutMs", message: "expected an integer, got a string" },
          ],
        },
      },
      400,
      "bad request",
    )
    expect(error.code).toBe("BAD_REQUEST")
    expect((error.problems ?? []).map((problem) => problem.path)).toEqual([
      "body.sql",
      "body.timeoutMs",
    ])
  })

  test("an unknown database is a 404, not a hang", async () => {
    const error = await failure(fixture.client.db("missing").sql`select 1`)
    expect(error.code).toBe("DB_NOT_FOUND")
    expect(error.status).toBe(404)
  })
})

describe("values", () => {
  test("blobs, doubles and nulls survive the round trip", async () => {
    const db = fixture.client.db("acme")
    await db.sql`create table exotic(id integer primary key, b blob, f real, n text)`.run()
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])
    await db.sql`insert into exotic(b, f, n) values (${bytes}, ${1.5}, ${null})`.run()
    const row = await db.sql`select b, f, n from exotic`.first()
    expect(row?.b).toBeInstanceOf(Uint8Array)
    expect([...(row?.b as Uint8Array)]).toEqual([...bytes])
    expect(row?.f).toBe(1.5)
    expect(row?.n).toBeNull()
  })

  test("intMode decides what an integer beyond 2^53 becomes", async () => {
    const big = 9007199254740993n
    const db = fixture.client.db("acme")
    await db.sql`create table wide(id integer primary key, v integer)`.run()
    await db.execute("insert into wide(v) values (?)", [big]).run()

    const asBigint = createClient({
      url: fixture.server.url,
      token: fixture.server.adminKey,
      intMode: "bigint",
    })
    const asString = createClient({
      url: fixture.server.url,
      token: fixture.server.adminKey,
      intMode: "string",
    })
    try {
      expect((await asBigint.db("acme").sql`select v from wide`.first())?.v).toBe(big)
      expect((await asString.db("acme").sql`select v from wide`.first())?.v).toBe(
        "9007199254740993",
      )
      // The default cannot represent it, and says so rather than rounding.
      const error = await failure(db.sql`select v from wide`)
      expect(error.code).toBe("CLIENT")
      expect(error.message).toContain("9007199254740993")
    } finally {
      asBigint.close()
      asString.close()
    }
  })
})

describe("batch", () => {
  test("an atomic batch is one transaction and one txid", async () => {
    const db = fixture.client.db("acme")
    const results = await db.batch([
      db.stmt`insert into notes(body) values (${"a"})`,
      { sql: "insert into notes(body) values (?)", args: ["b"] },
      db.stmt`select count(*) as n from notes`,
    ])
    expect(results).toHaveLength(3)
    expect(results[0]?.command).toBe("INSERT")
    expect(results[0]?.affectedRows).toBe(1)
    expect(results[2]?.[0]).toEqual({ n: 3 })
    expect(results[0]?.txid).toBe(results[2]?.txid as number)
  })

  test("a failing atomic batch rolls back and names the statement", async () => {
    const db = fixture.client.db("acme")
    const before = await db.sql`select count(*) as n from notes`.first()
    const error = await failure(
      db.batch([
        db.stmt`insert into notes(body) values (${"kept?"})`,
        db.stmt`insert into nope(body) values (1)`,
      ]),
    )
    expect(error.failedIndex).toBe(1)
    expect(await db.sql`select count(*) as n from notes`.first()).toEqual(before as never)
  })

  test("a non-atomic batch keeps what ran before the failure", async () => {
    const db = fixture.client.db("acme")
    await db.batch([db.stmt`delete from notes`], { atomic: false })
    const error = await failure(
      db.batch(
        [db.stmt`insert into notes(body) values (${"kept"})`, db.stmt`select * from nope`],
        { atomic: false },
      ),
    )
    expect(error.failedIndex).toBe(1)
    expect(await db.sql`select count(*) as n from notes`.first()).toEqual({ n: 1 })
  })
})

describe("consistency", () => {
  test("ryw tracks the txid per database and sends it as a header", async () => {
    const db = fixture.client.db("acme")
    await db.sql`insert into notes(body) values (${"ryw"})`.run()
    const txid = fixture.client.txid("acme")
    expect(txid).toBeGreaterThan(0)
    expect(db.txid).toBe(txid)

    fixture.requests.length = 0
    await db.sql`select 1`
    const sent = fixture.requests.at(-1)
    expect(sent?.headers.get(HEADERS.minTxid)).toBe(String(txid))
  })

  test("consistency any sends no minimum at all", async () => {
    const loose = createClient({
      url: fixture.server.url,
      token: fixture.server.adminKey,
      consistency: "any",
      fetch: (url, init) => {
        seen.push(new Headers(init?.headers))
        return fetch(url, init)
      },
    })
    const seen: Headers[] = []
    try {
      await loose.db("acme").sql`insert into notes(body) values ('loose')`.run()
      await loose.db("acme").sql`select 1`
      expect(seen.at(-1)?.get(HEADERS.minTxid)).toBeNull()
    } finally {
      loose.close()
    }
  })

  test("a minTxid this node cannot reach is a 425", async () => {
    const db = fixture.client.db("acme")
    const error = await failure(db.execute("select 1", [], { minTxid: db.txid + 5000 }))
    expect(error.code).toBe("TXID_NOT_AVAILABLE")
    expect(error.status).toBe(425)
  })
})

describe("createClient", () => {
  test("a default database means client.db() takes no argument", async () => {
    const client = createClient({
      url: fixture.server.url,
      token: fixture.server.adminKey,
      db: "acme",
    })
    try {
      expect(client.db().name).toBe("acme")
      expect(plain(await client.db().sql`select 1 as one`)).toEqual([{ one: 1 }])
    } finally {
      client.close()
    }
  })

  test("a url that is not http is refused before anything is sent", () => {
    expect(() => createClient({ url: "file:///tmp/x" })).toThrow(BqlClientError)
  })
})
