// Who may do what, end to end. Every case is a real request against a real listener, because the
// point of design §4.7 is that SQLite enforces the policy, not the router.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { ErrorBody, QueryResult } from "../../src/client/protocol.ts"
import { mintToken } from "../../src/server/auth.ts"
import { createDb, startTestServer, stopAll, type TestServer } from "./harness.ts"

let server: TestServer

beforeAll(async () => {
  server = await startTestServer()
  await createDb(
    server,
    "acme",
    `create table todos(id integer primary key, title text);
     create table secrets(id integer primary key, value text);
     insert into todos(title) values ('write it');
     insert into secrets(value) values ('hunter2')`,
  )
  await createDb(server, "other", "create table t(id integer primary key)")
})
afterAll(stopAll)

function ask(route: string, sql: string, token: string | null): Promise<Response> {
  return server.fetch(route, { method: "POST", token, body: JSON.stringify({ sql }) })
}

describe("credentials", () => {
  test("no token at all is a 401", async () => {
    expect((await ask("/v1/db/acme/query", "select 1", null)).status).toBe(401)
  })

  test("a token that is not a JWT is a 401", async () => {
    expect((await ask("/v1/db/acme/query", "select 1", "not-a-token")).status).toBe(401)
  })

  test("the admin key opens every route", async () => {
    expect((await ask("/v1/db/acme/query", "select 1", server.adminKey)).status).toBe(200)
    expect((await server.fetch("/v1/db")).status).toBe(200)
  })

  test("a token may also travel in ?token=, which is all EventSource can do", async () => {
    const { token } = await server.token({ dbs: ["acme"], scope: "ro" })
    const response = await server.fetch(
      `/v1/db/acme/query?token=${encodeURIComponent(token)}`,
      { method: "POST", token: null, body: JSON.stringify({ sql: "select 1" }) },
    )
    expect(response.status).toBe(200)
  })
})

describe("scope", () => {
  test("a read-write token reads and writes its own database", async () => {
    const { token } = await server.token({ dbs: ["acme"], scope: "rw" })
    expect((await ask("/v1/db/acme/query", "select count(*) from todos", token)).status).toBe(200)
    expect(
      (await ask("/v1/db/acme/query", "insert into todos(title) values ('rw')", token)).status,
    ).toBe(200)
  })

  test("a read-only token reads but cannot write", async () => {
    const { token } = await server.token({ dbs: ["acme"], scope: "ro" })
    expect((await ask("/v1/db/acme/query", "select count(*) from todos", token)).status).toBe(200)
    const write = await ask("/v1/db/acme/query", "insert into todos(title) values ('ro')", token)
    expect(write.status).toBe(403)
    expect(((await write.json()) as ErrorBody).error.code).toBe("NOT_AUTHORIZED")
  })

  test("a read-only token cannot open a transaction either", async () => {
    const { token } = await server.token({ dbs: ["acme"], scope: "ro" })
    const response = await server.fetch("/v1/db/acme/tx", { method: "POST", token, body: "{}" })
    expect(response.status).toBe(403)
  })

  test("a token scoped elsewhere gets 403, not a hint that the database exists", async () => {
    const { token } = await server.token({ dbs: ["other"], scope: "rw" })
    expect((await ask("/v1/db/acme/query", "select 1", token)).status).toBe(403)
    expect((await ask("/v1/db/nowhere/query", "select 1", token)).status).toBe(403)
  })

  test("a glob covers the databases it matches and no others", async () => {
    await createDb(server, "acme-eu", "create table t(id integer primary key)")
    const { token } = await server.token({ dbs: ["acme-*"], scope: "rw" })
    expect((await ask("/v1/db/acme-eu/query", "select 1", token)).status).toBe(200)
    expect((await ask("/v1/db/other/query", "select 1", token)).status).toBe(403)
  })

  test("a table ACL hides everything it does not list", async () => {
    const { token } = await server.token({
      dbs: ["acme"],
      scope: "rw",
      tables: { todos: "rw" },
    })
    expect((await ask("/v1/db/acme/query", "select title from todos", token)).status).toBe(200)
    expect((await ask("/v1/db/acme/query", "select value from secrets", token)).status).toBe(403)
    expect(
      (await ask("/v1/db/acme/query", "insert into todos(title) values ('ok')", token)).status,
    ).toBe(200)
  })

  test("a read-only table in the ACL is readable but not writable", async () => {
    const { token } = await server.token({
      dbs: ["acme"],
      scope: "rw",
      tables: { todos: "r" },
    })
    expect((await ask("/v1/db/acme/query", "select title from todos", token)).status).toBe(200)
    expect(
      (await ask("/v1/db/acme/query", "insert into todos(title) values ('no')", token)).status,
    ).toBe(403)
  })

  test("no token may reach another database through ATTACH", async () => {
    const { token } = await server.token({ dbs: ["acme"], scope: "rw" })
    const response = await ask("/v1/db/acme/query", "attach database ':memory:' as m", token)
    expect(response.status).toBe(403)
  })
})

