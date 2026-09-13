// The raw Hrana wire: every request type, the value encodings, the baton, and the rule that a
// failed statement is an entry in a 200 body rather than an HTTP status.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { exec, startHrana, stopAllHrana, V, type TestHrana } from "./harness.ts"
import { hranaService } from "../../src/server/hrana/index.ts"

let server: TestHrana

beforeAll(async () => {
  server = await startHrana()
  await server.createDb(
    "acme",
    "create table users (id integer primary key, name text, score real, note text, data blob)",
  )
  await server.createDb("default", "create table t (id integer primary key, v text)")
})

afterAll(async () => {
  await stopAllHrana()
})

describe("version probes", () => {
  test("GET /v2 and /v3 answer 200 with the version", async () => {
    const v2 = await server.fetch("/v2")
    const v3 = await server.fetch("/v3")
    expect(v2.status).toBe(200)
    expect(await v2.text()).toBe("2")
    expect(v3.status).toBe(200)
    expect(await v3.text()).toBe("3")
  })

  test("the path mount answers too", async () => {
    const response = await server.fetch("/v1/db/acme/v2")
    expect(response.status).toBe(200)
  })
})

describe("execute", () => {
  test("a select comes back as cols, rows and a replication_index", async () => {
    const { status, body } = await server.pipeline({
      baton: null,
      requests: [exec("select 1 as one, 'two' as two"), { type: "close" }],
    })
    expect(status).toBe(200)
    const first = body.results[0]
    expect(first?.type).toBe("ok")
    const result = (first as unknown as { response: { result: Record<string, unknown> } }).response.result
    expect(result.cols).toEqual([
      { name: "one", decltype: "INTEGER" },
      { name: "two", decltype: "TEXT" },
    ])
    expect(result.rows).toEqual([[V.int(1), V.text("two")]])
    expect(result.affected_row_count).toBe(0)
    expect(typeof result.replication_index).toBe("string")
    // The stream was closed by the last request, so there is nothing to come back to.
    expect(body.baton).toBeNull()
  })

  test("an insert reports affected rows and a string last_insert_rowid", async () => {
    const { body } = await server.pipeline(
      {
        baton: null,
        requests: [
          exec("insert into users (name, score) values (?, ?)", [V.text("ann"), V.float(1.5)]),
          { type: "close" },
        ],
      },
      { route: "/v1/db/acme/v2/pipeline" },
    )
    const result = okResult(body, 0)
    expect(result.affected_row_count).toBe(1)
    expect(typeof result.last_insert_rowid).toBe("string")
    expect(Number(result.last_insert_rowid)).toBeGreaterThan(0)
  })

  test("last_insert_rowid is right when the rowid repeats across tables", async () => {
    // `docs/r4-hrana.md` pinned this response with `last_insert_rowid: null`: row 1 of one table
    // and then row 1 of another, on the pooled writer, left the counter reading 1 either side of
    // the second insert. Both are `"1"`, and an UPDATE after them is still null.
    await server.createDb(
      "repeat",
      "create table a (id integer primary key); create table b (id integer primary key)",
    )
    const run = async (sql: string) => {
      const { body } = await server.pipeline(
        { baton: null, requests: [exec(sql), { type: "close" }] },
        { route: "/v1/db/repeat/v2/pipeline" },
      )
      return okResult(body, 0)
    }
    expect((await run("insert into a default values")).last_insert_rowid).toBe("1")
    expect((await run("insert into b default values")).last_insert_rowid).toBe("1")
    expect((await run("insert into a default values")).last_insert_rowid).toBe("2")
    expect((await run("update a set id = id where id = 1")).last_insert_rowid).toBeNull()
  })

  test("named args bind by name, with or without the sigil", async () => {
    const { body } = await server.pipeline(
      {
        baton: null,
        requests: [
          {
            type: "execute",
            stmt: {
              sql: "select :a as a, $b as b",
              named_args: [
                { name: "a", value: V.text("x") },
                { name: "$b", value: V.int(7) },
              ],
            },
          },
          { type: "close" },
        ],
      },
      { route: "/v1/db/acme/v2/pipeline" },
    )
    expect(okResult(body, 0).rows).toEqual([[V.text("x"), V.int(7)]])
  })

  test("want_rows false keeps the columns and drops the rows", async () => {
    const { body } = await server.pipeline(
      {
        baton: null,
        requests: [exec("select 1 as one", undefined, { want_rows: false }), { type: "close" }],
      },
      { route: "/v1/db/acme/v2/pipeline" },
    )
    const result = okResult(body, 0)
    expect(result.cols).toHaveLength(1)
    expect(result.rows).toEqual([])
  })
})

