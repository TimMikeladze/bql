// The four routes H6 mounted, over a real listening server. Nothing here is a mock: the point is
// that the generated surfaces reach `src/server/exec.ts` and inherit what lives there — the
// token's per-table ACLs above all — and that cannot be shown against a fake (`docs/h6-mount.md`).

import { afterAll, describe, expect, test } from "bun:test"
import { HEADERS } from "../../src/client/protocol.ts"
import { graphqlAvailable } from "../../src/graphql/index.ts"
import { createDb, startTestServer } from "./harness.ts"

const server = await startTestServer()
afterAll(() => server.close())

const DB = "shop"
await createDb(
  server,
  DB,
  `CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
   CREATE TABLE secrets (id INTEGER PRIMARY KEY, value TEXT);
   INSERT INTO users (name, email) VALUES ('ann', 'ann@example.com')`,
)

const peers = await graphqlAvailable()

describe("the generated data API", () => {
  test("lists, filters, projects and orders", async () => {
    const all = await server.json<Record<string, unknown>[]>(`/v1/db/${DB}/api/users`)
    expect(all).toEqual([{ id: 1, name: "ann", email: "ann@example.com" }])

    const projected = await server.json<Record<string, unknown>[]>(
      `/v1/db/${DB}/api/users?name=like.an*&select=id,name&order=id.desc`,
    )
    expect(projected).toEqual([{ id: 1, name: "ann" }])
  })

  test("reads one row by primary key, and 404s for one that is not there", async () => {
    expect(await server.json(`/v1/db/${DB}/api/users/1`)).toMatchObject({ name: "ann" })
    const missing = await server.fetch(`/v1/db/${DB}/api/users/9999`)
    expect(missing.status).toBe(404)
    expect((await missing.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "NOT_FOUND", status: 404 },
    })
  })

  test("writes, and the answer carries the row and the txid the write got", async () => {
    const before = Number(
      (await server.fetch(`/v1/db/${DB}/api/users`)).headers.get(HEADERS.txid),
    )
    const created = await server.fetch(`/v1/db/${DB}/api/users`, {
      method: "POST",
      body: JSON.stringify({ name: "bob", email: "bob@example.com" }),
    })
    expect(created.status).toBe(201)
    expect(await created.json()).toEqual([{ id: 2, name: "bob", email: "bob@example.com" }])
    // `BunQL-Txid` is the wrapper's, filled in from the statement the generated handler ran —
    // which is the whole proof that the data API went through `exec.ts` rather than around it.
    expect(Number(created.headers.get(HEADERS.txid))).toBeGreaterThan(before)

    const patched = await server.fetch(`/v1/db/${DB}/api/users/2`, {
      method: "PATCH",
      body: JSON.stringify({ email: "bob@bunql.dev" }),
    })
    expect(await patched.json()).toMatchObject({ email: "bob@bunql.dev" })

    const deleted = await server.fetch(`/v1/db/${DB}/api/users/2`, { method: "DELETE" })
    expect(await deleted.json()).toMatchObject({ name: "bob" })
    expect(await server.json(`/v1/db/${DB}/api/users`)).toHaveLength(1)
  })

  test("a filter naming a column the table does not have is a 400, not a query", async () => {
    const response = await server.fetch(`/v1/db/${DB}/api/users?nope=eq.1`)
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("BAD_REQUEST")
    expect(body.error.message).toContain("nope")
  })

  test("an unknown table is a 404 from the router", async () => {
    const response = await server.fetch(`/v1/db/${DB}/api/nosuchtable`)
    expect(response.status).toBe(404)
  })

  test("the token's rights decide, because the statement goes through exec.ts", async () => {
    const anonymous = await server.fetch(`/v1/db/${DB}/api/users`, { token: null })
    expect(anonymous.status).toBe(401)

    const elsewhere = await server.token({ dbs: ["other"], scope: "rw" })
    const wrongDb = await server.fetch(`/v1/db/${DB}/api/users`, { token: elsewhere.token })
    expect(wrongDb.status).toBe(403)

    const readonly = await server.token({ dbs: [DB], scope: "ro" })
    expect((await server.fetch(`/v1/db/${DB}/api/users`, { token: readonly.token })).status).toBe(200)
    const refused = await server.fetch(`/v1/db/${DB}/api/users`, {
      token: readonly.token,
      method: "POST",
      body: JSON.stringify({ name: "mallory" }),
    })
    expect(refused.status).toBe(403)

    // A per-table ACL narrows it further, and the authorizer — not this surface — is what refuses.
    const scoped = await server.token({ dbs: [DB], scope: "rw", tables: { users: "r" } })
    expect((await server.fetch(`/v1/db/${DB}/api/users`, { token: scoped.token })).status).toBe(200)
    expect(
      (await server.fetch(`/v1/db/${DB}/api/secrets`, { token: scoped.token })).status,
    ).toBe(403)
    const write = await server.fetch(`/v1/db/${DB}/api/users`, {
      token: scoped.token,
      method: "POST",
      body: JSON.stringify({ name: "mallory" }),
    })
    expect(write.status).toBe(403)
  })
})