describe("lifetime", () => {
  test("an expired token is refused", async () => {
    const key = server.handle.runtime.auth.keys.signing
    const token = await mintToken(key, {
      rw: ["acme"],
      ttlMs: 1000,
      now: Date.now() - 10 * 60 * 1000,
    })
    const response = await ask("/v1/db/acme/query", "select 1", token)
    expect(response.status).toBe(401)
    expect(((await response.json()) as ErrorBody).error.message).toContain("expired")
  })

  test("a revoked token stops working immediately", async () => {
    const { token, jti } = await server.token({ dbs: ["acme"], scope: "ro" })
    expect((await ask("/v1/db/acme/query", "select 1", token)).status).toBe(200)
    const revoked = await server.fetch(`/v1/tokens/${jti}`, { method: "DELETE" })
    expect(revoked.status).toBe(200)
    const after = await ask("/v1/db/acme/query", "select 1", token)
    expect(after.status).toBe(401)
    expect(((await after.json()) as ErrorBody).error.message).toContain("revoked")
  })

  test("minting reports the jti and the expiry it signed", async () => {
    const minted = await server.token({ dbs: ["acme"], scope: "ro", ttl: 60 })
    expect(minted.jti).toMatch(/^[0-9a-f-]{36}$/)
    expect(minted.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  test("only the admin key may mint or revoke", async () => {
    const { token } = await server.token({ dbs: ["acme"], scope: "rw" })
    const minted = await server.fetch("/v1/tokens", {
      method: "POST",
      token,
      body: JSON.stringify({ dbs: ["acme"], scope: "ro" }),
    })
    expect(minted.status).toBe(403)
    expect((await server.fetch("/v1/tokens/whatever", { method: "DELETE", token })).status).toBe(403)
  })

  test("minting without a database glob is a 400", async () => {
    const response = await server.fetch("/v1/tokens", {
      method: "POST",
      body: JSON.stringify({ scope: "ro" }),
    })
    expect(response.status).toBe(400)
  })
})

describe("admin-only routes", () => {
  test("a scoped token may read its own stats but not the database list", async () => {
    const { token } = await server.token({ dbs: ["acme"], scope: "ro" })
    const stats = await server.fetch("/v1/db/acme", { token })
    expect(stats.status).toBe(200)
    expect((await server.fetch("/v1/db", { token })).status).toBe(403)
    expect((await server.fetch("/v1/db/acme", { method: "DELETE", token })).status).toBe(403)
    expect(
      (await server.fetch("/v1/db/acme/snapshot", { method: "POST", token })).status,
    ).toBe(403)
  })

  test("a write through a scoped token still lands under its own policy", async () => {
    const { token } = await server.token({ dbs: ["acme"], scope: "rw" })
    const result = (await server.json("/v1/db/acme/query", {
      method: "POST",
      token,
      body: JSON.stringify({ sql: "insert into todos(title) values ('scoped')" }),
    })) as QueryResult
    expect(result.rowsAffected).toBe(1)
  })
})