describe("value encodings", () => {
  test("integers survive ±2^53±1 exactly", async () => {
    const big = "9007199254740993" // 2^53 + 1
    const small = "-9007199254740993"
    const { body } = await server.pipeline(
      {
        baton: null,
        requests: [
          exec("insert into users (id, name) values (?, ?)", [V.int(big), V.text("big")]),
          exec("insert into users (id, name) values (?, ?)", [V.int(small), V.text("small")]),
          exec("select id from users where name in ('big','small') order by id"),
          { type: "close" },
        ],
      },
      { route: "/v1/db/acme/v2/pipeline" },
    )
    expect(okResult(body, 2).rows).toEqual([[V.int(small)], [V.int(big)]])
  })

  test("2^53 exactly still reports as an integer", async () => {
    const { body } = await server.pipeline(
      { baton: null, requests: [exec("select 9007199254740992"), { type: "close" }] },
      { route: "/v1/db/acme/v2/pipeline" },
    )
    expect(okResult(body, 0).rows).toEqual([[V.int("9007199254740992")]])
  })

  test("blobs round-trip as base64, and an empty blob is not a null", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    const base64 = Buffer.from(bytes).toString("base64")
    const { body } = await server.pipeline(
      {
        baton: null,
        requests: [
          exec("insert into users (name, data) values (?, ?)", [V.text("blob"), V.blob(base64)]),
          exec("insert into users (name, data) values (?, ?)", [V.text("empty"), V.blob("")]),
          exec("select data from users where name = 'blob'"),
          exec("select data, typeof(data) from users where name = 'empty'"),
          { type: "close" },
        ],
      },
      { route: "/v1/db/acme/v2/pipeline" },
    )
    expect(okResult(body, 2).rows).toEqual([[V.blob(base64)]])
    expect(okResult(body, 3).rows).toEqual([[V.blob(""), V.text("blob")]])
  })

  test("nulls, floats and a REAL column that holds a whole number", async () => {
    const { body } = await server.pipeline(
      {
        baton: null,
        requests: [
          exec("insert into users (name, score, note) values (?, ?, ?)", [
            V.text("f"),
            V.float(2.5),
            V.null,
          ]),
          exec("insert into users (name, score) values (?, ?)", [V.text("whole"), V.float(3)]),
          exec("select score, note from users where name = 'f'"),
          // `score` is declared REAL, so its affinity says float even though the value is whole.
          exec("select score from users where name = 'whole'"),
          { type: "close" },
        ],
      },
      { route: "/v1/db/acme/v2/pipeline" },
    )
    expect(okResult(body, 2).rows).toEqual([[V.float(2.5), V.null]])
    expect(okResult(body, 3).rows).toEqual([[V.float(3)]])
  })

  test("an undeclared expression column reports a decltype of null", async () => {
    const { body } = await server.pipeline(
      { baton: null, requests: [exec("select null as nada"), { type: "close" }] },
      { route: "/v1/db/acme/v2/pipeline" },
    )
    expect(okResult(body, 0).cols).toEqual([{ name: "nada", decltype: null }])
    expect(okResult(body, 0).rows).toEqual([[V.null]])
  })
})

