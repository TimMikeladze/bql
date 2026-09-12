// `lastInsertRowid` is the one field a client cannot check for itself, so every shape SQLite
// treats differently is pinned here over a real listener: what the route answers is what a client
// receives. The rule under test is "SQLite set the counter during this statement", never "the
// number changed" — the two differ exactly when a new rowid repeats the connection's last one.

import { afterAll, beforeAll, expect, test } from "bun:test"
import type { BatchResult, QueryResult } from "../../src/client/protocol.ts"
import { createDb, startTestServer, stopAll, type TestServer } from "./harness.ts"

let server: TestServer

beforeAll(async () => {
  server = await startTestServer()
  await createDb(
    server,
    "rowid",
    `create table a (id integer primary key, v text);
     create table b (id integer primary key, v text);
     create table wr (k text primary key, v text) without rowid;
     create table hits (id integer primary key, what text);
     create table parent (id integer primary key, name text);
     create table child (id integer primary key, parent integer);
     create table counted (k text primary key, n integer)`,
  )
  // The harness splits a schema on semicolons, which a trigger body has inside it.
  await query("create trigger a_ins after insert on a begin insert into hits (what) values ('a'); end")
  await query("create trigger b_upd after update on b begin insert into hits (what) values ('b'); end")
})
afterAll(stopAll)

const cell = (result: QueryResult): unknown => (result.rows[0] as unknown[] | undefined)?.[0]

const query = (sql: string, args?: unknown[]): Promise<QueryResult> =>
  server.json<QueryResult>("/v1/db/rowid/query", {
    method: "POST",
    body: JSON.stringify(args ? { sql, args } : { sql }),
  })

const batch = (statements: { sql: string; args?: unknown[] }[]): Promise<BatchResult> =>
  server.json<BatchResult>("/v1/db/rowid/batch", {
    method: "POST",
    body: JSON.stringify({ statements }),
  })

test("a repeated rowid on the same pooled writer is still reported", async () => {
  // The bug this file exists for: row 1 of `a` then row 1 of `b`. The connection's counter reads
  // 1 either side of the second insert, and the second insert is the one that set it.
  expect((await query("insert into a (v) values ('one')")).lastInsertRowid).toBe(1)
  expect((await query("insert into b (v) values ('one')")).lastInsertRowid).toBe(1)
  expect((await query("insert into a (v) values ('two')")).lastInsertRowid).toBe(2)
  expect((await query("insert into b (v) values ('two')")).lastInsertRowid).toBe(2)
})

test("INSERT OR REPLACE onto the rowid it just wrote reports that rowid", async () => {
  await query("insert into a (id, v) values (40, 'x')")
  const replaced = await query("insert or replace into a (id, v) values (40, 'y')")
  expect(replaced.rowsAffected).toBe(1)
  expect(replaced.lastInsertRowid).toBe(40)
  // And again, with nothing else in between to move the number.
  expect((await query("insert or replace into a (id, v) values (40, 'z')")).lastInsertRowid).toBe(40)
})

test("INSERT … RETURNING reports the row it returned", async () => {
  const returned = await query("insert into a (v) values ('ret') returning id, v")
  expect(returned.rows).toEqual([[returned.lastInsertRowid, "ret"]])
  expect(returned.rowsAffected).toBe(1)
})

test("an UPDATE and a DELETE report nothing, whatever the connection last inserted", async () => {
  await query("insert into a (v) values ('keeper')")
  const updated = await query("update a set v = 'edited' where v = 'keeper'")
  expect(updated.rowsAffected).toBe(1)
  expect(updated.lastInsertRowid).toBeNull()
  const deleted = await query("delete from a where v = 'edited'")
  expect(deleted.rowsAffected).toBe(1)
  expect(deleted.lastInsertRowid).toBeNull()
})

