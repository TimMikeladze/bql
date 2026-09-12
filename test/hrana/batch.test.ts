// Conditional batches: the shape `@libsql/client` turns `batch()` and `transaction()` into, and
// the rollback path that only fires when the commit did not.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { startHrana, stopAllHrana, V, type TestHrana } from "./harness.ts"
import type { HranaBatchStep } from "../../src/server/hrana/proto.ts"

let server: TestHrana
const ROUTE = "/v1/db/shop/v2/pipeline"

beforeAll(async () => {
  server = await startHrana()
  await server.createDb(
    "shop",
    "create table items (id integer primary key, name text unique, qty integer)",
  )
})

afterAll(async () => {
  await stopAllHrana()
})

/** Exactly what `@libsql/client` builds for `batch(stmts, "write")`. */
function clientBatch(statements: { sql: string; args?: unknown[] }[]): HranaBatchStep[] {
  const steps: HranaBatchStep[] = [{ stmt: { sql: "BEGIN IMMEDIATE" } }]
  statements.forEach((statement, i) => {
    steps.push({
      condition: { type: "ok", step: i },
      stmt: { sql: statement.sql, ...(statement.args ? { args: statement.args } : {}) } as never,
    })
  })
  const commitStep = steps.length
  steps.push({ condition: { type: "ok", step: commitStep - 1 }, stmt: { sql: "COMMIT" } })
  steps.push({
    condition: { type: "not", cond: { type: "ok", step: commitStep } },
    stmt: { sql: "ROLLBACK" },
  })
  return steps
}

async function runBatch(steps: HranaBatchStep[], baton: string | null = null) {
  const { status, body } = await server.pipeline(
    {
      baton,
      requests: [{ type: "batch", batch: { steps } } as never, { type: "close" }],
    },
    { route: ROUTE },
  )
  const entry = body.results[0] as {
    type: string
    response?: { result: { step_results: unknown[]; step_errors: unknown[] } }
    error?: unknown
  }
  if (entry.type !== "ok") throw new Error(`batch failed: ${JSON.stringify(entry.error)}`)
  return { status, result: entry.response?.result as { step_results: unknown[]; step_errors: unknown[] } }
}

