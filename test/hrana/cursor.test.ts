// `POST /v3/cursor`: the same conditional batch, answered as newline-delimited entries.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { startHrana, stopAllHrana, V, type TestHrana } from "./harness.ts"

let server: TestHrana
const ROUTE = "/v1/db/cur/v3/cursor"

beforeAll(async () => {
  server = await startHrana()
  await server.createDb("cur", "create table n (id integer primary key, v text)")
})

afterAll(async () => {
  await stopAllHrana()
})

describe("cursor", () => {
  test("a step becomes step_begin, a row per row, then step_end", async () => {
    const { status, head, entries } = await server.cursor(
      {
        baton: null,
        batch: {
          steps: [
            { stmt: { sql: "insert into n (v) values ('a'), ('b')" } },
            { stmt: { sql: "select id, v from n order by id" } },
          ],
        },
      },
      { route: ROUTE },
    )
    expect(status).toBe(200)
    expect(typeof head.baton).toBe("string")
    expect(entries.map((e) => e.type)).toEqual([
      "step_begin",
      "step_end",
      "step_begin",
      "row",
      "row",
      "step_end",
    ])
    const insertEnd = entries[1] as { affected_row_count: number; last_insert_rowid: string | null }
    expect(insertEnd.affected_row_count).toBe(2)
    expect(typeof insertEnd.last_insert_rowid).toBe("string")

    const selectBegin = entries[2] as { step: number; cols: { name: string | null }[] }
    expect(selectBegin.step).toBe(1)
    expect(selectBegin.cols.map((c) => c.name)).toEqual(["id", "v"])
    expect((entries[3] as { row: unknown[] }).row).toEqual([V.int(1), V.text("a")])
  })

  test("a failing step becomes step_error and the conditional rollback still runs", async () => {
    const { entries } = await server.cursor(
      {
        baton: null,
        batch: {
          steps: [
            { stmt: { sql: "BEGIN IMMEDIATE" } },
            { condition: { type: "ok", step: 0 }, stmt: { sql: "select * from missing" } },
            { condition: { type: "ok", step: 1 }, stmt: { sql: "COMMIT" } },
            { condition: { type: "not", cond: { type: "ok", step: 2 } }, stmt: { sql: "ROLLBACK" } },
          ],
        },
      },
      { route: ROUTE },
    )
    const kinds = entries.map((e) => e.type)
    expect(kinds).toContain("step_error")
    const failure = entries.find((e) => e.type === "step_error") as {
      step: number
      error: { code: string }
    }
    expect(failure.step).toBe(1)
    expect(failure.error.code).toBe("SQLITE_ERROR")
    // Step 2 (COMMIT) was skipped, so it contributes nothing at all; step 3 (ROLLBACK) ran.
    const begins = entries.filter((e) => e.type === "step_begin") as { step: number }[]
    expect(begins.map((b) => b.step)).toEqual([0, 3])
  })

  test("a cursor baton resumes the stream a pipeline opened", async () => {
    const opened = await server.pipeline(
      {
        baton: null,
        requests: [{ type: "execute", stmt: { sql: "BEGIN IMMEDIATE" } } as never],
      },
      { route: "/v1/db/cur/v2/pipeline" },
    )
    const cursed = await server.cursor(
      {
        baton: opened.body.baton,
        batch: { steps: [{ stmt: { sql: "insert into n (v) values ('in-tx')" } }] },
      },
      { route: ROUTE },
    )
    expect(cursed.status).toBe(200)
    expect(cursed.entries.map((e) => e.type)).toEqual(["step_begin", "step_end"])

    // The row is still uncommitted, so the rollback below must make it vanish.
    const rolled = await server.pipeline(
      {
        baton: cursed.head.baton,
        requests: [{ type: "execute", stmt: { sql: "ROLLBACK" } } as never, { type: "close" }],
      },
      { route: "/v1/db/cur/v2/pipeline" },
    )
    expect(rolled.body.results[0]?.type).toBe("ok")

    const after = await server.pipeline(
      {
        baton: null,
        requests: [
          { type: "execute", stmt: { sql: "select count(*) from n where v = 'in-tx'" } } as never,
          { type: "close" },
        ],
      },
      { route: "/v1/db/cur/v2/pipeline" },
    )
    expect(
      (after.body.results[0] as { response: { result: { rows: unknown[][] } } }).response.result.rows,
    ).toEqual([[V.int(0)]])
  })

  test("a malformed batch is an error entry, not an HTTP status", async () => {
    const { status, entries } = await server.cursor(
      { baton: null, batch: { steps: [{ stmt: {} }] } },
      { route: ROUTE },
    )
    expect(status).toBe(200)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.type).toBe("step_error")
  })

  test("the root mount serves cursors too", async () => {
    const { status, entries } = await server.cursor(
      { baton: null, batch: { steps: [{ stmt: { sql: "select 1" } }] } },
      { route: "/v3/cursor" },
    )
    // No `x-namespace` and no subdomain, so this is the `default` database — which does not exist
    // on this server, and the failure is the whole request rather than one entry.
    expect(status).toBe(404)
    expect(entries).toHaveLength(0)
  })
})
