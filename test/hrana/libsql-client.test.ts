// The real `@libsql/client` against a real BunQL server, over both transports. `client.test.ts`
// beside this file drives the request sequences by hand and is the finer-grained of the two; this
// one is the proof that the hand-rolled reading was right, and it is the file to look at when a
// client release changes something.
//
// Two things about the client shape every test here:
//
//  1. The pipeline URL is resolved *relatively* — `new URL("v2/pipeline", baseUrl)` — so a
//     path-mounted base URL must end in a slash. `libsql://host/v1/db/acme` resolves to
//     `/v1/db/v2/pipeline` and 404s; `libsql://host/v1/db/acme/` is right. Root addressing needs
//     nothing, and is what every Turso deployment uses.
//  2. Over HTTP the client never probes: `@libsql/client` builds its Hrana client with
//     `protocolVersion = 2`, so every request is `POST v2/pipeline` and the v3 cursor path is
//     never taken. Over WebSocket it offers `hrana2` only, for the same reason.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createClient, LibsqlError, type Client, type Config } from "@libsql/client"
import { startHrana, stopAllHrana, type TestHrana } from "./harness.ts"

const SCHEMA = `
  create table users (id integer primary key, name text not null, email text unique);
  create table vals (id integer primary key, big integer, r real, b blob, t text)
`

let server: TestHrana
const open: Client[] = []

/** A client on the fixture server, closed for us when the suite ends. */
function client(config: Partial<Config> & { url: string }): Client {
  const made = createClient({ authToken: server.adminKey, ...config } as Config)
  open.push(made)
  return made
}

/** `127.0.0.1:<port>`, which is what every URL in this file is built from. */
function hostPort(): string {
  return server.url.replace("http://", "")
}

beforeAll(async () => {
  server = await startHrana({
    // A transaction is idle between two of the client's statements; the harness default would
    // expire one mid-test.
    limits: { txIdleTimeoutMs: 15_000 },
  })
  await server.createDb("app", SCHEMA)
  await server.createDb("default", SCHEMA)
})

afterAll(async () => {
  for (const one of open.splice(0)) one.close()
  await stopAllHrana()
})

/** The error a promise rejected with, as a `LibsqlError`. */
async function failure(promise: PromiseLike<unknown>): Promise<LibsqlError> {
  try {
    await promise
  } catch (err) {
    return err as LibsqlError
  }
  throw new Error("expected the call to fail, and it did not")
}

// ── addressing ─────────────────────────────────────────────────────────────────────────────────