describe("conditional batches", () => {
  test("a client-shaped transaction commits and the rollback step is skipped", async () => {
    const { result } = await runBatch(
      clientBatch([
        { sql: "insert into items (name, qty) values (?, ?)", args: [V.text("nail"), V.int(10)] },
        { sql: "insert into items (name, qty) values (?, ?)", args: [V.text("screw"), V.int(4)] },
      ]),
    )
    // BEGIN, two inserts, COMMIT all ran; ROLLBACK was skipped, so it is null in both arrays.
    expect(result.step_results.map((r) => r !== null)).toEqual([true, true, true, true, false])
    expect(result.step_errors).toEqual([null, null, null, null, null])

    const { body } = await server.pipeline(
      {
        baton: null,
        requests: [
          { type: "execute", stmt: { sql: "select count(*) from items" } } as never,
          { type: "close" },
        ],
      },
      { route: ROUTE },
    )
    expect((body.results[0] as { response: { result: { rows: unknown[][] } } }).response.result.rows).toEqual([
      [V.int(2)],
    ])
  })

  test("a failing step skips the rest and fires the rollback, leaving nothing behind", async () => {
    const { result } = await runBatch(
      clientBatch([
        { sql: "insert into items (name, qty) values (?, ?)", args: [V.text("bolt"), V.int(1)] },
        // `nail` is already there and the column is unique: this is the step that fails.
        { sql: "insert into items (name, qty) values (?, ?)", args: [V.text("nail"), V.int(1)] },
      ]),
    )
    expect(result.step_results[0]).not.toBeNull() // BEGIN
    expect(result.step_results[1]).not.toBeNull() // first insert
    expect(result.step_errors[2]).not.toBeNull() // second insert failed
    expect(result.step_results[3]).toBeNull() // COMMIT skipped: its condition was ok(step 2)
    expect(result.step_errors[3]).toBeNull()
    expect(result.step_results[4]).not.toBeNull() // ROLLBACK ran
    expect((result.step_errors[2] as { code: string }).code).toBe("SQLITE_CONSTRAINT_UNIQUE")

    const { body } = await server.pipeline(
      {
        baton: null,
        requests: [
          { type: "execute", stmt: { sql: "select name from items where name = 'bolt'" } } as never,
          { type: "close" },
        ],
      },
      { route: ROUTE },
    )
    expect((body.results[0] as { response: { result: { rows: unknown[][] } } }).response.result.rows).toEqual([])
  })

  test("an `error` condition fires only after a failure", async () => {
    const { result } = await runBatch([
      { stmt: { sql: "select 1" } },
      { condition: { type: "error", step: 0 }, stmt: { sql: "select 'never'" } },
      { stmt: { sql: "select * from missing_table" } },
      { condition: { type: "error", step: 2 }, stmt: { sql: "select 'recovered'" } },
    ] as HranaBatchStep[])
    expect(result.step_results[1]).toBeNull()
    expect(result.step_errors[2]).not.toBeNull()
    expect((result.step_results[3] as { rows: unknown[][] }).rows).toEqual([[V.text("recovered")]])
  })

  test("and / or / is_autocommit conditions", async () => {
    const { result } = await runBatch([
      { stmt: { sql: "select 1" } },
      { stmt: { sql: "select * from missing_table" } },
      {
        condition: { type: "and", conds: [{ type: "ok", step: 0 }, { type: "error", step: 1 }] },
        stmt: { sql: "select 'and'" },
      },
      {
        condition: { type: "or", conds: [{ type: "error", step: 0 }, { type: "ok", step: 0 }] },
        stmt: { sql: "select 'or'" },
      },
      { condition: { type: "is_autocommit" }, stmt: { sql: "select 'autocommit'" } },
      { stmt: { sql: "BEGIN" } },
      { condition: { type: "is_autocommit" }, stmt: { sql: "select 'still autocommit'" } },
      { stmt: { sql: "ROLLBACK" } },
    ] as HranaBatchStep[])
    expect((result.step_results[2] as { rows: unknown[][] }).rows).toEqual([[V.text("and")]])
    expect((result.step_results[3] as { rows: unknown[][] }).rows).toEqual([[V.text("or")]])
    expect((result.step_results[4] as { rows: unknown[][] }).rows).toEqual([[V.text("autocommit")]])
    // Step 6 runs inside the transaction step 5 opened, so `is_autocommit` is false and it is
    // skipped.
    expect(result.step_results[6]).toBeNull()
  })

  test("a condition naming a later step is refused outright", async () => {
    const { body } = await server.pipeline(
      {
        baton: null,
        requests: [
          {
            type: "batch",
            batch: {
              steps: [
                { condition: { type: "ok", step: 1 }, stmt: { sql: "select 1" } },
                { stmt: { sql: "select 2" } },
              ],
            },
          } as never,
          { type: "close" },
        ],
      },
      { route: ROUTE },
    )
    expect(body.results[0]?.type).toBe("error")
    expect((body.results[0] as { error: { message: string } }).error.message).toContain("earlier step")
  })
})

