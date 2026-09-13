// The WebSocket protocol of design §7, against a real socket: authentication, pipelining and
// ordering, transactions, subscriptions, and what a closing socket has to clean up.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type {
  ChangeEvent,
  LiveDiffEvent,
  LiveRowsEvent,
  QueryResult,
} from "../../src/client/protocol.ts"
import { WS_PROTOCOL } from "../../src/client/protocol.ts"
import {
  createDb,
  openSocket,
  startTestServer,
  stopAll,
  type TestServer,
  type TestSocket,
} from "./harness.ts"

let server: TestServer

interface Reply {
  id?: number
  ok?: boolean
  error?: { code: string; message: string; status: number }
  result?: QueryResult
  tx?: string
  txid?: number
  sub?: string
  subs?: string[]
  event?: string
  data?: unknown
}

beforeAll(async () => {
  server = await startTestServer({ limits: { txIdleTimeoutMs: 1000 } })
  await createDb(
    server,
    "acme",
    `create table todos(id integer primary key, title text, done integer default 0);
     create table other(id integer primary key, v text)`,
  )
  await createDb(server, "beta", "create table b(id integer primary key, v text)")
})
afterAll(stopAll)

/** A socket authenticated with the admin key through the query string, already greeted. */
async function connect(token = server.adminKey): Promise<TestSocket> {
  const socket = await openSocket(server.wsUrl(`?token=${encodeURIComponent(token)}`))
  await socket.next((m: Reply) => m.event === "hello")
  return socket
}

function reply(socket: TestSocket, id: number): Promise<Reply> {
  return socket.next((m: Reply) => m.id === id)
}

describe("handshake", () => {
  test("a token in the query string authenticates the socket and is greeted", async () => {
    const socket = await openSocket(server.wsUrl(`?token=${encodeURIComponent(server.adminKey)}`))
    const hello = await socket.next((m: Reply) => m.event === "hello")
    expect(hello).toMatchObject({
      event: "hello",
      protocol: WS_PROTOCOL,
      node: "test-node",
      role: "primary",
    })
    expect(socket.socket.protocol).toBe(WS_PROTOCOL)
    socket.close()
  })

  test("a socket with no credential must say hello before anything else", async () => {
    const socket = await openSocket(server.wsUrl())
    socket.send({ id: 1, op: "query", db: "acme", sql: "select 1" })
    const refused = await reply(socket, 1)
    expect(refused.ok).toBe(false)
    expect(refused.error?.code).toBe("UNAUTHENTICATED")

    socket.send({ id: 2, op: "hello", token: server.adminKey })
    expect((await reply(socket, 2)).ok).toBe(true)
    await socket.next((m: Reply) => m.event === "hello")
    socket.send({ id: 3, op: "query", db: "acme", sql: "select 1" })
    expect((await reply(socket, 3)).ok).toBe(true)
    socket.close()
  })

  test("hello with a bad token leaves the socket unauthenticated", async () => {
    const socket = await openSocket(server.wsUrl())
    socket.send({ id: 1, op: "hello", token: "nonsense" })
    expect((await reply(socket, 1)).error?.code).toBe("UNAUTHENTICATED")
    socket.close()
  })

  test("ping is answered", async () => {
    const socket = await connect()
    socket.send({ op: "ping" })
    expect(await socket.next((m: Reply) => m.event === "pong")).toEqual({ event: "pong" })
    socket.send({ id: 7, op: "ping" })
    expect((await reply(socket, 7)).ok).toBe(true)
    socket.close()
  })
})

