// `@libsql/client` is not a dependency of this repo (see `docs/r4-hrana.md`, "Not covered"), so
// this file is the next best thing: a client that emits the exact request sequences
// `@libsql/client@0.15` + `@libsql/hrana-client@0.7` emit, decoded with their exact decoding
// rules. Every shape here was read out of those packages' sources rather than guessed:
//
//  - the pipeline URL is `new URL("v2/pipeline", baseUrl)`, resolved *relatively*;
//  - `execute` and the trailing `close` are flushed as one pipeline;
//  - `batch(mode)` is one `batch` request whose steps are `BEGIN`, each statement conditioned on
//    the previous step, `COMMIT`, and a `ROLLBACK` conditioned on the commit not being ok;
//  - `transaction()` is `BEGIN IMMEDIATE` as an ordinary `execute`, the stream kept by its baton;
//  - `executeMultiple` is `sequence`;
//  - a JS number is encoded as `{"type":"float"}`, a bigint as `{"type":"integer"}`;
//  - an `integer` comes back as a decimal string and becomes a JS number under the default
//    `intMode: "number"`, which throws when the value does not fit.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { startHrana, stopAllHrana, type TestHrana } from "./harness.ts"
import type { HranaValue, PipelineRespBody, StreamRequest } from "../../src/server/hrana/proto.ts"

let server: TestHrana

beforeAll(async () => {
  server = await startHrana()
  await server.createDb(
    "app",
    `create table users (id integer primary key, name text not null, email text unique);
     create table posts (id integer primary key, user_id integer, title text)`,
  )
})

afterAll(async () => {
  await stopAllHrana()
})

// ── the client ─────────────────────────────────────────────────────────────────────────────────

type InValue = null | string | number | bigint | Uint8Array | boolean
type OutValue = null | string | number | bigint | Uint8Array

class LibsqlError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message)
    this.name = "LibsqlError"
  }
}

interface ResultSet {
  columns: string[]
  columnTypes: (string | null)[]
  rows: Record<string, OutValue>[]
  rowsAffected: number
  lastInsertRowid: bigint | undefined
}

function valueToProto(value: InValue): HranaValue {
  if (value === null || value === undefined) return { type: "null" }
  if (typeof value === "bigint") return { type: "integer", value: String(value) }
  if (typeof value === "boolean") return { type: "integer", value: value ? "1" : "0" }
  if (typeof value === "number") return { type: "float", value }
  if (typeof value === "string") return { type: "text", value }
  return { type: "blob", base64: Buffer.from(value).toString("base64") }
}

/** `hrana-client`'s decoder plus `@libsql/client`'s default `intMode: "number"`. */
function valueFromProto(value: HranaValue): OutValue {
  switch (value.type) {
    case "null":
      return null
    case "integer": {
      const big = BigInt(value.value)
      if (big < Number.MIN_SAFE_INTEGER || big > Number.MAX_SAFE_INTEGER) {
        throw new RangeError(`integer ${big} is too large for intMode "number"`)
      }
      return Number(big)
    }
    case "float":
      if (typeof value.value !== "number") throw new TypeError("float value must be a number")
      return value.value
    case "text":
      return value.value
    case "blob":
      return Uint8Array.from(Buffer.from(value.base64, "base64"))
    default:
      throw new TypeError(`unexpected value ${JSON.stringify(value)}`)
  }
}

interface Statement {
  sql: string
  args?: InValue[]
}

function stmtToHrana(statement: Statement | string): StreamRequest {
  const one = typeof statement === "string" ? { sql: statement } : statement
  return {
    type: "execute",
    stmt: {
      sql: one.sql,
      args: (one.args ?? []).map(valueToProto),
      want_rows: true,
    },
  }
}

/** Enough of `@libsql/client`'s HTTP client to prove the server answers it. */
class Client {
  #baseUrl: URL
  #baton: string | null = null
  #token: string

  constructor(baseUrl: string, token: string) {
    // `encodeBaseUrl` does *not* add a trailing slash; a path mount therefore needs one in the URL
    // the user wrote, because the pipeline path is resolved relatively.
    this.#baseUrl = new URL(baseUrl)
    this.#token = token
  }

  get baton(): string | null {
    return this.#baton
  }