describe("connection strings", () => {
  test("a path-mounted base URL works when it ends in a slash", async () => {
    const c = client({ url: `http://${hostPort()}/v1/db/app/` })
    const rs = await c.execute("select 1 as one")
    expect(rs.rows[0]?.one).toBe(1)
  })

  test("the same URL without the trailing slash 404s, because the client resolves relatively", async () => {
    const c = client({ url: `http://${hostPort()}/v1/db/app` })
    const err = await failure(c.execute("select 1"))
    // `new URL("v2/pipeline", ".../v1/db/app")` is `/v1/db/v2/pipeline`, which is no route at all.
    expect(err.message).toContain("404")
  })

  test("root addressing reaches the database called `default`", async () => {
    const c = client({ url: `http://${hostPort()}` })
    const rs = await c.execute("select count(*) as n from users")
    expect(rs.rows[0]?.n).toBe(0)
  })

  test("root addressing plus an `x-namespace` header reaches any database", async () => {
    const c = client({
      url: `http://${hostPort()}`,
      fetch: ((input: Request) =>
        fetch(new Request(input, { headers: { ...Object.fromEntries(input.headers), "x-namespace": "app" } }))) as typeof fetch,
    })
    const rs = await c.execute("insert into users (name, email) values ('ns', 'ns@x') returning id")
    expect(rs.rows[0]?.id).toBe(1)
    // The row landed in `app`, not in `default`.
    const other = client({ url: `http://${hostPort()}` })
    expect((await other.execute("select count(*) as n from users")).rows[0]?.n).toBe(0)
  })

  test("a `libsql://` URL works against a TLS-less node with `?tls=0`", async () => {
    // `libsql:` means https/wss unless `tls=0` says otherwise, and the node entrypoint prefers
    // HTTP. This is the spelling to hand someone who insists on the libsql scheme locally.
    const c = client({ url: `libsql://${hostPort()}/v1/db/app/?tls=0` })
    expect((await c.execute("select 1 as one")).rows[0]?.one).toBe(1)
  })

  test("a WebSocket URL addresses a database at `/v1/db/<name>/hrana`", async () => {
    const c = client({ url: `ws://${hostPort()}/v1/db/app/hrana` })
    const rs = await c.execute("select count(*) as n from users")
    expect(rs.rows[0]?.n).toBe(1)
    expect(c.protocol).toBe("ws")
  })

  test("a WebSocket URL at the root reaches `default`", async () => {
    const c = client({ url: `ws://${hostPort()}` })
    expect((await c.execute("select count(*) as n from users")).rows[0]?.n).toBe(0)
  })

  test("a WebSocket URL missing `/hrana` cannot upgrade", async () => {
    const c = client({ url: `ws://${hostPort()}/v1/db/app` })
    const err = await failure(c.execute("select 1"))
    expect(err.code).toBe("HRANA_WEBSOCKET_ERROR")
  })

  test("a bad token is `UNAUTHENTICATED` on both transports", async () => {
    for (const url of [`http://${hostPort()}/v1/db/app/`, `ws://${hostPort()}/v1/db/app/hrana`]) {
      const c = client({ url, authToken: "not-a-token" })
      expect((await failure(c.execute("select 1"))).code).toBe("UNAUTHENTICATED")
    }
  })
})

// ── everything else, over both transports ──────────────────────────────────────────────────────

const transports: { name: string; db: string; url: () => string }[] = [
  { name: "http", db: "http_db", url: () => `http://${hostPort()}/v1/db/http_db/` },
  { name: "ws", db: "ws_db", url: () => `ws://${hostPort()}/v1/db/ws_db/hrana` },
]