describe("statements", () => {
  test("a query echoes its id and carries the same result shape as HTTP", async () => {
    const socket = await connect()
    socket.send({ id: 1, op: "query", db: "acme", sql: "select 1 as n" })
    const answer = await reply(socket, 1)
    expect(answer.ok).toBe(true)
    expect(answer.result?.columns).toEqual(["n"])
    expect(answer.result?.rows).toEqual([[1]])
    expect(answer.result?.txid).toBeGreaterThanOrEqual(0)
    socket.close()
  })

  test("requests for one database are answered in order", async () => {
    const socket = await connect()
    for (let i = 1; i <= 8; i++) {
      socket.send({ id: i, op: "query", db: "acme", sql: "insert into todos(title) values (?)", args: [`p${i}`] })
    }
    const order: number[] = []
    for (let i = 0; i < 8; i++) {
      const answer = (await socket.next(
        (m: Reply) => typeof m.id === "number" && m.id >= 1 && m.id <= 8,
      )) as Reply
      order.push(answer.id as number)
    }
    expect(order).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    socket.close()
  })

  test("a slow request on one database does not hold up another", async () => {
    const socket = await connect()
    // This one waits for a txid that will never arrive on `beta`, so it sits there.
    socket.send({ id: 1, op: "query", db: "beta", sql: "select 1", minTxid: 999_999 })
    socket.send({ id: 2, op: "query", db: "acme", sql: "select 1" })
    const first = await reply(socket, 2)
    expect(first.ok).toBe(true)
    const stalled = await reply(socket, 1)
    expect(stalled.error?.code).toBe("TXID_NOT_AVAILABLE")
    socket.close()
  })

  test("a batch runs as one transaction", async () => {
    const socket = await connect()
    socket.send({
      id: 1,
      op: "batch",
      db: "beta",
      statements: [{ sql: "insert into b(v) values ('x')" }, { sql: "select count(*) as n from b" }],
    })
    const answer = (await reply(socket, 1)) as Reply & {
      result: { results: QueryResult[]; txid: number }
    }
    expect(answer.result.results).toHaveLength(2)
    expect(answer.result.results[0]?.txid).toBe(answer.result.txid)
    socket.close()
  })

  test("errors come back as ok: false with the same codes HTTP uses", async () => {
    const socket = await connect()
    socket.send({ id: 1, op: "query", db: "acme", sql: "bogus" })
    expect((await reply(socket, 1)).error?.code).toBe("SQLITE_ERROR")
    socket.send({ id: 2, op: "query", db: "missing", sql: "select 1" })
    expect((await reply(socket, 2)).error?.code).toBe("DB_NOT_FOUND")
    socket.send({ id: 3, op: "nonsense" })
    expect((await reply(socket, 3)).error?.code).toBe("BAD_REQUEST")
    socket.send({ id: 4, op: "query", sql: "select 1" })
    expect((await reply(socket, 4)).error?.code).toBe("BAD_REQUEST")
    socket.close()
  })

  test("a read-only token cannot write or open a transaction", async () => {
    const { token } = await server.token({ dbs: ["acme"], scope: "ro" })
    const socket = await connect(token)
    socket.send({ id: 1, op: "query", db: "acme", sql: "insert into todos(title) values ('no')" })
    expect((await reply(socket, 1)).error?.code).toBe("NOT_AUTHORIZED")
    socket.send({ id: 2, op: "tx.begin", db: "acme" })
    expect((await reply(socket, 2)).error?.code).toBe("NOT_AUTHORIZED")
    socket.send({ id: 3, op: "query", db: "acme", sql: "select count(*) from todos" })
    expect((await reply(socket, 3)).ok).toBe(true)
    socket.close()
  })
})

describe("transactions over the socket", () => {
  test("begin, statement, commit", async () => {
    const socket = await connect()
    socket.send({ id: 1, op: "tx.begin", db: "beta" })
    const begun = await reply(socket, 1)
    expect(begun.tx).toMatch(/^[0-9a-f]{32}$/)
    socket.send({ id: 2, op: "query", tx: begun.tx, sql: "insert into b(v) values ('in tx')" })
    expect((await reply(socket, 2)).result?.rowsAffected).toBe(1)
    socket.send({ id: 3, op: "tx.commit", tx: begun.tx })
    const committed = await reply(socket, 3)
    expect(committed.ok).toBe(true)
    expect(committed.txid).toBeGreaterThan(0)
    socket.close()
  })

  test("a rollback discards the statements", async () => {
    const socket = await connect()
    socket.send({ id: 1, op: "query", db: "beta", sql: "select count(*) as n from b" })
    const before = (await reply(socket, 1)).result?.rows[0] as number[]
    socket.send({ id: 2, op: "tx.begin", db: "beta" })
    const begun = await reply(socket, 2)
    socket.send({ id: 3, op: "query", tx: begun.tx, sql: "insert into b(v) values ('gone')" })
    await reply(socket, 3)
    socket.send({ id: 4, op: "tx.rollback", tx: begun.tx })
    await reply(socket, 4)
    socket.send({ id: 5, op: "query", db: "beta", sql: "select count(*) as n from b" })
    expect((await reply(socket, 5)).result?.rows[0]).toEqual(before as never)
    socket.close()
  })

  test("closing the socket rolls back the transaction it was holding", async () => {
    const socket = await connect()
    socket.send({ id: 1, op: "tx.begin", db: "beta" })
    const begun = await reply(socket, 1)
    socket.send({ id: 2, op: "query", tx: begun.tx, sql: "insert into b(v) values ('abandoned')" })
    await reply(socket, 2)
    socket.close()

    await Bun.sleep(120)
    const opened = await server.fetch("/v1/db/beta/tx", { method: "POST", body: "{}" })
    expect(opened.status).toBe(200)
    const { tx } = (await opened.json()) as { tx: string }
    await server.fetch(`/v1/db/beta/tx/${tx}/rollback`, { method: "POST" })
    const rows = await server.json<QueryResult>("/v1/db/beta/query", {
      method: "POST",
      body: JSON.stringify({ sql: "select count(*) from b where v = 'abandoned'" }),
    })
    expect(rows.rows).toEqual([[0]])
  })

  test("another socket cannot use a baton it does not own", async () => {
    const first = await connect()
    first.send({ id: 1, op: "tx.begin", db: "beta" })
    const begun = await reply(first, 1)
    const second = await connect()
    second.send({ id: 1, op: "query", tx: begun.tx, sql: "select 1" })
    expect((await reply(second, 1)).error?.code).toBe("NOT_AUTHORIZED")
    first.send({ id: 2, op: "tx.rollback", tx: begun.tx })
    await reply(first, 2)
    first.close()
    second.close()
  })
})

