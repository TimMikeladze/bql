// `push` against a database that evolves: the schema gains and loses columns, old and new code run
// side by side, something outside changes the database, several processes push at once. The rule
// under test is the one in docs/plan-typed-sql.md: push only moves the database toward what the
// types need, and anything that would lose data or change a type waits for `allowDataLoss`.

import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Bql, type EmbeddedDb } from "../../src/embedded.ts"
import { schema } from "../../src/typed/index.ts"
import { removeTempDir } from "../tmpdir.ts"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bql-push-"))
const bq = await Bql.open({ dir })
let n = 0
const fresh = (): Promise<EmbeddedDb> => bq.create(`push${n++}`)

afterAll(async () => {
  await bq.close()
  removeTempDir(dir)
})

const columns = async (db: EmbeddedDb, table: string) =>
  ((await db.execute(`pragma table_info(${table})`)) as unknown as { name: string; type: string; notnull: number }[]).map(
    (c) => `${c.name} ${c.type}${c.notnull ? " not null" : ""}`,
  )

const v1 = schema(
  "create table users(id integer primary key, name text not null)",
  "create index users_name on users(name)",
)

test("a fresh database gets the whole schema; a second push changes nothing and takes no lock", async () => {
  const raw = await fresh()
  const db = await v1.push(raw)
  await db.query("insert into users(name) values (:name)", { name: "ada" }).run()
  expect(await columns(raw, "users")).toEqual(["id INTEGER", "name TEXT not null"])

  const txid = raw.txid
  await v1.push(raw)
  expect(raw.txid).toBe(txid)
  expect(await v1.plan(raw)).toEqual({ statements: [], blocked: [] })
})

test("editing the create statement adds columns, keeping the rows", async () => {
  const raw = await fresh()
  await (await v1.push(raw)).query("insert into users(name) values ('ada')").run()

  const v2 = schema(
    "create table users(id integer primary key, name text not null, email text, active integer not null default 1)",
    "create index users_name on users(name)",
    "create table posts(id integer primary key, user_id integer not null, title text not null)",
  )
  expect((await v2.plan(raw)).statements).toEqual([
    "CREATE TABLE posts(id integer primary key, user_id integer not null, title text not null)",
    'alter table "users" add column email text',
    'alter table "users" add column active integer not null default 1',
  ])
  const db = await v2.push(raw)
  expect([...(await db.query("select name, email, active from users"))]).toEqual([{ name: "ada", email: null, active: 1 }])
})

test("a not-null column with no default rebuilds the table, and fails clearly when rows exist", async () => {
  const empty = await fresh()
  await v1.push(empty)
  const v2 = schema(
    "create table users(id integer primary key, name text not null, handle text not null)",
    "create index users_name on users(name)",
  )
  await v2.push(empty)
  expect(await columns(empty, "users")).toEqual(["id INTEGER", "name TEXT not null", "handle TEXT not null"])
  // The rebuild dropped the index with the table and put it back.
  expect(await empty.execute("select name from sqlite_schema where type = 'index' and name = 'users_name'").first()).toEqual({ name: "users_name" })

  const full = await fresh()
  await (await v1.push(full)).query("insert into users(name) values ('ada')").run()
  expect(v2.push(full)).rejects.toThrow("NOT NULL constraint failed")
  // Nothing half-applied.
  expect(await columns(full, "users")).toEqual(["id INTEGER", "name TEXT not null"])
})

test("old code pushing after new code leaves the new columns alone", async () => {
  const raw = await fresh()
  const v2 = schema(
    "create table users(id integer primary key, name text not null, email text)",
    "create index users_name on users(name)",
  )
  await v2.push(raw)
  // An instance still on v1 boots, or opens this tenant.
  expect(await v1.plan(raw)).toEqual({ statements: [], blocked: [] })
  await v1.push(raw)
  expect(await columns(raw, "users")).toEqual(["id INTEGER", "name TEXT not null", "email TEXT"])
})

