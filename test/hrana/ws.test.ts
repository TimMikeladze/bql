// The `hrana3` / `hrana2` WebSocket protocol, driven by a real `WebSocket` client offering the
// same subprotocol list `@libsql/hrana-client` offers.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { openHranaSocket, startHrana, stopAllHrana, V, type TestHrana } from "./harness.ts"

let server: TestHrana

beforeAll(async () => {
  server = await startHrana()
  await server.createDb("ws", "create table t (id integer primary key, v text)")
  await server.createDb("default", "create table d (id integer primary key)")
})

afterAll(async () => {
  await stopAllHrana()
})

async function hello(path = "/v1/db/ws/hrana", protocols?: string[]) {
  const socket = await openHranaSocket(server.wsUrl(path), protocols)
  socket.send({ type: "hello", jwt: server.adminKey })
  const greeting = await socket.next()
  expect(greeting.type).toBe("hello_ok")
  return socket
}

describe("handshake", () => {
  test("the offered list negotiates down to hrana3, never to protobuf", async () => {
    const socket = await hello()
    expect(socket.protocol).toBe("hrana3")
    socket.close()
  })

  test("a hrana2-only client gets hrana2", async () => {
    const socket = await hello("/v1/db/ws/hrana", ["hrana2"])
    expect(socket.protocol).toBe("hrana2")
    socket.close()
  })

  test("a bad token is a hello_error and the socket closes", async () => {
    const socket = await openHranaSocket(server.wsUrl("/v1/db/ws/hrana"))
    const closed = new Promise<number>((resolve) =>
      socket.socket.addEventListener("close", (event) => resolve(event.code)),
    )
    socket.send({ type: "hello", jwt: "not-a-token" })
    const greeting = await socket.next()
    expect(greeting.type).toBe("hello_error")
    expect((greeting as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED")
    expect(await closed).toBe(1008)
  })

  test("a request before hello is refused", async () => {
    const socket = await openHranaSocket(server.wsUrl("/v1/db/ws/hrana"))
    const answer = await socket.request({ type: "open_stream", stream_id: 1 })
    expect(answer.type).toBe("response_error")
    expect((answer as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED")
    socket.close()
  })

  test("the root socket resolves its database the way the pipeline does", async () => {
    const socket = await hello("/")
    const opened = await socket.request({ type: "open_stream", stream_id: 1 })
    expect(opened.type).toBe("response_ok")
    const executed = await socket.request({
      type: "execute",
      stream_id: 1,
      stmt: { sql: "select count(*) from d" },
    })
    expect(executed.type).toBe("response_ok")
    socket.close()
  })
})

describe("streams", () => {
  test("open_stream, execute, close_stream", async () => {
    const socket = await hello()
    expect((await socket.request({ type: "open_stream", stream_id: 7 })).type).toBe("response_ok")
    const executed = await socket.request({
      type: "execute",
      stream_id: 7,
      stmt: { sql: "select ? as echo", args: [V.text("hi")] },
    })
    expect(executed.type).toBe("response_ok")
    const response = (executed as { response: { type: string; result: { rows: unknown[][] } } }).response
    expect(response.type).toBe("execute")
    expect(response.result.rows).toEqual([[V.text("hi")]])
    expect((await socket.request({ type: "close_stream", stream_id: 7 })).type).toBe("response_ok")

    const gone = await socket.request({
      type: "execute",
      stream_id: 7,
      stmt: { sql: "select 1" },
    })
    expect(gone.type).toBe("response_error")
    socket.close()
  })

  test("a second open_stream with the same id is refused", async () => {
    const socket = await hello()
    await socket.request({ type: "open_stream", stream_id: 1 })
    const again = await socket.request({ type: "open_stream", stream_id: 1 })
    expect(again.type).toBe("response_error")
    socket.close()
  })

  test("store_sql is shared by every stream on the socket", async () => {
    const socket = await hello()
    await socket.request({ type: "open_stream", stream_id: 1 })
    await socket.request({ type: "store_sql", sql_id: 5, sql: "select 'stored' as s" })
    await socket.request({ type: "open_stream", stream_id: 2 })
    const executed = await socket.request({ type: "execute", stream_id: 2, stmt: { sql_id: 5 } })
    expect(
      (executed as { response: { result: { rows: unknown[][] } } }).response.result.rows,
    ).toEqual([[V.text("stored")]])
    expect((await socket.request({ type: "close_sql", sql_id: 5 })).type).toBe("response_ok")
    socket.close()
  })

  test("describe and get_autocommit answer over the socket", async () => {
    const socket = await hello()
    await socket.request({ type: "open_stream", stream_id: 1 })
    const described = await socket.request({
      type: "describe",
      stream_id: 1,
      sql: "select id from t where id = ?",
    })
    const result = (described as { response: { result: { params: unknown[]; is_readonly: boolean } } })
      .response.result
    expect(result.params).toEqual([{ name: null }])
    expect(result.is_readonly).toBe(true)

    const auto = await socket.request({ type: "get_autocommit", stream_id: 1 })
    expect((auto as { response: { is_autocommit: boolean } }).response.is_autocommit).toBe(true)
    socket.close()
  })

  test("a transaction opened on a socket is rolled back when the socket closes", async () => {
    const socket = await hello()
    await socket.request({ type: "open_stream", stream_id: 1 })
    await socket.request({ type: "execute", stream_id: 1, stmt: { sql: "BEGIN IMMEDIATE" } })
    await socket.request({
      type: "execute",
      stream_id: 1,
      stmt: { sql: "insert into t (v) values ('lost')" },
    })
    socket.close()

    // The writer must come free again, which it only does if the transaction was rolled back.
    const other = await hello()
    await other.request({ type: "open_stream", stream_id: 1 })
    const counted = await other.request({
      type: "execute",
      stream_id: 1,
      stmt: { sql: "select count(*) from t where v = 'lost'" },
    })
    expect(
      (counted as { response: { result: { rows: unknown[][] } } }).response.result.rows,
    ).toEqual([[V.int(0)]])
    const began = await other.request({ type: "execute", stream_id: 1, stmt: { sql: "BEGIN IMMEDIATE" } })
    expect(began.type).toBe("response_ok")
    other.close()
  })
})

describe("batch and cursors over the socket", () => {
  test("a conditional batch behaves as it does over HTTP", async () => {
    const socket = await hello()
    await socket.request({ type: "open_stream", stream_id: 1 })
    const answered = await socket.request({
      type: "batch",
      stream_id: 1,
      batch: {
        steps: [
          { stmt: { sql: "BEGIN IMMEDIATE" } },
          { condition: { type: "ok", step: 0 }, stmt: { sql: "insert into t (v) values ('ws')" } },
          { condition: { type: "ok", step: 1 }, stmt: { sql: "COMMIT" } },
          { condition: { type: "not", cond: { type: "ok", step: 2 } }, stmt: { sql: "ROLLBACK" } },
        ],
      },
    })
    const result = (answered as { response: { result: { step_results: unknown[] } } }).response.result
    expect(result.step_results.map((r) => r !== null)).toEqual([true, true, true, false])
    socket.close()
  })

  test("open_cursor, fetch_cursor in slices, close_cursor", async () => {
    const socket = await hello()
    await socket.request({ type: "open_stream", stream_id: 1 })
    await socket.request({
      type: "execute",
      stream_id: 1,
      stmt: { sql: "insert into t (v) values ('c1'), ('c2'), ('c3')" },
    })
    expect(
      (
        await socket.request({
          type: "open_cursor",
          stream_id: 1,
          cursor_id: 1,
          batch: { steps: [{ stmt: { sql: "select v from t where v like 'c_' order by v" } }] },
        })
      ).type,
    ).toBe("response_ok")

    const first = await socket.request({ type: "fetch_cursor", cursor_id: 1, max_count: 2 })
    const firstPage = (first as { response: { entries: { type: string }[]; done: boolean } }).response
    expect(firstPage.entries.map((e) => e.type)).toEqual(["step_begin", "row"])
    expect(firstPage.done).toBe(false)

    const rest = await socket.request({ type: "fetch_cursor", cursor_id: 1, max_count: 100 })
    const restPage = (rest as { response: { entries: { type: string }[]; done: boolean } }).response
    expect(restPage.entries.map((e) => e.type)).toEqual(["row", "row", "step_end"])
    expect(restPage.done).toBe(true)

    expect((await socket.request({ type: "close_cursor", cursor_id: 1 })).type).toBe("response_ok")
    socket.close()
  })

  test("cursors are refused on hrana2", async () => {
    const socket = await hello("/v1/db/ws/hrana", ["hrana2"])
    await socket.request({ type: "open_stream", stream_id: 1 })
    const refused = await socket.request({
      type: "open_cursor",
      stream_id: 1,
      cursor_id: 1,
      batch: { steps: [{ stmt: { sql: "select 1" } }] },
    })
    expect(refused.type).toBe("response_error")
    expect((refused as { error: { message: string } }).error.message).toContain("hrana3")
    socket.close()
  })
})

describe("ordering and errors", () => {
  test("pipelined requests are answered in order", async () => {
    const socket = await hello()
    await socket.request({ type: "open_stream", stream_id: 1 })
    const ids = [10, 11, 12, 13]
    for (const id of ids) {
      socket.send({
        type: "request",
        request_id: id,
        request: { type: "execute", stream_id: 1, stmt: { sql: `select ${id} as n` } },
      })
    }
    const seen: number[] = []
    for (let i = 0; i < ids.length; i++) {
      const message = await socket.next((m) => m.type === "response_ok" || m.type === "response_error")
      seen.push((message as { request_id: number }).request_id)
    }
    expect(seen).toEqual(ids)
    socket.close()
  })

  test("a failing statement is a response_error with our code, and the socket stays open", async () => {
    const socket = await hello()
    await socket.request({ type: "open_stream", stream_id: 1 })
    const failed = await socket.request({
      type: "execute",
      stream_id: 1,
      stmt: { sql: "select * from nowhere" },
    })
    expect(failed.type).toBe("response_error")
    expect((failed as { error: { code: string } }).error.code).toBe("SQLITE_ERROR")
    const after = await socket.request({ type: "execute", stream_id: 1, stmt: { sql: "select 1" } })
    expect(after.type).toBe("response_ok")
    socket.close()
  })

  test("an unknown request type is an error rather than a dropped socket", async () => {
    const socket = await hello()
    const answer = await socket.request({ type: "teleport", stream_id: 1 })
    expect(answer.type).toBe("response_error")
    socket.close()
  })
})