describe("subscriptions", () => {
  test("a change subscription is named by its topic and receives commits", async () => {
    const socket = await connect()
    socket.send({ id: 1, op: "subscribe", db: "acme", kind: "changes" })
    const subscribed = await reply(socket, 1)
    expect(subscribed.sub).toBe("db:acme:changes")
    expect(subscribed.subs).toEqual(["db:acme:changes", "db:acme:schema"])

    await server.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "insert into todos(title) values ('over ws')" }),
    })
    const pushed = (await socket.next((m: Reply) => m.event === "change")) as Reply
    expect(pushed.sub).toBe("db:acme:changes")
    expect((pushed.data as ChangeEvent).changes[0]?.table).toBe("todos")
    socket.close()
  })

  test("a table subscription only sees its own table", async () => {
    const socket = await connect()
    socket.send({ id: 1, op: "subscribe", db: "acme", kind: "changes", tables: ["other"] })
    const subscribed = await reply(socket, 1)
    expect(subscribed.sub).toBe("db:acme:changes:other")

    await server.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "insert into todos(title) values ('ignored')" }),
    })
    await server.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "insert into other(v) values ('wanted')" }),
    })
    const pushed = (await socket.next((m: Reply) => m.event === "change")) as Reply
    expect((pushed.data as ChangeEvent).changes.every((c) => c.table === "other")).toBe(true)
    socket.close()
  })

  test("a live subscription sends rows then diffs, and stops on unsubscribe", async () => {
    const socket = await connect()
    socket.send({
      id: 1,
      op: "subscribe",
      db: "beta",
      kind: "live",
      sql: "select id, v from b",
      key: "id",
    })
    const subscribed = await reply(socket, 1)
    expect(subscribed.sub).toStartWith("db:beta:live:")
    const initial = (await socket.next((m: Reply) => m.event === "rows")) as Reply
    expect((initial.data as LiveRowsEvent).columns).toEqual(["id", "v"])

    await server.fetch("/v1/db/beta/query", {
      method: "POST",
      body: JSON.stringify({ sql: "insert into b(v) values ('live')" }),
    })
    const diff = (await socket.next((m: Reply) => m.event === "diff")) as Reply
    expect((diff.data as LiveDiffEvent).added).toHaveLength(1)

    socket.send({ id: 2, op: "unsubscribe", sub: subscribed.sub })
    expect((await reply(socket, 2)).ok).toBe(true)
    await server.fetch("/v1/db/beta/query", {
      method: "POST",
      body: JSON.stringify({ sql: "insert into b(v) values ('after')" }),
    })
    await Bun.sleep(120)
    expect(socket.seen.some((m) => (m as Reply).event === "diff")).toBe(false)
    socket.close()
  })

  test("a since the ring cannot serve is answered with reset", async () => {
    await createDb(server, "wsreset", "create table t(id integer primary key)")
    await server.fetch("/v1/db/wsreset/query", {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t default values" }),
    })
    const socket = await connect()
    socket.send({ id: 1, op: "subscribe", db: "wsreset", kind: "changes", since: 1 })
    await reply(socket, 1)
    const reset = (await socket.next((m: Reply) => m.event === "reset")) as Reply
    expect(reset.sub).toBe("db:wsreset:changes")
    socket.close()
  })

  test("unsubscribing from something that was never subscribed is an error", async () => {
    const socket = await connect()
    socket.send({ id: 1, op: "unsubscribe", sub: "db:acme:live:s99" })
    expect((await reply(socket, 1)).error?.code).toBe("BAD_REQUEST")
    socket.close()
  })
})