for (const transport of transports) {
  describe(`@libsql/client over ${transport.name}`, () => {
    let c: Client

    beforeAll(async () => {
      await server.createDb(transport.db, SCHEMA)
      c = client({ url: transport.url(), intMode: "bigint" })
    })

    test("execute with positional args, and every ResultSet field", async () => {
      const rs = await c.execute({
        sql: "insert into users (name, email) values (?, ?)",
        args: ["ada", "ada@x"],
      })
      expect(rs.rowsAffected).toBe(1)
      expect(rs.lastInsertRowid).toBe(1n)
      expect(rs.columns).toEqual([])

      const read = await c.execute("select id, name, email from users where name = ?", ["ada"])
      expect(read.columns).toEqual(["id", "name", "email"])
      expect(read.columnTypes).toEqual(["INTEGER", "TEXT", "TEXT"])
      expect(read.rowsAffected).toBe(0)
      expect(read.lastInsertRowid).toBeUndefined()

      const row = read.rows[0]
      if (!row) throw new Error("no row")
      // A libsql row is an array and an object at once.
      expect(row.length).toBe(3)
      expect(row[1]).toBe("ada")
      expect(row.name).toBe("ada")
      expect(row.email).toBe("ada@x")
    })

    test("execute with named args, in both of SQLite's spellings", async () => {
      const colon = await c.execute({ sql: "select :a + :b as sum", args: { a: 2, b: 3 } })
      expect(colon.rows[0]?.sum).toBe(5n)
      const dollar = await c.execute({ sql: "select $word as word", args: { word: "hi" } })
      expect(dollar.rows[0]?.word).toBe("hi")
    })

    test("integers past 2^53, floats, blobs and nulls", async () => {
      const big = 9007199254740993n
      await c.execute({
        sql: "insert into vals (id, big, r, b, t) values (?, ?, ?, ?, ?)",
        args: [1, big, 1.5, new Uint8Array([1, 2, 3]), null],
      })
      const rs = await c.execute("select big, r, b, t from vals where id = 1")
      const row = rs.rows[0]
      if (!row) throw new Error("no row")
      expect(rs.columnTypes).toEqual(["INTEGER", "REAL", "BLOB", "TEXT"])
      expect(row.big).toBe(big)
      expect(row.r).toBe(1.5)
      expect(row.t).toBeNull()
      // A blob goes in as a `Uint8Array` and comes back as an `ArrayBuffer`.
      expect(row.b).toBeInstanceOf(ArrayBuffer)
      expect([...new Uint8Array(row.b as ArrayBuffer)]).toEqual([1, 2, 3])

      // An empty blob survives as an empty blob, not as null.
      await c.execute({ sql: "insert into vals (id, b) values (2, ?)", args: [new Uint8Array()] })
      const empty = await c.execute("select b from vals where id = 2")
      expect((empty.rows[0]?.b as ArrayBuffer).byteLength).toBe(0)
    })

    test("intMode string reads the same integer as decimal text, and number refuses it", async () => {
      const asString = client({ url: transport.url(), intMode: "string" })
      expect((await asString.execute("select big from vals where id = 1")).rows[0]?.big).toBe(
        "9007199254740993",
      )
      const asNumber = client({ url: transport.url() })
      // Not a `LibsqlError`: `hrana-client` raises a plain RangeError while decoding.
      const err = await failure(asNumber.execute("select big from vals where id = 1"))
      expect(err.message).toContain("too large")
      // The same client reads a small integer as a JS number.
      expect((await asNumber.execute("select 7 as n")).rows[0]?.n).toBe(7)
    })

    test("a batch in write mode commits together, and one failure rolls all of it back", async () => {
      const ok = await c.batch(
        [
          "insert into users (name, email) values ('grace', 'grace@x')",
          { sql: "insert into users (name, email) values (?, ?)", args: ["alan", "alan@x"] },
        ],
        "write",
      )
      expect(ok.map((r) => r.rowsAffected)).toEqual([1, 1])

      const before = (await c.execute("select count(*) as n from users")).rows[0]?.n
      const err = await failure(
        c.batch(
          [
            "insert into users (name, email) values ('edsger', 'edsger@x')",
            // The same address as `grace`, so the second statement raises and the batch unwinds.
            "insert into users (name, email) values ('dup', 'grace@x')",
          ],
          "write",
        ),
      )
      expect(err.code).toBe("SQLITE_CONSTRAINT_UNIQUE")
      expect((await c.execute("select count(*) as n from users")).rows[0]?.n).toBe(before)
    })

    test("a batch in read mode reads, and refuses to write", async () => {
      const results = await c.batch(["select count(*) as n from users", "select 1 as one"], "read")
      expect(results.length).toBe(2)
      expect(results[1]?.rows[0]?.one).toBe(1n)
      const err = await failure(
        c.batch(["insert into users (name, email) values ('ro', 'ro@x')"], "read"),
      )
      expect(err.code).toBe("SQLITE_READONLY")
    })

    test("a transaction executes, commits and rolls back", async () => {
      const before = (await c.execute("select count(*) as n from users")).rows[0]?.n as bigint

      const tx = await c.transaction("write")
      await tx.execute("insert into users (name, email) values ('tx1', 'tx1@x')")
      // The transaction sees its own write before anyone else does.
      expect((await tx.execute("select count(*) as n from users")).rows[0]?.n).toBe(before + 1n)
      await tx.commit()
      expect((await c.execute("select count(*) as n from users")).rows[0]?.n).toBe(before + 1n)

      const rolled = await c.transaction("write")
      await rolled.execute("insert into users (name, email) values ('tx2', 'tx2@x')")
      await rolled.rollback()
      expect((await c.execute("select count(*) as n from users")).rows[0]?.n).toBe(before + 1n)
    })

    test("a read transaction refuses a write", async () => {
      const tx = await c.transaction("read")
      expect((await tx.execute("select 1 as one")).rows[0]?.one).toBe(1n)
      const err = await failure(tx.execute("insert into users (name, email) values ('r', 'r@x')"))
      expect(err.code).toBe("SQLITE_READONLY")
      await tx.rollback()
    })

    test("a transaction left open is cleaned up when the client closes it", async () => {
      const before = (await c.execute("select count(*) as n from users")).rows[0]?.n
      const tx = await c.transaction("write")
      await tx.execute("insert into users (name, email) values ('open', 'open@x')")
      // `close()` is what `@libsql/client` calls on an abandoned transaction: it ends the Hrana
      // stream, which rolls the transaction back and hands the tenant's writer on.
      tx.close()
      expect(tx.closed).toBe(true)
      expect((await c.execute("select count(*) as n from users")).rows[0]?.n).toBe(before)
      // The writer really was released: the next transaction opens at once.
      const next = await c.transaction("write")
      await next.rollback()
    })

    test("executeMultiple runs a script as one sequence", async () => {
      const table = `seq_${transport.name}`
      await c.executeMultiple(`
        create table ${table} (a integer);
        insert into ${table} values (1);
        insert into ${table} values (2);
      `)
      expect((await c.execute(`select count(*) as n from ${table}`)).rows[0]?.n).toBe(2n)
    })

    test("migrate runs its statements with foreign keys off", async () => {
      const table = `mig_${transport.name}`
      const results = await c.migrate([
        `create table ${table} (a integer)`,
        `insert into ${table} values (7)`,
      ])
      expect(results.length).toBe(2)
      expect((await c.execute(`select a from ${table}`)).rows[0]?.a).toBe(7n)
    })

    test("a failure carries a LibsqlError code worth switching on", async () => {
      const unique = await failure(
        c.execute("insert into users (name, email) values ('dup', 'ada@x')"),
      )
      expect(unique).toBeInstanceOf(LibsqlError)
      expect(unique.code).toBe("SQLITE_CONSTRAINT_UNIQUE")
      expect(unique.message).toContain("UNIQUE constraint failed: users.email")

      expect((await failure(c.execute("select * from nope"))).code).toBe("SQLITE_ERROR")
      expect((await failure(c.execute("this is not sql"))).code).toBe("SQLITE_ERROR")
    })
  })
}