describe("store_sql, describe, sequence and get_autocommit", () => {
  test("a stored SQL text is reusable by id and refused after close_sql", async () => {
    const first = await server.pipeline(
      {
        baton: null,
        requests: [
          { type: "store_sql", sql_id: 1, sql: "select ? as echo" },
          { type: "execute", stmt: { sql_id: 1, args: [V.text("hi")] } },
        ],
      },
      { route: "/v1/db/acme/v2/pipeline" },
    )
    expect(okResult(first.body, 1).rows).toEqual([[V.text("hi")]])

    const second = await server.pipeline(
      {
        baton: first.body.baton,
        requests: [
          { type: "close_sql", sql_id: 1 },
          { type: "execute", stmt: { sql_id: 1 } },
          { type: "close" },
        ],
      },
      { route: "/v1/db/acme/v2/pipeline" },
    )
    expect(second.body.results[0]?.type).toBe("ok")
    expect(second.body.results[1]?.type).toBe("error")
  })

  test("describe reports params, cols and readonly without running anything", async () => {
    const { body } = await server.pipeline(
      {
        baton: null,
        requests: [
          { type: "describe", sql: "select id, name from users where id = :id and name = ?" },
          { type: "describe", sql: "explain select 1" },
          { type: "close" },
        ],
      },
      { route: "/v1/db/acme/v2/pipeline" },
    )
    const described = okField(body, 0) as {
      params: { name: string | null }[]
      cols: { name: string; decltype: string | null }[]
      is_explain: boolean
      is_readonly: boolean
    }
    expect(described.params).toEqual([{ name: ":id" }, { name: null }])
    expect(described.cols).toEqual([
      { name: "id", decltype: "INTEGER" },
      { name: "name", decltype: "TEXT" },
    ])
    expect(described.is_explain).toBe(false)
    expect(described.is_readonly).toBe(true)
    expect((okField(body, 1) as { is_explain: boolean }).is_explain).toBe(true)
  })

  test("sequence runs every statement, including a trigger body full of semicolons", async () => {
    await server.createDb("seq")
    const script = `
      create table a (id integer primary key, v text);
      create table log (what text);
      create trigger a_ins after insert on a begin
        insert into log (what) values ('ins');
        insert into log (what) values ('again');
      end;
      insert into a (v) values ('one'); -- a trailing comment
      /* and a block one; with a semicolon */
      insert into a (v) values ('two');
    `
    const { body } = await server.pipeline(
      {
        baton: null,
        requests: [
          { type: "sequence", sql: script },
          { type: "execute", stmt: { sql: "select count(*) from a" } },
          { type: "execute", stmt: { sql: "select count(*) from log" } },
          { type: "close" },
        ],
      },
      { route: "/v1/db/seq/v2/pipeline" },
    )
    expect(body.results[0]).toEqual({ type: "ok", response: { type: "sequence" } })
    expect(okResult(body, 1).rows).toEqual([[V.int(2)]])
    expect(okResult(body, 2).rows).toEqual([[V.int(4)]])
  })

  test("get_autocommit follows the stream's transaction", async () => {
    const first = await server.pipeline(
      {
        baton: null,
        requests: [{ type: "get_autocommit" }, exec("begin"), { type: "get_autocommit" }],
      },
      { route: "/v1/db/acme/v2/pipeline" },
    )
    expect(okField(first.body, 0)).toBeUndefined()
    expect((first.body.results[0] as { response: { is_autocommit: boolean } }).response.is_autocommit).toBe(true)
    expect((first.body.results[2] as { response: { is_autocommit: boolean } }).response.is_autocommit).toBe(false)

    const second = await server.pipeline(
      { baton: first.body.baton, requests: [exec("rollback"), { type: "close" }] },
      { route: "/v1/db/acme/v2/pipeline" },
    )
    expect(second.body.results[0]?.type).toBe("ok")
  })
})