  async #send(requests: StreamRequest[], keepStream: boolean): Promise<PipelineRespBody> {
    const url = new URL("v2/pipeline", this.#baseUrl)
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.#token}` },
      body: JSON.stringify({ baton: this.#baton, requests }),
    })
    if (!response.ok) {
      if (response.headers.get("content-type") === "application/json") {
        const body = (await response.json()) as { message: string; code?: string }
        throw new LibsqlError(body.message, body.code)
      }
      throw new LibsqlError(`Server returned HTTP status ${response.status}`, "SERVER_ERROR")
    }
    const body = (await response.json()) as PipelineRespBody
    this.#baton = keepStream ? body.baton : null
    return body
  }

  #resultSet(result: {
    cols: { name: string | null; decltype: string | null }[]
    rows: HranaValue[][]
    affected_row_count: number
    last_insert_rowid: string | null
  }): ResultSet {
    const columns = result.cols.map((c) => c.name ?? "")
    return {
      columns,
      columnTypes: result.cols.map((c) => c.decltype),
      rows: result.rows.map((row) => {
        const out: Record<string, OutValue> = {}
        row.forEach((cell, i) => {
          out[columns[i] as string] = valueFromProto(cell)
        })
        return out
      }),
      rowsAffected: result.affected_row_count,
      lastInsertRowid:
        result.last_insert_rowid !== null ? BigInt(result.last_insert_rowid) : undefined,
    }
  }

  #unwrap(entry: PipelineRespBody["results"][number]): unknown {
    if (entry.type === "error") throw new LibsqlError(entry.error.message, entry.error.code ?? undefined)
    return (entry.response as { result?: unknown }).result
  }

  /** One statement, then the stream is closed — the shape a bare `client.execute()` sends. */
  async execute(statement: Statement | string): Promise<ResultSet> {
    const body = await this.#send([stmtToHrana(statement), { type: "close" }], false)
    return this.#resultSet(this.#unwrap(body.results[0] as never) as never)
  }

  /** `batch(stmts, "write")`. */
  async batch(statements: (Statement | string)[]): Promise<ResultSet[]> {
    const steps: unknown[] = [{ stmt: { sql: "BEGIN IMMEDIATE" } }]
    statements.forEach((statement, i) => {
      const one = typeof statement === "string" ? { sql: statement } : statement
      steps.push({
        condition: { type: "ok", step: i },
        stmt: { sql: one.sql, args: (one.args ?? []).map(valueToProto), want_rows: true },
      })
    })
    const commitStep = steps.length
    steps.push({ condition: { type: "ok", step: commitStep - 1 }, stmt: { sql: "COMMIT" } })
    steps.push({
      condition: { type: "not", cond: { type: "ok", step: commitStep } },
      stmt: { sql: "ROLLBACK" },
    })

    const body = await this.#send(
      [{ type: "batch", batch: { steps } } as never, { type: "close" }],
      false,
    )
    const result = this.#unwrap(body.results[0] as never) as {
      step_results: (never | null)[]
      step_errors: ({ message: string; code?: string } | null)[]
    }
    // The client raises the first step error it finds, exactly like this.
    for (const error of result.step_errors) {
      if (error) throw new LibsqlError(error.message, error.code ?? undefined)
    }
    return statements.map((_, i) => this.#resultSet(result.step_results[i + 1] as never))
  }

  /** `transaction("write")`: BEGIN on its own request, the stream kept by its baton. */
  async transaction(): Promise<Transaction> {
    await this.#send([{ type: "execute", stmt: { sql: "BEGIN IMMEDIATE" } }], true)
    return new Transaction(this)
  }

  /** `executeMultiple`: one `sequence`. */
  async executeMultiple(sql: string): Promise<void> {
    const body = await this.#send([{ type: "sequence", sql } as never, { type: "close" }], false)
    this.#unwrap(body.results[0] as never)
  }

  /** @internal */
  async _inStream(requests: StreamRequest[], keepStream: boolean): Promise<PipelineRespBody> {
    return this.#send(requests, keepStream)
  }

  /** @internal */
  _rows(result: never): ResultSet {
    return this.#resultSet(result)
  }

  /** @internal */
  _unwrapEntry(entry: PipelineRespBody["results"][number]): unknown {
    return this.#unwrap(entry)
  }
}

class Transaction {
  constructor(private readonly client: Client) {}

  async execute(statement: Statement | string): Promise<ResultSet> {
    const body = await this.client._inStream([stmtToHrana(statement)], true)
    return this.client._rows(this.client._unwrapEntry(body.results[0] as never) as never)
  }