// ── the two places the transports differ ───────────────────────────────────────────────────────

describe("concurrency", () => {
  test("overlapping transactions over HTTP wait for the writer instead of failing", async () => {
    await server.createDb("conc_http", SCHEMA)
    const c = client({ url: `http://${hostPort()}/v1/db/conc_http/`, intMode: "bigint" })
    const one = async (name: string) => {
      const tx = await c.transaction("write")
      await tx.execute({ sql: "insert into users (name, email) values (?, ?)", args: [name, `${name}@x`] })
      await tx.commit()
    }
    // `@libsql/client` runs 20 requests at once by default, so an ORM with parallel handlers
    // reaches this routinely; each HTTP stream is independent, so each `BEGIN` can queue.
    await Promise.all([one("a"), one("b"), one("c"), one("d")])
    expect((await c.execute("select count(*) as n from users")).rows[0]?.n).toBe(4n)
  })

  test("overlapping transactions on one socket are refused at once, not queued", async () => {
    await server.createDb("conc_ws", SCHEMA)
    const c = client({ url: `ws://${hostPort()}/v1/db/conc_ws/hrana`, intMode: "bigint" })
    const one = async (name: string) => {
      const tx = await c.transaction("write")
      await tx.execute({ sql: "insert into users (name, email) values (?, ?)", args: [name, `${name}@x`] })
      await tx.commit()
    }
    // A socket answers its requests in arrival order, so a `BEGIN` that waited would hold up the
    // COMMIT that would release the writer. `TX_BUSY` immediately is the honest answer, and it is
    // why a client that wants concurrent transactions should use the HTTP transport.
    const settled = await Promise.allSettled([one("a"), one("b"), one("c")])
    expect(settled.filter((s) => s.status === "fulfilled").length).toBe(1)
    for (const rejected of settled.filter((s) => s.status === "rejected")) {
      expect((rejected.reason as LibsqlError).code).toBe("TX_BUSY")
    }
    expect((await c.execute("select count(*) as n from users")).rows[0]?.n).toBe(1n)
  })
})

