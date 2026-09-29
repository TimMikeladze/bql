// `bql.sh/search` against the embedded engine: the SQL each builder generates survives SQLite, the
// triggers keep an index in step with its table, and the rankings come out in the right order.
// The HTTP half is `e2e.test.ts`; the shadow-table half is `shadow.test.ts`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Bql, type EmbeddedDb } from "../../src/embedded.ts"
import { BqlClientError } from "../../src/client/errors.ts"
import {
  FeatureUnavailableError,
  fromVector,
  ftsIndex,
  ftsQuote,
  geoIndex,
  hybridSearch,
  searchFeatures,
  toVector,
  vectorIndex,
  type SearchDb,
} from "../../src/search/index.ts"
import { sqlite } from "../../src/sqlite/index.ts"
import { removeTempDir } from "../tmpdir.ts"

const features = sqlite().features

async function failure(promise: PromiseLike<unknown>): Promise<Error> {
  try {
    await promise
  } catch (err) {
    return err as Error
  }
  throw new Error("expected the call to fail, and it did not")
}

let dir: string
let bq: Bql
let db: EmbeddedDb

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bql-search-"))
  bq = await Bql.open({ dir })
  db = await bq.create("search")
})
afterAll(async () => {
  await bq.close()
  removeTempDir(dir)
})

describe("toVector / fromVector", () => {
  test("float32 little-endian, round-tripped", () => {
    const blob = toVector([1, -2.5, 0.125])
    expect([...blob.subarray(0, 4)]).toEqual([0x00, 0x00, 0x80, 0x3f])
    expect([...fromVector(blob)]).toEqual([1, -2.5, 0.125])
    expect(() => toVector([1, Number.NaN])).toThrow(BqlClientError)
    expect(() => fromVector(new Uint8Array(3))).toThrow(/multiple of 4/)
  })
})

describe("ftsQuote", () => {
  test("turns syntax into text", () => {
    expect(ftsQuote('say "hi" NEAR(x')).toBe('"say" """hi""" "NEAR(x"')
    expect(ftsQuote("a b", { mode: "any", prefix: true })).toBe('"a" OR "b"*')
    expect(ftsQuote("a b", { mode: "phrase" })).toBe('"a b"')
    expect(ftsQuote("   ")).toBe('""')
  })
})

describe("identifiers", () => {
  test("anything but a plain identifier is refused before any SQL is built", () => {
    expect(() => vectorIndex(db, { table: 'x"; drop table t; --', dimensions: 3 })).toThrow(/plain identifier/)
    expect(() => ftsIndex(db, { table: "f", columns: ["body) ; --"] })).toThrow(/plain identifier/)
    expect(() => geoIndex(db, { table: "sqlite_master" })).toThrow(/sqlite_/)
  })
})

describe("feature detection", () => {
  test("a server without sqlite-vec answers FEATURE_UNAVAILABLE, not a SQL error", async () => {
    // What a system libsqlite3 says: the function and the module do not exist.
    const bare: SearchDb = {
      execute: (sql: string) =>
        Promise.reject(
          new BqlClientError({
            code: "SQLITE_ERROR",
            message: sql.includes("vec_version") ? "no such function: vec_version" : "no such module: vec0",
          }),
        ),
    }
    const err = await failure(vectorIndex(bare, { table: "v", dimensions: 3 }).create())
    expect(err).toBeInstanceOf(FeatureUnavailableError)
    expect(err).toBeInstanceOf(BqlClientError)
    expect((err as FeatureUnavailableError).code).toBe("FEATURE_UNAVAILABLE")
    expect(err.message).toContain("sqlite:build")
    // A query on an index created elsewhere maps the same way.
    const search = await failure(vectorIndex(bare, { table: "v", dimensions: 3 }).search([1, 2, 3]))
    expect((search as FeatureUnavailableError).feature).toBe("vec")
  })

  test.if(features.vec && features.geo)("reports what the vendored build has", async () => {
    expect(await searchFeatures(db)).toEqual({ vec: true, geo: true, fts5: true, rtree: true })
  })
})

