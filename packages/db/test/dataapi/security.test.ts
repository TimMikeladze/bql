// The security boundary, tested adversarially. Every identifier in a generated statement has to
// come from introspection and every value has to be a bound parameter, so these tests do two
// things: they drive hostile requests through the real dispatcher against a real database and
// check the database survived, and they record every statement the handlers produced and assert
// the property directly — each quoted identifier is one SQLite itself reported, and no request
// string appears anywhere in the SQL text.

import { afterAll, describe, expect, test } from "bun:test"
import {
  dataApiRegistry,
  type DataApiContext,
  type DataStatement,
  introspect,
  type TenantSchema,
} from "../../src/dataapi/index.ts"
import { createDispatcher } from "../../src/http/index.ts"
import { dataApiFixture, type DataApiFixture, read } from "./harness.ts"
import { stopAll } from "../server/harness.ts"

/** A hostile schema: a semicolon in a column name, a quote in a table name, a `--` comment. */
const HOSTILE_DDL = [
  'CREATE TABLE "users" ("id; drop table users--" INTEGER PRIMARY KEY, "we""ird" TEXT, note TEXT)',
  'CREATE TABLE "tab""le" (id INTEGER PRIMARY KEY, v TEXT)',
  `INSERT INTO "users" ("id; drop table users--", "we""ird", note) VALUES (1, 'a', 'first')`,
  `INSERT INTO "tab""le" (id, v) VALUES (1, 'x')`,
]

let fixture: DataApiFixture
let schema: TenantSchema
const seen: DataStatement[] = []
let dispatch: ReturnType<typeof createDispatcher>

async function setup(): Promise<void> {
  if (fixture) return
  fixture = await dataApiFixture("hostile", "CREATE TABLE seed (id INTEGER PRIMARY KEY)")
  for (const sql of HOSTILE_DDL) fixture.admin({ sql, args: [] })
  schema = await introspect("hostile", fixture.admin)
  const registry = dataApiRegistry(schema)
  const recording = (statement: DataStatement) => {
    seen.push(statement)
    return fixture.admin(statement)
  }
  const context: DataApiContext = { db: "hostile", exec: recording }
  dispatch = createDispatcher(registry, () => context, {
    origin: "http://hostile.test",
    onError: () => {},
  })
}

afterAll(async () => {
  await stopAll()
})

/** Every `"…"`-quoted identifier in a statement, with the `""` escape undone. */
function identifiers(sql: string): string[] {
  const out: string[] = []
  const pattern = /"((?:[^"]|"")*)"/g
  for (const found of sql.matchAll(pattern)) {
    out.push((found[1] as string).replaceAll('""', '"'))
  }
  return out
}

describe("the identifier choke point", () => {
  test("a column named `id; drop table users--` is one identifier, not two statements", async () => {
    await setup()
    const key = encodeURIComponent("id; drop table users--")
    const response = await dispatch(`/v1/db/hostile/api/users?${key}=eq.1`)
    const { status, body } = await read<Record<string, unknown>[]>(response)
    expect(status).toBe(200)
    expect(body).toHaveLength(1)
    expect(body[0]?.note).toBe("first")
    // The table it tried to drop is still there, with its row.
    expect((await fixture.admin({ sql: 'SELECT count(*) FROM "users"', args: [] })).rows[0]).toEqual([1])
  })

  test("a table name with a quote in it is addressable and stays quoted", async () => {
    await setup()
    const response = await dispatch(`/v1/db/hostile/api/${encodeURIComponent('tab"le')}`)
    const { status, body } = await read<Record<string, unknown>[]>(response)
    expect(status).toBe(200)
    expect(body).toEqual([{ id: 1, v: "x" }])
    const last = seen[seen.length - 1] as DataStatement
    expect(last.sql).toContain('"tab""le"')
  })

  test("a select naming a column the table does not have is a 400, not a query", async () => {
    await setup()
    const before = seen.length
    const response = await dispatch("/v1/db/hostile/api/users?select=note,nope")
    const { status, body } = await read<{ error: { code: string; message: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe("BAD_REQUEST")
    expect(body.error.message).toContain("no column")
    // Nothing was executed at all.
    expect(seen.length).toBe(before)
  })

  test("an order term with a function call in it is a 400", async () => {
    await setup()
    for (const order of ["random()", "note desc", "(select 1)", "note.asc.oops"]) {
      const response = await dispatch(`/v1/db/hostile/api/users?order=${encodeURIComponent(order)}`)
      expect((await read(response)).status).toBe(400)
    }
  })

  test("a filter naming an unknown column, or an unknown operator, is a 400", async () => {
    await setup()
    expect((await read(await dispatch("/v1/db/hostile/api/users?nope=eq.1"))).status).toBe(400)
    expect((await read(await dispatch("/v1/db/hostile/api/users?note=matches.1"))).status).toBe(400)
    expect((await read(await dispatch("/v1/db/hostile/api/users?note=nodot"))).status).toBe(400)
  })

  test("an in filter with a thousand values binds a thousand parameters", async () => {
    await setup()
    const values = Array.from({ length: 1000 }, (_, i) => i + 1)
    const key = encodeURIComponent("id; drop table users--")
    const response = await dispatch(
      `/v1/db/hostile/api/users?${key}=${encodeURIComponent(`in.(${values.join(",")})`)}`,
    )
    const { status, body } = await read<Record<string, unknown>[]>(response)
    expect(status).toBe(200)
    expect(body).toHaveLength(1)
    const last = seen[seen.length - 1] as DataStatement
    expect(last.args).toHaveLength(1002) // 1000 members plus LIMIT and OFFSET
    expect(last.sql.match(/\?/g)).toHaveLength(1002)
  })

  test("a hostile value travels as a parameter and never as SQL text", async () => {
    await setup()
    const payload = "'; DROP TABLE users; --"
    const before = seen.length
    const response = await dispatch(
      `/v1/db/hostile/api/users?note=eq.${encodeURIComponent(payload)}`,
    )
    expect((await read(response)).status).toBe(200)
    const statement = seen[before] as DataStatement
    expect(statement.sql).not.toContain("DROP")
    expect(statement.args).toContain(payload)
    expect((await fixture.admin({ sql: 'SELECT count(*) FROM "users"', args: [] })).rows[0]).toEqual([1])
  })

  test("a body naming a column that is not writable is a 400", async () => {
    await setup()
    const post = (body: unknown) =>
      dispatch("/v1/db/hostile/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    expect((await read(await post({ note: "ok", nope: 1 }))).status).toBe(400)
    expect((await read(await post({ note: "ok", "we\"ird); drop table users--": 1 }))).status).toBe(400)
  })

  test("every identifier in every statement these tests produced came from introspection", async () => {
    await setup()
    expect(seen.length).toBeGreaterThan(3)
    const known = new Set<string>(["main"])
    for (const table of schema.tables) {
      known.add(table.name)
      for (const column of table.columns) known.add(column.name)
    }
    for (const statement of seen) {
      for (const identifier of identifiers(statement.sql)) {
        expect({ sql: statement.sql, identifier, known: known.has(identifier) }).toEqual({
          sql: statement.sql,
          identifier,
          known: true,
        })
      }
    }
  })

  test("no statement these tests produced contains a quote outside an identifier", async () => {
    await setup()
    for (const statement of seen) {
      // Every literal is a `?`. A single quote in the SQL text would mean a value was inlined.
      expect(statement.sql).not.toContain("'")
    }
  })
})
