// The subscription half of design §9.1: the change feed as an iterable and as an emitter, its
// reconnect, and live queries over both the socket and the SSE fallback.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createClient, type DecodedChangeEvent } from "../../src/client/index.ts"
import { HEADERS } from "../../src/client/protocol.ts"
import { createDb, startClientFixture, stopAll, until, type ClientFixture } from "./harness.ts"
import { startTestServer } from "../server/harness.ts"

const SCHEMA = `create table todos(id integer primary key, title text, done integer default 0)`

let fixture: ClientFixture

beforeAll(async () => {
  fixture = await startClientFixture({}, SCHEMA)
})
afterAll(stopAll)

describe("changes", () => {
  test("delivers to a listener and to a for-await loop alike", async () => {
    const db = fixture.client.db("acme")
    const feed = db.changes({ include: "row" })
    const heard: DecodedChangeEvent[] = []
    feed.on("change", (event) => heard.push(event))

    const iterated: DecodedChangeEvent[] = []
    const loop = (async () => {
      for await (const event of feed) {
        iterated.push(event)
        if (iterated.length === 2) break
      }
    })()

    // The stream has to be up before the write, or there is nothing to hear it.
    await until(() => fixture.requests.some((r) => r.url.includes("/changes")))
    await new Promise((resolve) => setTimeout(resolve, 60))
    await db.sql`insert into todos(title) values (${"one"})`.run()
    await db.sql`insert into todos(title) values (${"two"})`.run()
    await loop

    expect(iterated).toHaveLength(2)
    expect(heard.length).toBeGreaterThanOrEqual(2)
    const first = heard[0] as DecodedChangeEvent
    expect(first.changes[0]?.table).toBe("todos")
    expect(first.changes[0]?.op).toBe("insert")
    expect(first.changes[0]?.row).toEqual({ id: 1, title: "one", done: 0 })
    expect(first.txid).toBeGreaterThan(0)
    feed.close()
    expect(feed.closed).toBe(true)
  })

  test("a table filter leaves other tables out", async () => {
    const db = fixture.client.db("acme")
    await db.sql`create table other(id integer primary key)`.run()
    const feed = db.changes({ tables: ["other"] })
    const heard: DecodedChangeEvent[] = []
    feed.on("change", (event) => heard.push(event))
    await new Promise((resolve) => setTimeout(resolve, 80))
    await db.sql`insert into todos(title) values (${"ignored"})`.run()
    await db.sql`insert into other(id) values (${7})`.run()
    await until(() => heard.length > 0)
    expect(heard).toHaveLength(1)
    expect(heard[0]?.changes[0]?.table).toBe("other")
    feed.close()
  })

  test("a dropped stream reconnects and resumes from the txid it had", async () => {
    const server = await startTestServer()
    await createDb(server, "acme", SCHEMA)
    const urls: string[] = []
    let attempts = 0
    const client = createClient({
      url: server.url,
      token: server.adminKey,
      retryMs: 20,
      fetch: (url, init) => {
        if (!url.includes("/changes")) return fetch(url, init)
        urls.push(url)
        attempts += 1
        if (attempts > 1) return fetch(url, init)
        // A connection that opens, says hello and dies: exactly what a restarted proxy looks like.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("retry: 20\n: open\n\n"))
            controller.close()
          },
        })
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              [HEADERS.txid]: String(startedAt),
            },
          }),
        )
      },
    })
    const db = client.db("acme")
    const startedAt = (await db.sql`select 1`).txid
    const feed = db.changes()
    const heard: DecodedChangeEvent[] = []
    feed.on("change", (event) => heard.push(event))
    try {
      await until(() => attempts >= 2)
      await new Promise((resolve) => setTimeout(resolve, 60))
      await db.sql`insert into todos(title) values (${"after the drop"})`.run()
      await until(() => heard.length > 0)
      expect(urls[0]).not.toContain("since=")
      expect(urls[1]).toContain(`since=${startedAt}`)
      expect(heard[0]?.changes[0]?.table).toBe("todos")
    } finally {
      feed.close()
      client.close()
      await server.close()
    }
  })

  test("a since the ring cannot serve arrives as reset, not as silence", async () => {
    // A fresh server, so the ring is created by this subscription and sealed at the database's
    // current txid — a position before that is unservable rather than "nothing happened".
    const fresh = await startClientFixture({}, SCHEMA)
    const db = fresh.client.db("acme")
    await db.sql`insert into todos(title) values (${"before anyone watched"})`.run()
    const feed = db.changes({ since: 1 })
    const resets: unknown[] = []
    feed.on("reset", (event) => resets.push(event))
    try {
      await until(() => resets.length > 0)
      expect(resets).toHaveLength(1)
    } finally {
      feed.close()
      fresh.client.close()
      await fresh.server.close()
    }
  })
})

