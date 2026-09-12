// The parts of promotion that live in the server rather than in the control plane: the live
// per-database role every gate reads, the `moved` frame a socket is told about, and the fact that
// a fenced database stops being writable in the same request.

import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { createDb, openSocket, startTestServer, stopAll, type TestServer } from "./harness.ts"
import { httpBase, replicationUrl } from "../../src/server/promote.ts"

let server: TestServer

beforeEach(async () => {
  server = await startTestServer()
})
afterAll(stopAll)

describe("the live role", () => {
  test("is per database, and a fenced one stops being writable at once", async () => {
    await createDb(server, "acme", "create table t (v text)")
    await createDb(server, "beta", "create table t (v text)")

    expect(server.handle.runtime.roleFor("acme")).toBe("primary")
    const wrote = await server.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t (v) values ('one')" }),
    })
    expect(wrote.status).toBe(200)

    // Fence `acme` and nothing else.
    server.handle.runtime.promoter.demote("acme", "another node took it", {
      node: "n2",
      url: "http://127.0.0.1:9",
    })
    expect(server.handle.runtime.roleFor("acme")).toBe("replica")
    expect(server.handle.runtime.roleFor("beta")).toBe("primary")

    const refused = await server.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t (v) values ('two')" }),
    })
    expect(refused.status).toBe(503)
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("NOT_PRIMARY")
    expect(refused.headers.get("BunQL-Role")).toBe("replica")
    expect(refused.headers.get("BunQL-Primary")).toBe("http://127.0.0.1:9")

    // Reads still work: the copy is a copy, and serving it is the whole point of a replica.
    const read = await server.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "select v from t" }),
    })
    expect(read.status).toBe(200)
    expect(((await read.json()) as { rows: unknown[][] }).rows).toEqual([["one"]])

    // And the other database is untouched, including its header.
    const other = await server.fetch("/v1/db/beta/query", {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t (v) values ('fine')" }),
    })
    expect(other.status).toBe(200)
    expect(other.headers.get("BunQL-Role")).toBe("primary")
    expect(other.headers.get("BunQL-Primary")).toBeNull()
  })

  test("the lifecycle gate follows the database, not the node", async () => {
    await createDb(server, "acme")
    server.handle.runtime.promoter.demote("acme", "moved", { node: "n2" })

    // `DELETE /v1/db/acme` is refused because *acme* is not this node's to delete…
    expect((await server.fetch("/v1/db/acme", { method: "DELETE" })).status).toBe(503)
    // …while `POST /v1/db` is a node-level question, and this node is still a primary.
    const created = await server.fetch("/v1/db", {
      method: "POST",
      body: JSON.stringify({ name: "gamma" }),
    })
    expect(created.status).toBe(201)
  })
})

describe("the moved frame (design §5.3)", () => {
  test("every socket that has named the database is told where it went", async () => {
    await createDb(server, "acme", "create table t (v text)")
    const socket = await openSocket(server.wsUrl(`?token=${server.adminKey}`))
    try {
      // Naming the database is what joins the topic; a socket that has never touched `acme` has
      // nothing tied to this node for it and is deliberately not told.
      socket.send({ id: 1, op: "query", db: "acme", sql: "select 1" })
      await socket.next<{ id: number }>((message) => message.id === 1)

      server.handle.runtime.promoter.demote("acme", "another node took it", {
        node: "n2",
        url: "http://127.0.0.1:9",
      })

      const moved = await socket.next<{ event: string; db: string; primary: string }>(
        (message) => message.event === "moved",
      )
      expect(moved).toEqual({ event: "moved", db: "acme", primary: "http://127.0.0.1:9" })
    } finally {
      socket.close()
    }
  })
})

describe("the URL forms a client is handed", () => {
  test("a replication socket and an advertise address collapse to the same origin", () => {
    expect(httpBase("ws://h:4321/v1/replication")).toBe("http://h:4321")
    expect(httpBase("wss://h/v1/replication")).toBe("https://h")
    expect(httpBase("ws://127.0.0.1:4321")).toBe("http://127.0.0.1:4321")
    expect(httpBase("http://h:4321")).toBe("http://h:4321")
    expect(httpBase(null)).toBeNull()
    expect(httpBase("not a url")).toBeNull()
  })

  test("and back again, for a node that has to follow the one that took its database", () => {
    expect(replicationUrl("http://h:4321")).toBe("ws://h:4321/v1/replication")
    expect(replicationUrl("https://h/")).toBe("wss://h/v1/replication")
  })
})