describe("errors", () => {
  test("a failing statement is an entry in a 200 body and the pipeline goes on", async () => {
    const { status, body } = await server.pipeline(
      {
        baton: null,
        requests: [
          exec("select * from nope"),
          exec("select 1 as after_the_error"),
          { type: "close" },
        ],
      },
      { route: "/v1/db/acme/v2/pipeline" },
    )
    expect(status).toBe(200)
    expect(body.results[0]?.type).toBe("error")
    const error = (body.results[0] as { error: { message: string; code: string } }).error
    expect(error.code).toBe("SQLITE_ERROR")
    expect(error.message).toContain("nope")
    // Every request runs, even after one failed.
    expect(okResult(body, 1).rows).toEqual([[V.int(1)]])
  })

  test("a unique violation keeps its SQLite code", async () => {
    await server.createDb("uniq", "create table u (id integer primary key, e text unique)")
    const { body } = await server.pipeline(
      {
        baton: null,
        requests: [
          exec("insert into u (e) values ('a')"),
          exec("insert into u (e) values ('a')"),
          { type: "close" },
        ],
      },
      { route: "/v1/db/uniq/v2/pipeline" },
    )
    expect((body.results[1] as { error: { code: string } }).error.code).toBe(
      "SQLITE_CONSTRAINT_UNIQUE",
    )
  })

  test("no token is a 401 with a bare {message, code} body and an exact content type", async () => {
    const response = await server.fetch("/v1/db/acme/v2/pipeline", {
      method: "POST",
      token: null,
      body: JSON.stringify({ baton: null, requests: [] }),
    })
    expect(response.status).toBe(401)
    expect(response.headers.get("content-type")).toBe("application/json")
    const body = (await response.json()) as { message: string; code: string }
    expect(body.code).toBe("UNAUTHENTICATED")
    expect(body).not.toHaveProperty("error")
  })

  test("an unknown database is a 404, not a stream that fails later", async () => {
    const { status, body } = await server.pipeline(
      { baton: null, requests: [exec("select 1")] },
      { route: "/v1/db/ghost/v2/pipeline" },
    )
    expect(status).toBe(404)
    expect((body as unknown as { code: string }).code).toBe("DB_NOT_FOUND")
  })

  test("the node's row cap applies to Hrana exactly as it does to the native path", async () => {
    const capped = await startHrana({ limits: { maxRows: 2 } })
    try {
      await capped.createDb("small", "create table r (id integer primary key)")
      const { body } = await capped.pipeline(
        {
          baton: null,
          requests: [
            exec("insert into r (id) values (1), (2), (3)"),
            exec("select id from r"),
            { type: "close" },
          ],
        },
        { route: "/v1/db/small/v2/pipeline" },
      )
      expect(body.results[1]?.type).toBe("error")
      expect((body.results[1] as { error: { code: string } }).error.code).toBe("TOO_MANY_ROWS")
    } finally {
      await capped.close()
    }
  })

  test("a body that is not JSON is a 400", async () => {
    const response = await server.fetch("/v1/db/acme/v2/pipeline", {
      method: "POST",
      body: "{not json",
      headers: { "content-type": "application/json" },
    })
    expect(response.status).toBe(400)
  })
})