describe("the per-database document", () => {
  test("describes that database's tables, with a server URL a client can use", async () => {
    const document = await server.json<{
      info: { title: string }
      servers: { url: string }[]
      paths: Record<string, unknown>
      components: { schemas: Record<string, unknown> }
    }>(`/v1/db/${DB}/openapi.json`)
    expect(document.info.title).toContain(DB)
    expect(document.servers[0]?.url).toBe(`${server.url}/v1/db/${DB}/api`)
    expect(Object.keys(document.paths).sort()).toEqual([
      "/secrets",
      "/secrets/{id}",
      "/users",
      "/users/{id}",
    ])
    expect(Object.keys(document.components.schemas)).toContain("User")
  })

  test("needs read access to that database, because it discloses the schema", async () => {
    const elsewhere = await server.token({ dbs: ["other"], scope: "rw" })
    const response = await server.fetch(`/v1/db/${DB}/openapi.json`, { token: elsewhere.token })
    expect(response.status).toBe(403)
  })

  test("follows a DDL statement, without anything invalidating a cache by hand", async () => {
    await server.fetch(`/v1/db/${DB}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)" }),
    })
    const document = await server.json<{ paths: Record<string, unknown> }>(
      `/v1/db/${DB}/openapi.json`,
    )
    expect(Object.keys(document.paths)).toContain("/notes")
    expect(await server.json<unknown[]>(`/v1/db/${DB}/api/notes`)).toEqual([])
  })
})

describe.if(peers)("the generated GraphQL surface", () => {
  const gql = (query: string, token?: string | null) =>
    server.fetch(`/v1/db/${DB}/graphql`, {
      method: "POST",
      body: JSON.stringify({ query }),
      ...(token !== undefined ? { token } : {}),
    })

  test("serves fields generated from the same document REST publishes", async () => {
    const response = await gql("{ listUsers(limit: 5) { id name email } }")
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { listUsers: Record<string, unknown>[] } }
    expect(body.data.listUsers).toEqual([{ id: 1, name: "ann", email: "ann@example.com" }])
  })

  test("a mutation writes through exec.ts, and the txid reaches the wrapper", async () => {
    const response = await gql('mutation { createNote(input: { body: "hi" }) { id body } }')
    const body = (await response.json()) as { data: { createNote: Record<string, unknown>[] } }
    expect(body.data.createNote).toEqual([{ id: 1, body: "hi" }])
    expect(Number(response.headers.get(HEADERS.txid))).toBeGreaterThan(0)
    // The same row, through the other surface.
    expect(await server.json<unknown[]>(`/v1/db/${DB}/api/notes`)).toEqual([{ id: 1, body: "hi" }])
  })

  test("a read-only token cannot mutate, and the refusal keeps BunQL's code", async () => {
    const readonly = await server.token({ dbs: [DB], scope: "ro" })
    const response = await gql('mutation { createNote(input: { body: "no" }) { id } }', readonly.token)
    const body = (await response.json()) as {
      errors: { extensions?: { code?: string } }[]
    }
    expect(body.errors?.[0]?.extensions?.code).toBe("NOT_AUTHORIZED")
  })

  test("GraphiQL is served to a browser", async () => {
    const response = await server.fetch(`/v1/db/${DB}/graphql`, {
      headers: { accept: "text/html" },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/html")
  })
})

describe("a database that is deleted and re-made", () => {
  test("does not serve the old schema, which the version counter alone cannot catch", async () => {
    const name = "ephemeral"
    await createDb(server, name, "CREATE TABLE alpha (id INTEGER PRIMARY KEY)")
    expect((await server.fetch(`/v1/db/${name}/api/alpha`)).status).toBe(200)

    await server.fetch(`/v1/db/${name}`, { method: "DELETE" })
    // A new database of the same name starts `PRAGMA schema_version` over at 1, so a cache that
    // trusted only the counter would serve `alpha` for a database that has never had it.
    await createDb(server, name, "CREATE TABLE beta (id INTEGER PRIMARY KEY)")
    expect((await server.fetch(`/v1/db/${name}/api/alpha`)).status).toBe(404)
    expect((await server.fetch(`/v1/db/${name}/api/beta`)).status).toBe(200)
  })
})

describe("a node with the surfaces turned off", () => {
  test("has no routes for them at all, rather than routes that refuse", async () => {
    const off = await startTestServer({ api: { enabled: false } })
    try {
      await createDb(off, "quiet", "CREATE TABLE t (id INTEGER PRIMARY KEY)")
      expect((await off.fetch("/v1/db/quiet/api/t")).status).toBe(404)
      expect((await off.fetch("/v1/db/quiet/openapi.json")).status).toBe(404)
      expect((await off.fetch("/v1/db/quiet/graphql", { method: "POST", body: "{}" })).status).toBe(404)
      // The node's own API is untouched: only the generated surfaces went.
      expect((await off.fetch("/v1/db/quiet")).status).toBe(200)
      const document = await off.json<{ paths: Record<string, unknown> }>("/v1/openapi.json", {
        token: null,
      })
      expect(Object.keys(document.paths).some((p) => p.includes("/api/"))).toBe(false)
      expect(Object.keys(document.paths)).toContain("/v1/db/{db}/query")
    } finally {
      await off.close()
    }
  })
})