describe.if(features.vec)("vectorIndex", () => {
  test("KNN order, metadata filters inside the KNN, and upsert replaces", async () => {
    const v = vectorIndex(db, { table: "items_vec", dimensions: 3, metadata: { kind: "text", n: "integer" } })
    await v.create()
    await v.create() // idempotent
    await v.upsert(1, [1, 0, 0], { kind: "a", n: 1 })
    await v.upsert(2, [0.5, 0.5, 0], { kind: "b", n: 2 })
    await v.upsert(3, [0.8, 0.2, 0], { kind: "a", n: 3 })
    await v.upsert(4, new Float32Array([0, 0, 1]), { kind: "b", n: 4 })

    const near = await v.search([1, 0, 0], { k: 3 })
    expect(near.map((r) => r.id)).toEqual([1, 3, 2])
    expect(near[0]?.distance).toBeCloseTo(0, 6)
    expect(near[0]?.kind).toBe("a")

    expect((await v.search([1, 0, 0], { k: 3, where: { kind: "b" } })).map((r) => r.id)).toEqual([2, 4])
    expect((await v.search([1, 0, 0], { k: 3, where: { n: { gte: 3 } } })).map((r) => r.id)).toEqual([3, 4])

    await v.upsert(4, [1, 0, 0], { kind: "b", n: 4 })
    expect((await v.search([1, 0, 0], { k: 2 })).map((r) => r.id).sort()).toEqual([1, 4])
    await v.delete(1)
    expect((await v.search([1, 0, 0], { k: 1 }))[0]?.id).toBe(4)

    await expect(v.search([1, 0])).rejects.toThrow(/3-dimensional/)
    await expect(v.search([1, 0, 0], { where: { nope: 1 } })).rejects.toThrow(/no metadata column/)
    await expect(v.search([1, 0, 0], { k: 5000 })).rejects.toThrow(/k must be/)
  })

  test("works through the synchronous handle too", async () => {
    const v = vectorIndex(db.sync, { table: "sync_vec", dimensions: 2, id: "text", metric: "l2" })
    await v.create()
    await v.upsert("a", [0, 0])
    await v.upsert("b", [3, 4])
    const [first, second] = await v.search([0, 1], { k: 2 })
    expect(first?.id).toBe("a")
    expect(second?.distance).toBeCloseTo(Math.hypot(3, 3), 5)
  })
})

describe.if(features.fts5)("ftsIndex", () => {
  test("the triggers keep an external index in step on insert, update and delete", async () => {
    await db.execute("create table posts(id integer primary key, title text, body text, views int)")
    await db.execute("insert into posts(title, body) values ('before', 'indexed at create time')")
    const f = ftsIndex(db, { table: "posts_fts", source: "posts", columns: ["title", "body"], sourceKey: "id" })
    await f.create()
    expect((await f.search("create")).map((r) => r.rowid)).toEqual([1])

    await db.execute("insert into posts(title, body) values ('Bun and SQLite', 'fast local database')")
    const hits = await f.search(ftsQuote("sqlite"), { highlight: true, snippet: { column: "body" } })
    expect(hits.map((r) => r.rowid)).toEqual([2])
    expect(hits[0]?.highlight).toBe("Bun and <b>SQLite</b>")
    expect(hits[0]?.title).toBe("Bun and SQLite")
    expect(hits[0]?.rank).toBeLessThan(0)

    await db.execute("update posts set title = 'Bun and Postgres' where id = 2")
    expect(await f.search(ftsQuote("sqlite"))).toEqual([])
    expect((await f.search(ftsQuote("postgres"))).map((r) => r.rowid)).toEqual([2])
    // A column the index does not cover does not re-tokenize the row.
    await db.execute("update posts set views = 10 where id = 2")
    expect((await f.search(ftsQuote("postgres"))).map((r) => r.rowid)).toEqual([2])

    await db.execute("delete from posts where id = 2")
    expect(await f.search(ftsQuote("postgres"))).toEqual([])
    // 'integrity-check' against the content table fails if a trigger ever missed a change.
    await db.execute("insert into posts_fts(posts_fts, rank) values ('integrity-check', 1)")
    await f.rebuild()
    expect((await f.search("create")).map((r) => r.rowid)).toEqual([1])
    await expect(f.upsert(9, { title: "x" })).rejects.toThrow(/write to posts/)
  })

  test("bm25 puts the denser match first, and hostile input is just words", async () => {
    const f = ftsIndex(db, { table: "notes_fts", columns: ["body"], tokenizer: "porter unicode61" })
    await f.create()
    await f.upsert(1, { body: "running shoes for a marathon" })
    await f.upsert(2, { body: "run run run: the runner's guide to running" })
    await f.upsert(3, { body: "cooking pasta" })
    expect((await f.search(ftsQuote("run"))).map((r) => r.rowid)).toEqual([2, 1])
    expect(await f.search(ftsQuote('") OR body:* NEAR("'))).toEqual([])
  })
})