  async commit(): Promise<void> {
    const body = await this.client._inStream(
      [{ type: "execute", stmt: { sql: "COMMIT" } }, { type: "close" }],
      false,
    )
    this.client._unwrapEntry(body.results[0] as never)
  }

  async rollback(): Promise<void> {
    const body = await this.client._inStream(
      [{ type: "execute", stmt: { sql: "ROLLBACK" } }, { type: "close" }],
      false,
    )
    this.client._unwrapEntry(body.results[0] as never)
  }
}

// ── the tests ──────────────────────────────────────────────────────────────────────────────────

function client(path = "/v1/db/app/"): Client {
  return new Client(`${server.url}${path}`, server.adminKey)
}

describe("@libsql/client over the path mount", () => {
  test("the relative pipeline path lands on our route when the base URL ends in a slash", () => {
    expect(new URL("v2/pipeline", "http://host/v1/db/app/").pathname).toBe("/v1/db/app/v2/pipeline")
    // And the documented trap: without the slash it resolves one segment up.
    expect(new URL("v2/pipeline", "http://host/v1/db/app").pathname).toBe("/v1/db/v2/pipeline")
  })

  test("execute with args, and a result set the client can read", async () => {
    const db = client()
    const inserted = await db.execute({
      sql: "insert into users (name, email) values (?, ?)",
      args: ["ann", "ann@example.com"],
    })
    expect(inserted.rowsAffected).toBe(1)
    expect(typeof inserted.lastInsertRowid).toBe("bigint")

    const selected = await db.execute("select id, name, email from users order by id")
    expect(selected.columns).toEqual(["id", "name", "email"])
    expect(selected.columnTypes).toEqual(["INTEGER", "TEXT", "TEXT"])
    expect(selected.rows).toEqual([{ id: 1, name: "ann", email: "ann@example.com" }])
  })

  test("a failing statement raises a LibsqlError with a meaningful code", async () => {
    const db = client()
    await db.execute({
      sql: "insert into users (name, email) values (?, ?)",
      args: ["bob", "bob@example.com"],
    })
    let raised: LibsqlError | null = null
    try {
      await db.execute({
        sql: "insert into users (name, email) values (?, ?)",
        args: ["bob2", "bob@example.com"],
      })
    } catch (err) {
      raised = err as LibsqlError
    }
    expect(raised).not.toBeNull()
    expect(raised?.code).toBe("SQLITE_CONSTRAINT_UNIQUE")
    expect(raised?.message).toContain("users.email")
  })

  test("batch commits as one transaction and returns one result per statement", async () => {
    const db = client()
    const results = await db.batch([
      { sql: "insert into posts (user_id, title) values (?, ?)", args: [1, "first"] },
      { sql: "insert into posts (user_id, title) values (?, ?)", args: [1, "second"] },
      "select count(*) as n from posts",
    ])
    expect(results).toHaveLength(3)
    expect(results[0]?.rowsAffected).toBe(1)
    expect(results[2]?.rows).toEqual([{ n: 2 }])
  })

  test("a batch that fails raises and leaves nothing behind", async () => {
    const db = client()
    await expect(
      db.batch([
        { sql: "insert into posts (user_id, title) values (?, ?)", args: [1, "kept?"] },
        "insert into posts (nope) values (1)",
      ]),
    ).rejects.toThrow()
    const after = await db.execute("select count(*) as n from posts where title = 'kept?'")
    expect(after.rows).toEqual([{ n: 0 }])
  })

  test("an interactive transaction commits", async () => {
    const db = client()
    const tx = await db.transaction()
    await tx.execute({ sql: "insert into users (name) values (?)", args: ["carla"] })
    await tx.execute({ sql: "insert into users (name) values (?)", args: ["dan"] })
    await tx.commit()
    const after = await db.execute("select count(*) as n from users where name in ('carla','dan')")
    expect(after.rows).toEqual([{ n: 2 }])
  })

  test("an interactive transaction rolls back", async () => {
    const db = client()
    const tx = await db.transaction()
    await tx.execute({ sql: "insert into users (name) values (?)", args: ["ghost"] })
    await tx.rollback()
    const after = await db.execute("select count(*) as n from users where name = 'ghost'")
    expect(after.rows).toEqual([{ n: 0 }])
  })

  test("executeMultiple runs a migration script", async () => {
    await server.createDb("migrated")
    const db = client("/v1/db/migrated/")
    await db.executeMultiple(`
      CREATE TABLE __drizzle_migrations (id integer primary key, hash text, created_at numeric);
      CREATE TABLE widgets (id integer primary key autoincrement, label text not null);
      CREATE UNIQUE INDEX widgets_label ON widgets (label);
    `)
    await db.execute({ sql: "insert into widgets (label) values (?)", args: ["one"] })
    const rows = await db.execute("select label from widgets")
    expect(rows.rows).toEqual([{ label: "one" }])
  })

  test("blobs and floats survive the client's own codec", async () => {
    await server.createDb("codec", "create table c (id integer primary key, b blob, f real)")
    const db = client("/v1/db/codec/")
    const bytes = Uint8Array.from([1, 2, 3, 250])
    await db.execute({ sql: "insert into c (b, f) values (?, ?)", args: [bytes, 1.25] })
    const rows = await db.execute("select b, f from c")
    expect(Array.from(rows.rows[0]?.b as Uint8Array)).toEqual([1, 2, 3, 250])
    expect(rows.rows[0]?.f).toBe(1.25)
  })

  test("an integer past 2^53 reaches the client intact, and its own intMode is what refuses it", async () => {
    await server.createDb("bigints", "create table b (id integer primary key, v integer)")
    const db = client("/v1/db/bigints/")
    await db.execute({ sql: "insert into b (v) values (?)", args: [9007199254740993n] })
    // `intMode: "number"` is the client's default and throws; the wire value was exact.
    await expect(db.execute("select v from b")).rejects.toThrow(/too large/)
    const raw = await server.pipeline(
      { baton: null, requests: [{ type: "execute", stmt: { sql: "select v from b" } } as never] },
      { route: "/v1/db/bigints/v2/pipeline" },
    )
    expect(
      (raw.body.results[0] as { response: { result: { rows: HranaValue[][] } } }).response.result.rows,
    ).toEqual([[{ type: "integer", value: "9007199254740993" }]])
  })
})