describe("value encoding worth knowing about", () => {
  let c: Client

  beforeAll(async () => {
    await server.createDb("enc", SCHEMA)
    c = client({ url: `http://${hostPort()}/v1/db/enc/`, intMode: "bigint" })
  })

  test("an expression column reports a decltype where libsql-server reports none", async () => {
    // `../../src/server/json.ts` types a column by its declared type, falling back to the storage
    // class of the first non-null cell. libsql-server answers `null` for an expression.
    expect((await c.execute("select 1 + 1 as n")).columnTypes).toEqual(["INTEGER"])
    expect((await c.execute("select 'x' as s")).columnTypes).toEqual(["TEXT"])
  })

  test("an integral REAL in an expression comes back as an integer", async () => {
    // The driver collapses SQLITE_INTEGER and SQLITE_FLOAT into a JS number, so an expression
    // column is told apart by `Number.isInteger`. `docs/r4-hrana.md` records this deviation.
    expect((await c.execute("select 1.0 as x")).rows[0]?.x).toBe(1n)
    expect((await c.execute("select cast(1 as real) as x")).rows[0]?.x).toBe(1n)
    // A non-integral value, and any declared REAL column, are right.
    expect((await c.execute("select 1.5 as x")).rows[0]?.x).toBe(1.5)
    await c.execute({ sql: "insert into vals (id, r) values (1, ?)", args: [1.0] })
    expect((await c.execute("select r from vals where id = 1")).rows[0]?.r).toBe(1)
  })

  test("lastInsertRowid is null when the new rowid repeats the connection's last one", async () => {
    // A known gap, not a client quirk: `src/server/exec.ts` tells an INSERT that inserted from an
    // UPDATE that did not by comparing `sqlite3_last_insert_rowid` either side of the step, so an
    // insert into a second table that happens to get the same rowid reports nothing. Its own
    // database, because the gap is a property of the connection's history.
    await server.createDb("rowid", "create table a (id integer primary key); create table b (id integer primary key)")
    const own = client({ url: `http://${hostPort()}/v1/db/rowid/`, intMode: "bigint" })
    expect((await own.execute("insert into a default values")).lastInsertRowid).toBe(1n)
    expect((await own.execute("insert into b default values")).lastInsertRowid).toBeUndefined()
    expect((await own.execute("insert into a default values")).lastInsertRowid).toBe(2n)
  })
})

describe("a transaction whose client vanished", () => {
  test("is rolled back by the tenant's idle leash", async () => {
    const leashed = await startHrana({ limits: { txIdleTimeoutMs: 250 } })
    await leashed.createDb("app", SCHEMA)
    const c = createClient({
      url: `http://${leashed.url.replace("http://", "")}/v1/db/app/`,
      authToken: leashed.adminKey,
      intMode: "bigint",
    })
    try {
      const tx = await c.transaction("write")
      await tx.execute("insert into users (name, email) values ('ghost', 'ghost@x')")
      await Bun.sleep(700)
      // The leash rolled the transaction back and forgot the session, so the stream's next
      // statement finds no transaction at all.
      expect((await failure(tx.execute("select 1"))).code).toBe("TX_NOT_FOUND")
      expect((await failure(tx.commit())).code).toBe("TX_NOT_FOUND")
      expect((await c.execute("select count(*) as n from users")).rows[0]?.n).toBe(0n)
    } finally {
      c.close()
      await leashed.close()
    }
  })
})