test("an insert a trigger performs follows SQLite: the outer row, or nothing", async () => {
  // `a_ins` inserts into `hits`. SQLite's counter reports the outer row, because a trigger's
  // insert reverts when the trigger program ends — so the answer is `a`'s rowid, not the hit's.
  const inserted = await query("insert into a (v) values ('trigger')")
  const hits = await query("select max(id) from hits")
  expect(inserted.lastInsertRowid).not.toBe(cell(hits) as number)
  expect(cell(await query("select id from a where v = 'trigger'"))).toBe(
    inserted.lastInsertRowid as number,
  )

  // `b_upd` inserts into `hits` from an UPDATE, which sets no rowid the statement can claim: the
  // statement prepared as an inserting one, and the counter still says nothing happened.
  await query("insert into b (v) values ('subject')")
  const updated = await query("update b set v = 'poked' where v = 'subject'")
  expect(updated.rowsAffected).toBe(1)
  expect(updated.lastInsertRowid).toBeNull()
  expect(cell(await query("select count(*) from hits")) as number).toBeGreaterThan(0)
})

test("the statements that only look like inserts report nothing", async () => {
  await query("insert into a (v) values ('anchor')")
  // A WITHOUT ROWID table has no rowid to report, and SQLite leaves the counter alone.
  const withoutRowid = await query("insert into wr (k, v) values ('k1', 'v1')")
  expect(withoutRowid.rowsAffected).toBe(1)
  expect(withoutRowid.lastInsertRowid).toBeNull()
  // An upsert that took the UPDATE branch inserted nothing.
  await query("insert into counted (k, n) values ('c', 1)")
  const upserted = await query(
    "insert into counted (k, n) values ('c', 2) on conflict(k) do update set n = n + 1",
  )
  expect(upserted.rowsAffected).toBe(1)
  expect(upserted.lastInsertRowid).toBeNull()
  // An INSERT OR IGNORE that ignored everything.
  const ignored = await query("insert or ignore into counted (k, n) values ('c', 9)")
  expect(ignored.rowsAffected).toBe(0)
  expect(ignored.lastInsertRowid).toBeNull()
  // DDL writes a `sqlite_master` row, which is not the client's to see.
  const ddl = await query("create table if not exists made (x int)")
  expect(ddl.lastInsertRowid).toBeNull()
})

test("a statement that reads last_insert_rowid() still sees the statement before it", async () => {
  // The counter is an input here, so it is left alone: this is the classic parent/child idiom,
  // and it has to keep working inside one atomic batch.
  const result = await batch([
    { sql: "insert into parent (name) values ('p1')" },
    { sql: "insert into child (parent) values (last_insert_rowid())" },
  ])
  const parentId = result.results[0]?.lastInsertRowid
  expect(parentId).not.toBeNull()
  expect(result.results[1]?.lastInsertRowid).not.toBeNull()
  const rows = await query("select parent from child order by id desc limit 1")
  expect(cell(rows)).toBe(parentId as number)
})

test("a non-inserting statement between the two does not eat the counter", async () => {
  const result = await batch([
    { sql: "insert into parent (name) values ('p2')" },
    { sql: "update parent set name = name where name = 'p2'" },
    { sql: "delete from child where parent = -1" },
    { sql: "insert into child (parent) values (last_insert_rowid())" },
  ])
  const parentId = result.results[0]?.lastInsertRowid
  expect(result.results[1]?.lastInsertRowid).toBeNull()
  expect(result.results[2]?.lastInsertRowid).toBeNull()
  const rows = await query("select parent from child order by id desc limit 1")
  expect(cell(rows)).toBe(parentId as number)
})

test("a failed insert leaves the counter where it was", async () => {
  const ok = await query("insert into parent (name) values ('p3')")
  const failed = await server.fetch("/v1/db/rowid/query", {
    method: "POST",
    body: JSON.stringify({ sql: "insert into child (id, parent) values (1, 1), (1, 2)" }),
  })
  expect(failed.status).toBeGreaterThanOrEqual(400)
  const after = await batch([{ sql: "insert into child (parent) values (last_insert_rowid())" }])
  expect(after.results[0]?.lastInsertRowid).not.toBeNull()
  const rows = await query("select parent from child order by id desc limit 1")
  expect(cell(rows)).toBe(ok.lastInsertRowid as number)
})
