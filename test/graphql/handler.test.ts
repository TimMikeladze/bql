// The endpoint against real rows. Four of these are not about GraphQL at all — they are about
// what the wiring must not lose on the way through a generated resolver and an in-process
// dispatch: the token's per-table ACL, a 64-bit integer, a BunQL error's code, and the limits that
// stand between a text query and an arbitrarily expensive one.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { MissingPeersError } from "../../src/graphql/index.ts"
import { graphqlFixture, type GraphQLFixture, ORIGIN } from "./harness.ts"
import { stopAll } from "../server/harness.ts"

const SCHEMA = `
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
  CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, total REAL);
  CREATE TABLE files (id INTEGER PRIMARY KEY, body BLOB);
  INSERT INTO users (id, name, email) VALUES (1, 'ann', 'ann@example.com');
  INSERT INTO orders (id, user_id, total) VALUES (1, 1, 12.5)`

let fixture: GraphQLFixture

beforeAll(async () => {
  fixture = await graphqlFixture("gqlhandler", SCHEMA)
  fixture.grant("ann", { users: "rw" })
})

afterAll(async () => {
  await stopAll()
})

describe("a query and a mutation", () => {
  test("a query answers with real rows", async () => {
    const { status, body } = await fixture.ask<{
      listUsers: { id: number; name: string; email: string | null }[]
    }>(`{ listUsers { id name email } }`)
    expect(status).toBe(200)
    expect(body.errors).toBeUndefined()
    expect(body.data?.listUsers).toEqual([{ id: 1, name: "ann", email: "ann@example.com" }])
  })

  test("a row by primary key, and a filter, are the same operations REST serves", async () => {
    const one = await fixture.ask<{ getUser: { name: string } | null }>(
      `{ getUser(id: "1") { name } }`,
    )
    expect(one.body.data?.getUser).toEqual({ name: "ann" })
    const filtered = await fixture.ask<{ listUsers: unknown[] }>(
      `{ listUsers(name: "eq.nobody") { id } }`,
    )
    expect(filtered.body.data?.listUsers).toEqual([])
  })

  test("a mutation writes a real row and answers with what SQLite stored", async () => {
    const created = await fixture.ask<{ createUser: { id: number; name: string }[] }>(
      `mutation { createUser(input: { name: "bo" }) { id name } }`,
    )
    expect(created.body.errors).toBeUndefined()
    const written = created.body.data?.createUser?.[0]
    expect(written?.name).toBe("bo")
    // Read it back through a second request, so the row is in the database and not in a response.
    const read = await fixture.ask<{ getUser: { name: string } | null }>(
      `{ getUser(id: "${written?.id}") { name } }`,
    )
    expect(read.body.data?.getUser).toEqual({ name: "bo" })
  })

  test("a query operation is allowed over GET", async () => {
    const { status, body } = await fixture.ask<{ listUsers: unknown[] }>(
      `{ listUsers(limit: 1) { id } }`,
      { method: "GET" },
    )
    expect(status).toBe(200)
    expect(body.data?.listUsers).toHaveLength(1)
  })
})

describe("what the wiring must not lose", () => {
  test("an int64 past 2^53 survives, tagged, in and out", async () => {
    // A bare JSON number this large is already rounded by `JSON.parse` before anything of ours
    // sees it, so the tagged form is what a client sends — and it is what comes back.
    const big = "9223372036854775807"
    const created = await fixture.ask<{ createUser: { id: unknown; name: string }[] }>(
      `mutation Big($row: JSON!) { createUser(input: $row) { id name } }`,
      { variables: { row: { id: { $i: big }, name: "big" } } },
    )
    expect(created.body.errors).toBeUndefined()
    expect(created.body.data?.createUser?.[0]).toEqual({ id: { $i: big }, name: "big" })

    const read = await fixture.ask<{ getUser: { id: unknown } | null }>(
      `{ getUser(id: "${big}") { id } }`,
    )
    expect(read.body.data?.getUser).toEqual({ id: { $i: big } })
  })

  test("a blob survives both ways, under the name the generator could spell", async () => {
    // `$` is not legal in a GraphQL name, so `{"$b": …}` becomes `body { b }` — and the
    // generator's `openapiName` extension renames it back on the way in. Both directions, or the
    // column is write-only nonsense.
    const seeded = await fixture.ask(`mutation S($row: JSON!) { createFile(input: $row) { id } }`, {
      variables: { row: { id: 1 } },
    })
    expect(seeded.body.errors).toBeUndefined()
    const written = await fixture.ask<{ updateFile: { body: { b: string } } }>(
      `mutation { updateFile(id: "1", input: { body: { b: "aGk=" } }) { body { b } } }`,
    )
    expect(written.body.data?.updateFile).toEqual({ body: { b: "aGk=" } })
    // On the wire it is the `{"$b": …}` the rest of BunQL speaks, not the GraphQL spelling.
    const rest = await fixture.data.dispatchAs(fixture.data.token())("/v1/db/gqlhandler/api/files")
    expect(await rest.json()).toEqual([{ id: 1, body: { $b: "aGk=" } }])
  })

  test("a table the token has no ACL for is not readable through GraphQL", async () => {
    const { status, body } = await fixture.ask<{ listUsers: unknown[]; listOrders: null }>(
      `{ listUsers { id } listOrders { id } }`,
      { as: "ann" },
    )
    // The ACL is SQLite's own authorizer, through `src/server/exec.ts`: the permitted field
    // answers and the refused one is an error carrying the code the REST route would have used.
    expect(status).toBe(200)
    expect(body.data?.listUsers).not.toBeNull()
    expect(body.data?.listOrders).toBeNull()
    const refusal = body.errors?.find((error) => error.path?.[0] === "listOrders")
    expect(refusal?.extensions?.code).toBe("NOT_AUTHORIZED")
    expect(refusal?.extensions?.status).toBe(403)
  })

  test("a BunQL error keeps its code instead of arriving as an opaque failure", async () => {
    const { body } = await fixture.ask(
      `mutation { createUser(input: { id: 1, name: "clash" }) { id } }`,
    )
    const error = body.errors?.[0]
    expect(String(error?.extensions?.code)).toStartWith("SQLITE_CONSTRAINT")
    expect(error?.extensions?.status).toBe(409)
    expect(error?.message).not.toContain("OPENAPI_REQUEST_FAILED")
  })
})