describe("interactive transactions on a stream", () => {
  test("BEGIN on one request and COMMIT on a later one is one transaction", async () => {
    const first = await server.pipeline(
      {
        baton: null,
        requests: [
          { type: "execute", stmt: { sql: "BEGIN IMMEDIATE" } } as never,
          { type: "execute", stmt: { sql: "insert into items (name) values ('hammer')" } } as never,
        ],
      },
      { route: ROUTE },
    )
    expect(first.body.results.every((r) => r.type === "ok")).toBe(true)

    // A second connection must not see the uncommitted row.
    const peek = await server.pipeline(
      {
        baton: null,
        requests: [
          { type: "execute", stmt: { sql: "select count(*) from items where name = 'hammer'" } } as never,
          { type: "close" },
        ],
      },
      { route: ROUTE },
    )
    expect((peek.body.results[0] as { response: { result: { rows: unknown[][] } } }).response.result.rows).toEqual([
      [V.int(0)],
    ])

    const second = await server.pipeline(
      {
        baton: first.body.baton,
        requests: [{ type: "execute", stmt: { sql: "COMMIT" } } as never, { type: "close" }],
      },
      { route: ROUTE },
    )
    expect(second.body.results[0]?.type).toBe("ok")

    const after = await server.pipeline(
      {
        baton: null,
        requests: [
          { type: "execute", stmt: { sql: "select count(*) from items where name = 'hammer'" } } as never,
          { type: "close" },
        ],
      },
      { route: ROUTE },
    )
    expect((after.body.results[0] as { response: { result: { rows: unknown[][] } } }).response.result.rows).toEqual([
      [V.int(1)],
    ])
  })

  test("COMMIT with nothing open, and BEGIN twice, are both errors", async () => {
    const { body } = await server.pipeline(
      {
        baton: null,
        requests: [
          { type: "execute", stmt: { sql: "COMMIT" } } as never,
          { type: "execute", stmt: { sql: "BEGIN" } } as never,
          { type: "execute", stmt: { sql: "BEGIN" } } as never,
          { type: "execute", stmt: { sql: "ROLLBACK" } } as never,
          { type: "close" },
        ],
      },
      { route: ROUTE },
    )
    expect((body.results[0] as { error: { message: string } }).error.message).toContain(
      "no transaction is active",
    )
    expect(body.results[1]?.type).toBe("ok")
    expect((body.results[2] as { error: { message: string } }).error.message).toContain(
      "within a transaction",
    )
    expect(body.results[3]?.type).toBe("ok")
  })

  test("BEGIN TRANSACTION READONLY, which is @libsql/client's read mode, is accepted", async () => {
    const { body } = await server.pipeline(
      {
        baton: null,
        requests: [
          { type: "execute", stmt: { sql: "BEGIN TRANSACTION READONLY" } } as never,
          { type: "execute", stmt: { sql: "select count(*) from items" } } as never,
          { type: "execute", stmt: { sql: "COMMIT" } } as never,
          { type: "close" },
        ],
      },
      { route: ROUTE },
    )
    expect(body.results.map((r) => r.type)).toEqual(["ok", "ok", "ok", "ok"])
  })

  test("closing a stream mid-transaction rolls it back", async () => {
    const open = await server.pipeline(
      {
        baton: null,
        requests: [
          { type: "execute", stmt: { sql: "BEGIN IMMEDIATE" } } as never,
          { type: "execute", stmt: { sql: "insert into items (name) values ('ghost')" } } as never,
          { type: "close" },
        ],
      },
      { route: ROUTE },
    )
    expect(open.body.baton).toBeNull()

    const after = await server.pipeline(
      {
        baton: null,
        requests: [
          { type: "execute", stmt: { sql: "select count(*) from items where name = 'ghost'" } } as never,
          { type: "close" },
        ],
      },
      { route: ROUTE },
    )
    expect((after.body.results[0] as { response: { result: { rows: unknown[][] } } }).response.result.rows).toEqual([
      [V.int(0)],
    ])
  })

  test("a savepoint rollback is not a transaction rollback", async () => {
    const { body } = await server.pipeline(
      {
        baton: null,
        requests: [
          { type: "execute", stmt: { sql: "BEGIN IMMEDIATE" } } as never,
          { type: "execute", stmt: { sql: "savepoint s1" } } as never,
          { type: "execute", stmt: { sql: "insert into items (name) values ('sp')" } } as never,
          { type: "execute", stmt: { sql: "rollback to s1" } } as never,
          { type: "execute", stmt: { sql: "insert into items (name) values ('kept')" } } as never,
          { type: "execute", stmt: { sql: "COMMIT" } } as never,
          {
            type: "execute",
            stmt: { sql: "select name from items where name in ('sp','kept')" },
          } as never,
          { type: "close" },
        ],
      },
      { route: ROUTE },
    )
    expect(body.results.map((r) => r.type)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok"])
    expect((body.results[6] as { response: { result: { rows: unknown[][] } } }).response.result.rows).toEqual([
      [V.text("kept")],
    ])
  })
})
