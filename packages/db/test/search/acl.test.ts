// A token with a per-table ACL and a search index: the module's own storage tables follow the
// index's grant, and nothing else does. `src/server/auth.ts` (`shadowLookup`).

import { afterAll, describe, expect, test } from "bun:test"
import { AuthorizerHub } from "../../src/realtime/authorizer.ts"
import { ftsIndex, ftsQuote, geoIndex, vectorIndex, type SearchDb } from "../../src/search/index.ts"
import { applyPolicy, claimsFor, tokenPrincipal } from "../../src/server/auth.ts"
import { Database, sqlite } from "../../src/sqlite/index.ts"
import { cleanupTempDirs, tempDb } from "../sqlite/tmp.ts"

afterAll(cleanupTempDirs)

const features = sqlite().features

/** SQLite's two wordings for an authorizer refusal: at prepare, and for a column read. */
const DENIED = /not authorized|prohibited/

/** The driver as a `SearchDb`, so the helpers' own SQL is what the authorizer judges. */
function searchDb(db: Database): SearchDb {
  return { execute: (sql, args) => ({ all: () => db.prepare(sql).all(...((args ?? []) as never[])) as never }) }
}

async function fresh(): Promise<{ db: Database; hub: AuthorizerHub }> {
  const db = Database.open(tempDb())
  db.exec(`
    create table posts(id integer primary key, body text, lat real, lon real);
    create table todos(id integer primary key, title text);
    create table todos_data(id integer primary key, secret text);
    insert into posts(body, lat, lon) values ('hello sqlite', 51.5, -0.12);
    insert into todos_data(secret) values ('hunter2');
  `)
  const admin = searchDb(db)
  await ftsIndex(admin, { table: "posts_fts", source: "posts", columns: ["body"], sourceKey: "id" }).create()
  const vec = vectorIndex(admin, { table: "posts_vec", dimensions: 2 })
  await vec.create()
  await vec.upsert(1, [1, 0])
  await geoIndex(admin, { table: "posts_geo", source: "posts", sourceKey: "id" }).create()
  return { db, hub: new AuthorizerHub(db) }
}

function as(db: Database, hub: AuthorizerHub, tables: Record<string, "r" | "rw">): void {
  applyPolicy(db, hub, tokenPrincipal(claimsFor({ rw: ["acme"], tables })), "acme")
}

describe.if(features.vec && features.geo && features.fts5 && features.rtree)("per-table ACL", () => {
  test("a reader granted the indexes can search all three", async () => {
    const { db, hub } = await fresh()
    as(db, hub, { posts: "r", posts_fts: "r", posts_vec: "r", posts_geo: "r" })
    const s = searchDb(db)
    expect((await ftsIndex(s, { table: "posts_fts", columns: ["body"] }).search(ftsQuote("sqlite"))).length).toBe(1)
    expect((await vectorIndex(s, { table: "posts_vec", dimensions: 2 }).search([1, 0], { k: 1 }))[0]?.id).toBe(1)
    expect((await geoIndex(s, { table: "posts_geo" }).near(51.5, -0.12, 1_000)).map((p) => p.id)).toEqual([1])
    // Read-only grant: the index's storage is not writable through it.
    expect(() => db.run("insert into posts(body) values ('x')")).toThrow(DENIED)
    db.close()
  })

  test("a writer granted the source and the index can write through the triggers", async () => {
    const { db, hub } = await fresh()
    as(db, hub, { posts: "rw", posts_fts: "rw", posts_geo: "rw" })
    db.run("insert into posts(body, lat, lon) values ('second sqlite post', 48.85, 2.35)")
    db.run("update posts set body = 'edited' where id = 1")
    db.run("delete from posts where id = 1")
    expect(db.prepare("select rowid from posts_fts where posts_fts match 'sqlite'").all()).toEqual([{ rowid: 2 }])
    db.close()
  })

  test("without the index's grant its storage stays denied", async () => {
    const { db, hub } = await fresh()
    as(db, hub, { posts: "rw" })
    expect(() => db.prepare("select * from posts_fts_data").all()).toThrow(DENIED)
    expect(() => db.prepare("select * from posts_vec_vector_chunks00").all()).toThrow(DENIED)
    // The triggers write an index the token was not granted.
    expect(() => db.run("insert into posts(body) values ('x')")).toThrow(DENIED)
    db.close()
  })

  test("a real table named like storage is judged on its own name", async () => {
    const { db, hub } = await fresh()
    // `todos` is an ordinary table, so `todos_data` is nobody's shadow table.
    as(db, hub, { todos: "rw", posts_fts: "r" })
    expect(() => db.prepare("select * from todos_data").all()).toThrow(DENIED)
    expect(() => db.run("insert into todos_data(secret) values ('x')")).toThrow(DENIED)
    db.close()
  })

  test("a real table named like storage the index does not have is not covered by its grant", async () => {
    const { db, hub } = await fresh()
    // `posts_fts` is external-content (no `_content`) and `posts_vec` has no `+aux` column (no
    // `_auxiliary`), so both of these are ordinary tables that merely share the prefix.
    db.exec("create table posts_fts_content(x); create table posts_vec_auxiliary(x)")
    as(db, hub, { posts: "rw", posts_fts: "rw", posts_vec: "rw" })
    expect(() => db.prepare("select * from posts_fts_content").all()).toThrow(DENIED)
    expect(() => db.run("insert into posts_vec_auxiliary(x) values (1)")).toThrow(DENIED)
    db.close()
  })

  test("an rw grant on an index cannot write its storage directly, only through the module", async () => {
    const { db, hub } = await fresh()
    as(db, hub, { posts: "rw", posts_fts: "rw", posts_geo: "rw" })
    expect(() => db.run("insert into posts_fts_data(id, block) values (999, x'00')")).toThrow(
      /may not be modified/,
    )
    expect(() => db.run("delete from posts_fts_idx")).toThrow(/may not be modified/)
    db.run("insert into posts(body) values ('still indexed')")
    expect(db.prepare("select rowid from posts_fts where posts_fts match 'indexed'").all()).toEqual([{ rowid: 2 }])
    // Back to the connection's own setting for the next, unscoped, borrower.
    applyPolicy(db, hub, tokenPrincipal(claimsFor({ rw: ["acme"] })), "acme")
    expect(db.dbConfig("SQLITE_DBCONFIG_DEFENSIVE", -1)).toBe(0)
    db.close()
  })

  test("an index created after the policy went on is seen on the next request", async () => {
    const { db, hub } = await fresh()
    as(db, hub, { todos: "r", todos_fts: "r" })
    hub.bypass(() => db.exec("create virtual table todos_fts using fts5(title)"))
    as(db, hub, { todos: "r", todos_fts: "r" })
    expect(db.prepare("select rowid from todos_fts where todos_fts match 'x'").all()).toEqual([])
    db.close()
  })
})