test("a column the types say is not null is tightened; a stricter database is left", async () => {
  const loose = schema("create table t(a text)")
  const strict = schema("create table t(a text not null)")

  const raw = await fresh()
  await (await loose.push(raw)).query("insert into t(a) values ('x')").run()
  await strict.push(raw)
  expect(await columns(raw, "t")).toEqual(["a TEXT not null"])
  expect([...(await raw.execute("select a from t"))]).toEqual([{ a: "x" }])

  // The loose schema's types allow null, so a not-null column satisfies them.
  expect((await loose.plan(raw)).statements).toEqual([])
  await loose.push(raw, { allowDataLoss: true })
  expect(await columns(raw, "t")).toEqual(["a TEXT"])
})

test("a type change or a dropped column waits for allowDataLoss", async () => {
  const raw = await fresh()
  const before = schema("create table t(id integer primary key, age text, note text)")
  await (await before.push(raw)).query("insert into t(age, note) values ('41', 'hi')").run()

  const after = schema("create table t(id integer primary key, age integer)")
  expect(await after.plan(raw)).toEqual({
    statements: [],
    blocked: ["t.age is TEXT in the database and INTEGER in the schema"],
  })
  expect(after.push(raw)).rejects.toThrow("push won't make these changes without { allowDataLoss: true }")

  const db = await after.push(raw, { allowDataLoss: true })
  expect(await columns(raw, "t")).toEqual(["id INTEGER", "age INTEGER"])
  // Copied through the new column's affinity.
  expect([...(await db.query("select age from t"))]).toEqual([{ age: 41 }])
})

test("a rename moves the data instead of adding an empty column, and is a no-op once done", async () => {
  const raw = await fresh()
  await (await schema("create table people(id integer primary key, name text)").push(raw))
    .query("insert into people(name) values ('ada')")
    .run()
  const renamed = schema("create table users(id integer primary key, full_name text)")
  // The column can be named by its old table or its new one; the table rename runs first.
  const rename = { people: "users", "people.name": "users.full_name" }
  expect((await renamed.plan(raw, { rename })).statements).toEqual([
    'alter table "people" rename to "users"',
    'alter table "users" rename column "name" to "full_name"',
  ])
  const db = await renamed.push(raw, { rename })
  expect([...(await db.query("select full_name from users"))]).toEqual([{ full_name: "ada" }])
  expect(await renamed.plan(raw, { rename })).toEqual({ statements: [], blocked: [] })
})

test("a change made outside push is noticed and repaired on the next push", async () => {
  const raw = await fresh()
  const app = schema("create table t(id integer primary key, a text, b text)")
  await app.push(raw)
  await raw.execute("alter table t drop column b").run()
  // schema_version moved, so the fast path doesn't trust user_version.
  expect((await app.plan(raw)).statements).toEqual(['alter table "t" add column b text'])
  await app.push(raw)
  expect(await columns(raw, "t")).toEqual(["id INTEGER", "a TEXT", "b TEXT"])
})

test("views over a rebuilt table survive, and a changed view is replaced", async () => {
  const raw = await fresh()
  await schema("create table t(id integer primary key, a text)", "create view v as select id from t").push(raw)
  const next = schema("create table t(id integer primary key, a text not null default '')", "create view v as select id, a from t")
  const db = await next.push(raw)
  expect([...(await db.query("select id, a from v"))]).toEqual([])
})

test("concurrent pushes wait for each other instead of failing busy", async () => {
  const raw = await fresh()
  const results = await Promise.allSettled([v1.push(raw), v1.push(raw), v1.push(raw)])
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"])
  expect(await v1.plan(raw)).toEqual({ statements: [], blocked: [] })
})