describe("the limits", () => {
  test("a query past maxDepth is refused, and runs nothing", async () => {
    let statements = 0
    const shallow = await graphqlFixture("gqldepth", SCHEMA, {
      handler: { maxDepth: 1 },
      wrapExec: (exec) => (statement) => {
        statements += 1
        return exec(statement)
      },
    })
    const { status, body } = await shallow.ask(`{ listUsers { id } }`)
    expect(status).toBe(400)
    expect(body.errors?.[0]?.extensions).toMatchObject({
      code: "BAD_REQUEST",
      limit: "depth",
      max: 1,
      actual: 2,
    })
    expect(statements).toBe(0)
    await shallow.close()
  })

  test("a query past maxComplexity is refused", async () => {
    const tight = await graphqlFixture("gqlcost", SCHEMA, { handler: { maxComplexity: 50 } })
    const refused = await tight.ask(`{ listUsers(limit: 1000) { id name email } }`)
    expect(refused.status).toBe(400)
    expect(refused.body.errors?.[0]?.extensions).toMatchObject({
      code: "BAD_REQUEST",
      limit: "complexity",
      max: 50,
    })
    // The same query asking for fewer rows is under the ceiling and runs.
    const allowed = await tight.ask(`{ listUsers(limit: 10) { id } }`)
    expect(allowed.status).toBe(200)
    await tight.close()
  })
})

describe("the protocol", () => {
  test("GraphiQL is served to a browser's GET, and only when it is enabled", async () => {
    const page = await fixture.send({ headers: { accept: "text/html" } })
    expect(page.status).toBe(200)
    expect(page.headers.get("content-type")).toStartWith("text/html")
    expect(await page.text()).toContain("graphiql")

    const off = await graphqlFixture("gqlnoide", SCHEMA, { handler: { graphiql: false } })
    const refused = await off.send({ headers: { accept: "text/html" } })
    expect(refused.status).toBe(400)
    expect(refused.headers.get("content-type")).toStartWith("application/json")
    await off.close()
  })

  test("a mutation over GET, an unknown method and a missing query are refused", async () => {
    const mutation = await fixture.ask(`mutation { createUser(input: { name: "x" }) { id } }`, {
      method: "GET",
    })
    expect(mutation.status).toBe(405)
    const method = await fixture.send({ method: "DELETE" })
    expect(method.status).toBe(405)
    const empty = await fixture.send({ method: "POST", body: "{}" })
    expect(empty.status).toBe(400)
  })

  test("a request naming no database is a 400, not a crash", async () => {
    const response = await fixture.send({ path: "/v1/graphql", method: "POST", body: "{}" })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      errors: [{ extensions: { code: "BAD_REQUEST" } }],
    })
  })
})

describe("the optional peers", () => {
  test("the handler throws a named error that carries the install command", async () => {
    const absent = await graphqlFixture("gqlnopeers", SCHEMA, {
      handler: {
        peers: {
          graphql: () => Promise.reject(new Error("Cannot find module 'graphql'")),
          openapi: () => Promise.reject(new Error("Cannot find module 'openapi-x-graphql'")),
        },
      },
    })
    const request = new Request(`${ORIGIN}/v1/db/gqlnopeers/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: `{ listUsers { id } }` }),
    })
    const thrown = await absent.handler(request).then(
      () => null,
      (err: unknown) => err,
    )
    expect(thrown).toBeInstanceOf(MissingPeersError)
    expect((thrown as MissingPeersError).message).toContain("graphql")
    expect((thrown as MissingPeersError).message).toContain("openapi-x-graphql")
    expect((thrown as MissingPeersError).message).toContain("bun add graphql openapi-x-graphql")
    expect((thrown as MissingPeersError).name).toBe("MissingPeersError")
    await absent.close()
  })
})
