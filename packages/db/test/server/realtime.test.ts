// The realtime surfaces of design §6.4: SSE change feeds, SSE live queries, and the long poll for
// clients that cannot hold a stream open.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type {
  ChangeEvent,
  ErrorBody,
  LiveDiffEvent,
  LiveRowsEvent,
  ResetEvent,
  SchemaEvent,
} from "../../src/client/protocol.ts"
import { collectSse, createDb, startTestServer, stopAll, type TestServer } from "./harness.ts"

let server: TestServer

beforeAll(async () => {
  server = await startTestServer()
})
afterAll(stopAll)

function write(db: string, sql: string, args?: unknown[]): Promise<Response> {
  return server.fetch(`/v1/db/${db}/query`, {
    method: "POST",
    body: JSON.stringify({ sql, ...(args ? { args } : {}) }),
  })
}

function sse(route: string, headers: Record<string, string> = {}): Promise<Response> {
  return server.fetch(route, { headers: { accept: "text/event-stream", ...headers } })
}

async function fresh(name: string): Promise<void> {
  await createDb(
    server,
    name,
    `create table todos(id integer primary key, title text, done integer default 0);
     create table other(id integer primary key, v text)`,
  )
}

describe("change feed over SSE", () => {
  test("a commit arrives as one event stamped with its position", async () => {
    await fresh("feed")
    const stream = await sse("/v1/db/feed/changes?include=row")
    expect(stream.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")
    expect(stream.headers.get("cache-control")).toBe("no-cache, no-transform")
    expect(stream.headers.get("x-accel-buffering")).toBe("no")

    await new Promise((resolve) => setTimeout(resolve, 20))
    await write("feed", "insert into todos(title) values ('one')")
    const [event] = await collectSse(stream, 1)
    expect(event?.event).toBe("change")
    const data = event?.data as ChangeEvent
    expect(data.changes).toHaveLength(1)
    expect(data.changes[0]).toMatchObject({ table: "todos", op: "insert", rowid: 1 })
    expect(data.changes[0]?.row).toEqual({ id: 1, title: "one", done: 0 })
    // L8: one event per statement, so the id is the position `txid.seq` rather than the txid. One
    // statement in this transaction, so the sequence is 0.
    expect(data.seq).toBe(0)
    expect(event?.id).toBe(`${data.txid}.0`)
  })

  test("DDL arrives as a schema event, not only on the WebSocket", async () => {
    await fresh("ddl")
    const stream = await sse("/v1/db/ddl/changes")
    await new Promise((resolve) => setTimeout(resolve, 20))
    await write("ddl", "alter table todos add column note text")
    const [event] = await collectSse(stream, 1)
    expect(event?.event).toBe("schema")
    const data = event?.data as SchemaEvent
    expect(data.changes.length).toBeGreaterThan(0)
    expect(data.changes[0]).toMatchObject({ op: "alter", object: "table", name: "todos" })
    expect(event?.id).toBe(String(data.txid))
  })

  test("a table filter does not hide DDL: a migration reaches a subscriber watching one table", async () => {
    await fresh("ddl-filtered")
    const stream = await sse("/v1/db/ddl-filtered/changes?tables=todos")
    await new Promise((resolve) => setTimeout(resolve, 20))
    await write("ddl-filtered", "alter table other add column extra text")
    const [event] = await collectSse(stream, 1)
    // `other` is not the table being watched, but the schema of the database moved and a
    // subscriber decoding rows has to hear about it.
    expect(event?.event).toBe("schema")
  })

  test("Last-Event-ID replays what was missed while the client was away", async () => {
    await fresh("resume")
    const first = await sse("/v1/db/resume/changes")
    await new Promise((resolve) => setTimeout(resolve, 20))
    await write("resume", "insert into todos(title) values ('one')")
    const [seen] = await collectSse(first, 1)

    // The stream is closed. These two commits happen with nobody listening.
    await write("resume", "insert into todos(title) values ('two')")
    await write("resume", "insert into todos(title) values ('three')")

    const second = await sse("/v1/db/resume/changes", { "last-event-id": seen?.id as string })
    const replayed = await collectSse(second, 2)
    expect(replayed.map((e) => Number(e.id))).toEqual([
      Number(seen?.id) + 1,
      Number(seen?.id) + 2,
    ])
  })

  test("a position the ring can no longer serve answers with reset", async () => {
    await fresh("ringless")
    await write("ringless", "insert into todos(title) values ('one')")
    const stream = await sse("/v1/db/ringless/changes?since=1")
    const [event] = await collectSse(stream, 1)
    expect(event?.event).toBe("reset")
    expect((event?.data as ResetEvent).reason).toContain("ring")
  })

  test("a tables filter drops what it does not name", async () => {
    await fresh("filtered")
    const stream = await sse("/v1/db/filtered/changes?tables=other")
    await new Promise((resolve) => setTimeout(resolve, 20))
    await write("filtered", "insert into todos(title) values ('ignored')")
    await write("filtered", "insert into other(v) values ('wanted')")
    const [event] = await collectSse(stream, 1)
    const data = event?.data as ChangeEvent
    expect(data.changes.every((change) => change.table === "other")).toBe(true)
  })

  test("a read-only token may subscribe; a token with no claim may not", async () => {
    await fresh("scoped")
    const { token } = await server.token({ dbs: ["scoped"], scope: "ro" })
    const allowed = await server.fetch("/v1/db/scoped/changes", {
      token,
      headers: { accept: "text/event-stream" },
    })
    expect(allowed.status).toBe(200)
    await allowed.body?.cancel()

    const { token: elsewhere } = await server.token({ dbs: ["somewhere-else"], scope: "rw" })
    const refused = await server.fetch("/v1/db/scoped/changes", {
      token: elsewhere,
      headers: { accept: "text/event-stream" },
    })
    expect(refused.status).toBe(403)
  })
})

describe("live queries over SSE", () => {
  test("the first event is the full result and later ones are diffs", async () => {
    await fresh("live")
    await write("live", "insert into todos(title) values ('first')")
    const stream = await sse(
      `/v1/db/live/live?sql=${encodeURIComponent("select id, title from todos where done = 0")}&key=id`,
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    await write("live", "insert into todos(title) values ('second')")
    const events = await collectSse(stream, 2)

    expect(events[0]?.event).toBe("rows")
    const initial = events[0]?.data as LiveRowsEvent
    expect(initial.columns).toEqual(["id", "title"])
    expect(initial.rows).toEqual([[1, "first"]])

    expect(events[1]?.event).toBe("diff")
    const diff = events[1]?.data as LiveDiffEvent
    expect(diff.added).toEqual([[2, "second"]])
    expect(diff.removed).toEqual([])
  })

  test("without a key the feed stays full results", async () => {
    await fresh("livefull")
    const stream = await sse(
      `/v1/db/livefull/live?sql=${encodeURIComponent("select count(*) as n from todos")}&rows=object`,
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    await write("livefull", "insert into todos(title) values ('x')")
    const events = await collectSse(stream, 2)
    expect(events.map((e) => e.event)).toEqual(["rows", "rows"])
    expect((events[0]?.data as LiveRowsEvent).rows).toEqual([{ n: 0 }])
    expect((events[1]?.data as LiveRowsEvent).rows).toEqual([{ n: 1 }])
  })

  test("a change to an unrelated table does not re-run the query", async () => {
    await fresh("unrelated")
    const stream = await sse(
      `/v1/db/unrelated/live?sql=${encodeURIComponent("select id from todos")}`,
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    await write("unrelated", "insert into other(v) values ('elsewhere')")
    await expect(collectSse(stream, 2, 400)).rejects.toThrow(/got 1/)
  })

  test("a live query must be read-only and must name real columns", async () => {
    await fresh("livebad")
    const write1 = await sse(
      `/v1/db/livebad/live?sql=${encodeURIComponent("insert into todos(title) values ('no')")}`,
    )
    expect(write1.status).toBe(400)
    const badKey = await sse(
      `/v1/db/livebad/live?sql=${encodeURIComponent("select id from todos")}&key=nope`,
    )
    expect(badKey.status).toBe(400)
    const noSql = await sse("/v1/db/livebad/live")
    expect(noSql.status).toBe(400)
  })

  test("a live query runs under its subscriber's table ACL", async () => {
    await fresh("liveacl")
    const { token } = await server.token({
      dbs: ["liveacl"],
      scope: "ro",
      tables: { todos: "r" },
    })
    const allowed = await server.fetch(
      `/v1/db/liveacl/live?sql=${encodeURIComponent("select id from todos")}`,
      { token, headers: { accept: "text/event-stream" } },
    )
    expect(allowed.status).toBe(200)
    await allowed.body?.cancel()

    const denied = await server.fetch(
      `/v1/db/liveacl/live?sql=${encodeURIComponent("select v from other")}`,
      { token, headers: { accept: "text/event-stream" } },
    )
    expect(denied.status).toBe(403)
  })
})

describe("long poll", () => {
  test("a wait that sees a commit returns it as JSON", async () => {
    await fresh("poll")
    await write("poll", "insert into todos(title) values ('before')")
    const current = Number(
      (await server.fetch("/v1/db/poll/query", { method: "POST", body: '{"sql":"select 1"}' }))
        .headers.get("BQL-Txid"),
    )
    const waiting = server.fetch(`/v1/db/poll/changes?since=${current}&wait=3000`)
    await new Promise((resolve) => setTimeout(resolve, 30))
    await write("poll", "insert into todos(title) values ('after')")
    const response = await waiting
    expect(response.status).toBe(200)
    const events = (await response.json()) as ChangeEvent[]
    expect(events).toHaveLength(1)
    expect(events[0]?.changes[0]?.table).toBe("todos")
    expect(response.headers.get("cache-control")).toContain("immutable")
  })

  test("a wait that sees nothing returns an empty array", async () => {
    await fresh("pollempty")
    const current = Number(
      (
        await server.fetch("/v1/db/pollempty/query", { method: "POST", body: '{"sql":"select 1"}' })
      ).headers.get("BQL-Txid"),
    )
    const response = await server.fetch(`/v1/db/pollempty/changes?since=${current}&wait=100`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  test("a client that sends no Accept still gets the stream, not the poll", async () => {
    await fresh("plainaccept")
    const response = await server.fetch("/v1/db/plainaccept/changes")
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")
    await response.body?.cancel()

    const asJson = await server.fetch("/v1/db/plainaccept/changes?wait=0", {
      headers: { accept: "application/json" },
    })
    expect(asJson.headers.get("content-type")).toContain("application/json")
  })

  test("a position older than the ring is 409 RESET_REQUIRED", async () => {
    await fresh("pollold")
    await write("pollold", "insert into todos(title) values ('one')")
    const response = await server.fetch("/v1/db/pollold/changes?since=1&wait=10")
    expect(response.status).toBe(409)
    expect(((await response.json()) as ErrorBody).error.code).toBe("RESET_REQUIRED")
  })
})