test("push over the client, as a deployed app would, and the foreign-key guard", async () => {
  const { createClient } = await import("../../src/client/index.ts")
  const { createDb, startTestServer, stopAll } = await import("../server/harness.ts")
  const server = await startTestServer({ sqlite: { foreignKeys: true } })
  try {
    await createDb(server, "remote", "")
    const client = createClient({ url: server.url, token: server.adminKey })
    const raw = client.db("remote")
    const parent = schema(
      "create table users(id integer primary key, name text)",
      "create table posts(id integer primary key, user_id integer not null references users(id) on delete cascade)",
    )
    const db = await parent.push(raw)
    await db.query("insert into users(name) values ('ada')").run()
    await db.query("insert into posts(user_id) values (1)").run()
    expect(await parent.plan(raw)).toEqual({ statements: [], blocked: [] })

    // Tightening users.name means rebuilding users, whose drop would cascade into posts.
    const tighter = schema(
      "create table users(id integer primary key, name text not null)",
      "create table posts(id integer primary key, user_id integer not null references users(id) on delete cascade)",
    )
    expect((await tighter.plan(raw)).blocked).toEqual([
      "users has to be rebuilt, and with foreign_keys on that would fire ON DELETE actions in posts",
    ])
    expect(tighter.push(raw)).rejects.toThrow("ON DELETE actions in posts")
    expect([...(await raw.execute("select count(*) as n from posts"))]).toEqual([{ n: 1 }])
    client.close()
  } finally {
    await stopAll()
  }
})

test("typed() syncs on the first query, once, and a second handle over the same db only reads", async () => {
  const raw = await fresh()
  const db = v1.typed(raw)
  // Nothing happens until something is asked of the db.
  expect(await raw.execute("select count(*) as n from sqlite_schema").first()).toEqual({ n: 0 })
  expect([...(await db.query("select id, name from users"))]).toEqual([])

  const txid = raw.txid
  const other = v1.typed(bq.db(raw.name))
  await other.query("insert into users(name) values ('ada')").run()
  // One write: the insert. The second handle's sync was a read that found the db in step.
  expect(raw.txid).toBe(txid + 1)
})

test("first use of live and transaction waits for the sync too", async () => {
  const raw = await fresh()
  const name = await v1.typed(raw).transaction(async (tx) => {
    await tx.query("insert into users(name) values ('ada')").run()
    return (await tx.query("select name from users").first())?.name
  })
  expect(name).toBe("ada")

  const fresher = await fresh()
  const live = v1.typed(fresher).live("select name from users")
  const rows = await new Promise<unknown[]>((resolve) => live.on("rows", (e) => resolve(e.rows)))
  live.close()
  expect(rows).toEqual([])
})

test("a change push refuses surfaces on the first query, and the next query retries", async () => {
  const raw = await fresh()
  await schema("create table t(id integer primary key, age text)").push(raw)
  const app = schema("create table t(id integer primary key, age integer)")
  const db = app.typed(raw)
  expect(db.query("select age from t").first()).rejects.toThrow("t.age is TEXT in the database and INTEGER in the schema")
  // A deploy step fixes it under the running code.
  await app.push(bq.db(raw.name), { allowDataLoss: true })
  expect(await db.query("select age from t").first()).toBeNull()
})

test("sync: false leaves the database alone", async () => {
  const raw = await fresh()
  const db = v1.typed(raw, { sync: false })
  expect(db.query("select id from users").first()).rejects.toThrow("no such table: users")
})

test("a read-only token reads a database that's in step, and is told plainly when it isn't", async () => {
  const { createClient } = await import("../../src/client/index.ts")
  const { createDb, startTestServer, stopAll } = await import("../server/harness.ts")
  const server = await startTestServer()
  try {
    await createDb(server, "ro", "")
    const admin = createClient({ url: server.url, token: server.adminKey })
    await v1.push(admin.db("ro"))
    const { token } = await admin.admin.mintToken({ dbs: ["ro"], scope: "ro" })
    const reader = createClient({ url: server.url, token })

    expect([...(await v1.typed(reader.db("ro")).query("select id from users"))]).toEqual([])

    const v2 = schema("create table users(id integer primary key, name text not null, email text)")
    expect(v2.typed(reader.db("ro")).query("select email from users").first()).rejects.toThrow(
      "this token can't read or change its schema",
    )
    admin.close()
    reader.close()
  } finally {
    await stopAll()
  }
})