describe.if(features.vec && features.fts5)("hybridSearch", () => {
  test("a document both legs found outranks one either found alone", async () => {
    const f = ftsIndex(db, { table: "h_fts", columns: ["body"] })
    const v = vectorIndex(db, { table: "h_vec", dimensions: 2 })
    await f.create()
    await v.create()
    // 1: strong text match, far vector. 2: no text match, nearest vector. 3: decent at both.
    await f.upsert(1, { body: "sqlite sqlite sqlite" })
    await f.upsert(3, { body: "sqlite and more words here" })
    await f.upsert(4, { body: "unrelated" })
    await v.upsert(1, [0, 1])
    await v.upsert(2, [1, 0])
    await v.upsert(3, [0.9, 0.1])
    await v.upsert(4, [0.1, 0.9])

    const hits = await hybridSearch(db, { fts: f, vector: v, query: "sqlite", embedding: [1, 0], k: 4 })
    expect(hits.map((h) => h.id)).toEqual([3, 1, 2, 4])
    expect(hits[0]).toMatchObject({ ftsRank: 2, vectorRank: 2 })
    expect(hits[0]?.score).toBeCloseTo(2 / 62, 10)
    expect(hits[2]).toMatchObject({ ftsRank: null, vectorRank: 1, bm25: null })

    // Weighting the vector leg to zero leaves the text order.
    const text = await hybridSearch(db, {
      fts: "h_fts", vector: "h_vec", query: "sqlite", embedding: [1, 0], k: 2, weights: { vector: 0 },
    })
    expect(text.map((h) => h.id)).toEqual([1, 3])
  })
})

describe.if(features.rtree && features.geo)("geoIndex", () => {
  test("near is exact, ordered by distance, and follows the source table", async () => {
    await db.execute("create table places(id integer primary key, name text, lat real, lon real)")
    await db.execute(
      `insert into places(name, lat, lon) values
         ('Big Ben', 51.5007, -0.1246), ('Tower Bridge', 51.5055, -0.0754),
         ('Eiffel Tower', 48.8584, 2.2945), ('Nowhere', null, null)`,
    )
    const g = geoIndex(db, { table: "places_geo", source: "places", sourceKey: "id" })
    await g.create()

    const london = await g.near(51.5033, -0.1196, 5_000)
    expect(london.map((p) => p.id)).toEqual([1, 2])
    expect(london[0]?.distance).toBeLessThan(london[1]?.distance as number)
    expect(london[0]?.lat).toBe(51.5007)

    // The box around 400 km reaches Paris; the circle has to as well, and 300 km must not.
    expect((await g.near(51.5033, -0.1196, 400_000)).map((p) => p.id)).toEqual([1, 2, 3])
    expect((await g.near(51.5033, -0.1196, 300_000)).map((p) => p.id)).toEqual([1, 2])

    await db.execute("update places set lat = 51.5034, lon = -0.1195 where id = 3")
    expect((await g.near(51.5033, -0.1196, 100)).map((p) => p.id)).toEqual([3])
    await db.execute("delete from places where id = 3")
    expect(await g.near(51.5033, -0.1196, 100)).toEqual([])
    await db.execute("update places set lat = 0, lon = 0 where id = 4")
    expect((await g.within({ minLat: -1, maxLat: 1, minLon: -1, maxLon: 1 })).map((p) => p.id)).toEqual([4])
    await expect(g.near(91, 0, 10)).rejects.toThrow(/latitude/)
  })

  test("a box across the antimeridian", async () => {
    const g = geoIndex(db, { table: "pacific_geo" })
    await g.create()
    await g.upsert(1, -17.7, 178.1) // Fiji
    await g.upsert(2, -13.8, -171.8) // Samoa
    await g.upsert(3, 0, 0)
    const hits = await g.within({ minLat: -30, maxLat: 0, minLon: 170, maxLon: -170 })
    expect(hits.map((p) => p.id).sort()).toEqual([1, 2])
    // And a radius that crosses it: Fiji to Samoa is about 1,150 km.
    expect((await g.near(-17.7, 178.1, 1_300_000)).map((p) => p.id)).toEqual([1, 2])
  })
})

describe.if(features.vec)("bql.sh/drizzle vector()", () => {
  test("round-trips through a vec0 table and refuses the wrong length", async () => {
    const { drizzle, vector } = await import("../../src/drizzle.ts")
    const { integer, sqliteTable } = await import("drizzle-orm/sqlite-core")
    await vectorIndex(db, { table: "orm_vec", dimensions: 3 }).create()
    const table = sqliteTable("orm_vec", { id: integer("id").primaryKey(), embedding: vector({ dimensions: 3 }) })
    const orm = drizzle(db)
    await orm.insert(table).values({ id: 1, embedding: [0.5, -1, 2] })
    expect(await orm.select().from(table)).toEqual([{ id: 1, embedding: [0.5, -1, 2] }])
    expect((await vectorIndex(db, { table: "orm_vec", dimensions: 3 }).search([0.5, -1, 2], { k: 1 }))[0]?.id).toBe(1)
    expect((await failure(orm.insert(table).values({ id: 2, embedding: [1, 2] }))).message).toContain(
      "3-dimensional",
    )
  })
})