describe("@libsql/client over the root mount", () => {
  test("x-namespace addressing works without a path", async () => {
    await server.createDb("tenant7", "create table k (v text)")
    const url = new URL("v2/pipeline", `${server.url}/`)
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${server.adminKey}`,
        "x-namespace": "tenant7",
      },
      body: JSON.stringify({
        baton: null,
        requests: [
          { type: "execute", stmt: { sql: "insert into k (v) values ('x')", args: [] } },
          { type: "execute", stmt: { sql: "select v from k" } },
          { type: "close" },
        ],
      }),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as PipelineRespBody
    expect(
      (body.results[1] as { response: { result: { rows: HranaValue[][] } } }).response.result.rows,
    ).toEqual([[{ type: "text", value: "x" }]])
  })
})

describe("a read-only token is read-only through Hrana too", () => {
  test("select works and insert is refused with NOT_AUTHORIZED", async () => {
    const minted = await server.fetch("/v1/tokens", {
      method: "POST",
      body: JSON.stringify({ dbs: ["app"], scope: "ro" }),
    })
    expect(minted.status).toBe(201)
    const { token } = (await minted.json()) as { token: string }

    const read = await server.pipeline(
      { baton: null, requests: [{ type: "execute", stmt: { sql: "select 1" } } as never] },
      { route: "/v1/db/app/v2/pipeline", token },
    )
    expect(read.body.results[0]?.type).toBe("ok")

    const write = await server.pipeline(
      {
        baton: null,
        requests: [
          { type: "execute", stmt: { sql: "insert into users (name) values ('nope')" } } as never,
          { type: "close" },
        ],
      },
      { route: "/v1/db/app/v2/pipeline", token },
    )
    expect(write.body.results[0]?.type).toBe("error")
    expect((write.body.results[0] as { error: { code: string } }).error.code).toBe("NOT_AUTHORIZED")
  })

  test("a token with no grant on a database cannot tell whether it exists", async () => {
    const minted = await server.fetch("/v1/tokens", {
      method: "POST",
      body: JSON.stringify({ dbs: ["app"], scope: "ro" }),
    })
    const { token } = (await minted.json()) as { token: string }
    const other = await server.pipeline(
      { baton: null, requests: [{ type: "execute", stmt: { sql: "select 1" } } as never] },
      { route: "/v1/db/codec/v2/pipeline", token },
    )
    expect(other.status).toBe(403)
    const missing = await server.pipeline(
      { baton: null, requests: [{ type: "execute", stmt: { sql: "select 1" } } as never] },
      { route: "/v1/db/no-such-db/v2/pipeline", token },
    )
    expect(missing.status).toBe(403)
  })
})