describe("batons", () => {
  test("a baton rotates, and the one just used is refused", async () => {
    const first = await server.pipeline(
      { baton: null, requests: [exec("select 1")] },
      { route: "/v1/db/acme/v2/pipeline" },
    )
    expect(typeof first.body.baton).toBe("string")

    const second = await server.pipeline(
      { baton: first.body.baton, requests: [exec("select 2")] },
      { route: "/v1/db/acme/v2/pipeline" },
    )
    expect(second.status).toBe(200)
    expect(second.body.baton).not.toBe(first.body.baton)

    const replayed = await server.pipeline(
      { baton: first.body.baton, requests: [exec("select 3")] },
      { route: "/v1/db/acme/v2/pipeline" },
    )
    expect(replayed.status).toBe(400)
    expect((replayed.body as unknown as { message: string }).message).toContain("superseded")
  })

  test("a forged baton is refused", async () => {
    const real = await server.pipeline(
      { baton: null, requests: [exec("select 1")] },
      { route: "/v1/db/acme/v2/pipeline" },
    )
    const forged = `${(real.body.baton as string).split(".").slice(0, 3).join(".")}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
    const response = await server.pipeline(
      { baton: forged, requests: [exec("select 1")] },
      { route: "/v1/db/acme/v2/pipeline" },
    )
    expect(response.status).toBe(400)
    expect((response.body as unknown as { message: string }).message).toContain("not one this server issued")
  })

  test("a baton from one database cannot be used on another", async () => {
    const first = await server.pipeline(
      { baton: null, requests: [exec("select 1")] },
      { route: "/v1/db/acme/v2/pipeline" },
    )
    const response = await server.pipeline(
      { baton: first.body.baton, requests: [exec("select 1")] },
      { route: "/v1/db/default/v2/pipeline" },
    )
    expect(response.status).toBe(400)
    expect((response.body as unknown as { message: string }).message).toContain("different database")
  })

  test("a closed stream's baton is gone", async () => {
    const first = await server.pipeline(
      { baton: null, requests: [exec("select 1"), { type: "close" }] },
      { route: "/v1/db/acme/v2/pipeline" },
    )
    expect(first.body.baton).toBeNull()
    expect(first.body.results[1]).toEqual({ type: "ok", response: { type: "close" } })
  })

  test("requests after a close in the same pipeline fail", async () => {
    const { body } = await server.pipeline(
      { baton: null, requests: [{ type: "close" }, exec("select 1")] },
      { route: "/v1/db/acme/v2/pipeline" },
    )
    expect(body.results[0]?.type).toBe("ok")
    expect(body.results[1]?.type).toBe("error")
  })

  test("an idle stream is swept, and its baton stops working", async () => {
    const first = await server.pipeline(
      { baton: null, requests: [exec("select 1")] },
      { route: "/v1/db/acme/v2/pipeline" },
    )
    // The sweep is time-based; ask it to run as if a minute had passed rather than waiting one.
    hranaService(server.runtime).sweep(Date.now() + 120_000)
    const response = await server.pipeline(
      { baton: first.body.baton, requests: [exec("select 1")] },
      { route: "/v1/db/acme/v2/pipeline" },
    )
    expect(response.status).toBe(400)
    expect((response.body as unknown as { message: string }).message).toContain("has ended")
  })
})

describe("namespace selection", () => {
  test("x-namespace picks the database at the root mount", async () => {
    const { body } = await server.pipeline(
      { baton: null, requests: [exec("select count(*) from t"), { type: "close" }] },
      { headers: { "x-namespace": "default" } },
    )
    expect(body.results[0]?.type).toBe("ok")
  })

  test("with neither header nor a subdomain the namespace is `default`", async () => {
    const { body } = await server.pipeline({
      baton: null,
      requests: [exec("select count(*) from t"), { type: "close" }],
    })
    expect(body.results[0]?.type).toBe("ok")
  })

  test("the first Host label wins when the host looks like a domain", async () => {
    const response = await fetch(`${server.url}/v2/pipeline`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.adminKey}`,
        "content-type": "application/json",
        host: "acme.sql.example.com",
      },
      body: JSON.stringify({ baton: null, requests: [exec("select count(*) from users"), { type: "close" }] }),
    })
    const body = (await response.json()) as { results: { type: string }[] }
    expect(response.status).toBe(200)
    expect(body.results[0]?.type).toBe("ok")
  })
})

// ── helpers ────────────────────────────────────────────────────────────────────────────────────

function okResult(body: { results: unknown[] }, at: number): Record<string, never> & {
  cols: { name: string | null; decltype: string | null }[]
  rows: unknown[][]
  affected_row_count: number
  last_insert_rowid: string | null
  replication_index?: string
} {
  const entry = body.results[at] as { type: string; response?: { result?: unknown }; error?: unknown }
  if (entry?.type !== "ok") throw new Error(`results[${at}] is ${JSON.stringify(entry)}`)
  return entry.response?.result as never
}

function okField(body: { results: unknown[] }, at: number): unknown {
  const entry = body.results[at] as { type: string; response?: { result?: unknown } }
  if (entry?.type !== "ok") throw new Error(`results[${at}] is ${JSON.stringify(entry)}`)
  return entry.response?.result
}