describe("live", () => {
  test("over the socket: a full result first, then diffs", async () => {
    const db = fixture.client.db("acme")
    await db.sql`create table live_ws(id integer primary key, title text)`.run()
    await db.sql`insert into live_ws(title) values (${"first"})`.run()

    const live = db.live`select id, title from live_ws order by id`.key("id")
    const rows: number[] = []
    const diffs: string[] = []
    live.on("rows", (event) => rows.push(event.rows.length))
    live.on("diff", (event) =>
      diffs.push(`+${event.added.length} -${event.removed.length} ~${event.updated.length}`),
    )
    try {
      await until(() => rows.length > 0)
      expect(rows[0]).toBe(1)

      await db.sql`insert into live_ws(title) values (${"second"})`.run()
      await until(() => diffs.length > 0)
      expect(diffs[0]).toBe("+1 -0 ~0")

      await db.sql`update live_ws set title = ${"changed"} where id = ${1}`.run()
      await until(() => diffs.length > 1)
      expect(diffs[1]).toBe("+0 -0 ~1")

      await db.sql`delete from live_ws where id = ${2}`.run()
      await until(() => diffs.length > 2)
      expect(diffs[2]).toBe("+0 -1 ~0")
    } finally {
      live.close()
    }
  })

  test("without a key every change sends the whole result", async () => {
    const db = fixture.client.db("acme")
    await db.sql`create table live_all(id integer primary key, v text)`.run()
    const live = db.live<{ id: number; v: string }>`select id, v from live_all order by id`
    const sizes: number[] = []
    live.on("rows", (event) => sizes.push(event.rows.length))
    try {
      await until(() => sizes.length > 0)
      await db.sql`insert into live_all(v) values (${"a"})`.run()
      await until(() => sizes.length > 1)
      expect(sizes).toEqual([0, 1])
    } finally {
      live.close()
    }
  })

  test("without a WebSocket the same subscription runs over SSE", async () => {
    const client = createClient({
      url: fixture.server.url,
      token: fixture.server.adminKey,
      WebSocket: null,
      retryMs: 20,
    })
    const db = client.db("acme")
    await db.sql`create table live_sse(id integer primary key, v text)`.run()
    const live = db.live`select id, v from live_sse order by id`.key("id")
    const rows: number[] = []
    const diffs: number[] = []
    live.on("rows", (event) => rows.push(event.rows.length))
    live.on("diff", (event) => diffs.push(event.added.length))
    try {
      await until(() => rows.length > 0)
      await new Promise((resolve) => setTimeout(resolve, 40))
      await db.sql`insert into live_sse(v) values (${"over sse"})`.run()
      await until(() => diffs.length > 0)
      expect(diffs[0]).toBe(1)
    } finally {
      live.close()
      client.close()
    }
  })

  test("key() after the subscription started is refused", async () => {
    const db = fixture.client.db("acme")
    const live = db.live`select 1 as one`
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(() => live.key("one")).toThrow()
    live.close()
  })
})
