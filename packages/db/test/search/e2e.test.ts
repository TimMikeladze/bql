// `bql.sh/search` through a real server over HTTP: the same builders, a different `Db`. Also the
// realtime half of the shadow-table rule, where it is observable — on the wire.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { DecodedChangeEvent } from "../../src/client/index.ts"
import { ftsIndex, ftsQuote, geoIndex, hybridSearch, vectorIndex } from "../../src/search/index.ts"
import { sqlite } from "../../src/sqlite/index.ts"
import { startClientFixture, stopAll, until, type ClientFixture } from "../client/harness.ts"

const features = sqlite().features

let fixture: ClientFixture

beforeAll(async () => {
  fixture = await startClientFixture(
    {},
    "create table articles(id integer primary key, title text, body text, lat real, lon real)",
  )
})
afterAll(stopAll)

describe.if(features.vec && features.geo && features.fts5 && features.rtree)("over HTTP", () => {
  test("fts, vector, hybrid and geo through the client", async () => {
    const db = fixture.client.db("acme")
    const fts = ftsIndex(db, { table: "articles_fts", source: "articles", columns: ["title", "body"] })
    const vec = vectorIndex(db, { table: "articles_vec", dimensions: 2 })
    const geo = geoIndex(db, { table: "articles_geo", source: "articles" })
    await fts.create()
    await vec.create()
    await geo.create()

    await db.execute(
      `insert into articles(title, body, lat, lon) values
         ('SQLite on the edge', 'replicas everywhere', 51.5, -0.12),
         ('Vectors', 'embeddings in sqlite', 48.85, 2.35),
         ('Cooking', 'pasta', 40.7, -74.0)`,
    )
    await vec.upsert(1, [0, 1])
    await vec.upsert(2, [1, 0])
    await vec.upsert(3, [0.7, 0.7])

    expect((await fts.search(ftsQuote("sqlite"))).map((r) => r.rowid).sort()).toEqual([1, 2])
    expect((await vec.search([1, 0], { k: 1 }))[0]?.id).toBe(2)
    const hybrid = await hybridSearch(db, { fts, vector: vec, query: "sqlite", embedding: [1, 0], k: 3 })
    expect(hybrid[0]?.id).toBe(2)
    expect((await geo.near(51.5, -0.12, 500_000)).map((p) => p.id)).toEqual([1, 2])
  })

  test("the change feed never carries shadow rows, and a live FTS query still refreshes", async () => {
    const db = fixture.client.db("acme")
    const feed = db.changes({ include: "row" })
    const heard: DecodedChangeEvent[] = []
    feed.on("change", (event) => heard.push(event))
    const live = db.live<{ rowid: number }>`select rowid from articles_fts where articles_fts match 'feed'`
    const results: number[] = []
    live.on("rows", (event) => results.push(event.rows.length))
    try {
      await until(() => fixture.requests.some((r) => r.url.includes("/changes")) && results.length > 0)
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(results.at(-1)).toBe(0)

      // The trigger writes four FTS5 shadow tables; the feed must show one `articles` row.
      await db.execute("insert into articles(title, body) values ('feed', 'test')")
      await until(() => heard.length > 0 && results.at(-1) === 1)
      expect(heard.flatMap((e) => e.changes.map((c) => c.table))).toEqual(["articles"])
    } finally {
      live.close()
      feed.close()
    }
  })
})
