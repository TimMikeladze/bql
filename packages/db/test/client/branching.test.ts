// X2 through a real server: lineage on list/stat, `admin.reset`, and `diffSchema` over two
// `client.db()` handles (`docs/x2-branching.md`).

import { afterAll, describe, expect, test } from "bun:test"
import { diffSchema, formatSchemaDiff } from "../../src/client/index.ts"
import { sqlite } from "../../src/sqlite/index.ts"
import { failure, startClientFixture, stopAll } from "./harness.ts"

afterAll(stopAll)

describe("lineage", () => {
  test("list and stat report parent and forkedAt; a deleted parent dangles", async () => {
    const { client } = await startClientFixture()
    const admin = client.admin
    const txid = (await client.db("acme").sql`insert into todos(title) values ('one')`.run()).txid

    const forked = await admin.fork("acme-pr", "acme")
    expect(forked).toMatchObject({ parent: "acme", forkedAt: txid, parentDeleted: false })
    expect((await admin.stat("acme")).parent).toBeNull()

    await admin.fork("acme-pr-2", "acme-pr")
    await admin.delete("acme-pr")
    const rows = await admin.list()
    expect(rows.find((row) => row.name === "acme-pr-2")).toMatchObject({
      parent: "acme-pr",
      parentDeleted: true,
    })
    expect((await failure(admin.reset("acme-pr-2"))).code).toBe("DB_NOT_FOUND")
  })

  test("reset restores the parent's head and keeps the name", async () => {
    const { client } = await startClientFixture()
    const admin = client.admin
    await client.db("acme").sql`insert into todos(title) values ('one')`.run()
    await admin.fork("pr", "acme")
    await client.db("pr").sql`insert into todos(title) values ('branch')`.run()
    const head = (await client.db("acme").sql`insert into todos(title) values ('two')`.run()).txid

    const reset = await admin.reset("pr")
    expect(reset).toMatchObject({ name: "pr", parent: "acme", forkedAt: head, txid: head })
    const rows = await client.db("pr").sql`select title from todos order by id`
    expect(rows.map((row) => row.title)).toEqual(["one", "two"])

    expect((await failure(admin.reset("acme"))).code).toBe("BAD_REQUEST")
  })
})

describe("diffSchema", () => {
  test("finds added, dropped and changed tables, columns, indexes, and row counts", async () => {
    const { client } = await startClientFixture()
    const a = client.db("acme")
    await a.sql`insert into todos(title) values ('one')`.run()
    await a.batch([
      { sql: "create index todos_title on todos(title)" },
      { sql: "create table legacy(x)" },
      { sql: "create view open_todos as select * from todos where done = 0" },
    ])
    await client.admin.fork("pr", "acme")

    const same = await diffSchema(a, client.db("pr"))
    expect(same.identical).toBe(true)
    expect(formatSchemaDiff(same)).toContain("no differences")

    const b = client.db("pr")
    await b.batch([
      { sql: "alter table todos add column due text not null default ''" },
      { sql: "alter table notes drop column body" },
      { sql: "drop index todos_title" },
      { sql: "create unique index todos_due on todos(due, title desc)" },
      { sql: "drop table legacy" },
      { sql: "create table tags(id integer primary key, name text)" },
      { sql: "create trigger touch after insert on tags begin select 1; end" },
      { sql: "insert into todos(title) values ('two'), ('three')" },
    ])

    const diff = await diffSchema(a, b)
    expect(diff.sameSchema).toBe(false)
    expect(diff.tables.added.map((t) => t.name)).toEqual(["tags"])
    expect(diff.tables.removed.map((t) => t.name)).toEqual(["legacy"])
    const changed = Object.fromEntries(diff.tables.changed.map((t) => [t.name, t.columns]))
    expect(changed.todos?.added).toEqual([
      { name: "due", type: "TEXT", notNull: true, default: "''", pk: 0, hidden: 0 },
    ])
    expect(changed.notes?.removed.map((c) => c.name)).toEqual(["body"])
    expect(diff.indexes.removed.map((i) => i.name)).toEqual(["todos_title"])
    expect(diff.indexes.added).toEqual([
      expect.objectContaining({ name: "todos_due", unique: true, columns: ["due", "title desc"] }),
    ])
    expect(diff.triggers.added.map((t) => t.name)).toEqual(["touch"])
    expect(diff.views.changed).toEqual([])
    expect(diff.rows.find((row) => row.table === "todos")).toEqual({ table: "todos", a: 1, b: 3 })
    expect(diff.rows.find((row) => row.table === "tags")).toEqual({ table: "tags", a: null, b: 0 })

    const text = formatSchemaDiff(diff, { a: "acme", b: "pr" })
    expect(text).toContain("  + tags (2 columns)")
    expect(text).toContain("      + due TEXT NOT NULL DEFAULT ''")
    expect(text).toContain("  todos   1 → 3 (+2)")
  })

  test.if(sqlite().features.vec)("a vector index is one table, not its storage", async () => {
    const { client } = await startClientFixture()
    await client.admin.create("vec")
    // vec0 does not report `_vector_chunks00` as a shadow table; the diff must still hide it.
    await client.db("vec").sql`create virtual table docs_vec using vec0(embedding float[2])`.run()
    const diff = await diffSchema(client.db("acme"), client.db("vec"), { rows: false })
    const names = [...diff.tables.added, ...diff.tables.removed].map((t) => t.name)
    expect(names).toContain("docs_vec")
    expect(names.filter((name) => name.startsWith("docs_vec_"))).toEqual([])
  })

  test("a changed column type is a column change, not add and drop", async () => {
    const { client } = await startClientFixture(
      {},
      "create table t(id integer primary key, v text)",
    )
    await client.admin.create("other")
    await client.db("other").sql`create table t(id integer primary key, v integer not null)`.run()
    const diff = await diffSchema(client.db("acme"), client.db("other"), { rows: false })
    expect(diff.rows).toEqual([])
    const [change] = diff.tables.changed
    expect(change?.columns.changed).toEqual([
      expect.objectContaining({ name: "v", fields: ["type", "notNull"] }),
    ])
  })
})
