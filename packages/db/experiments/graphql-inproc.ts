// Proves the two assumptions milestone H5 in `docs/plan-surfaces.md` rests on, before any of it
// is built:
//
//   1. openapi-x-graphql's `ExecutorOptions.fetch` really does let a generated resolver dispatch
//      in this process. No socket is opened, no port is bound; the resolver hands a `Request` to a
//      function and gets a `Response` back.
//   2. A schema built once per tenant and cached on `PRAGMA schema_version` can still serve a
//      *per-request* caller token, because `AsyncLocalStorage` survives the resolver chain under
//      Bun. The token cannot be baked into the schema's `headers` option — it differs per request,
//      and it is what the table ACLs are enforced from.
//
// Needs the optional peers:  bun add -d openapi-x-graphql graphql
//   bun run experiments/graphql-inproc.ts
import { AsyncLocalStorage } from "node:async_hooks"
import { graphql, printSchema } from "graphql"
import { createGraphQLSchema } from "openapi-x-graphql"

const als = new AsyncLocalStorage<{ token: string }>()
const seen: string[] = []

const document = {
  openapi: "3.1.0",
  info: { title: "acme", version: "1" },
  servers: [{ url: "http://bql.local/v1/db/acme/api" }],
  paths: {
    "/users": {
      get: {
        operationId: "listUsers",
        responses: { "200": { description: "rows", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/User" } } } } } },
      },
      post: {
        operationId: "createUser",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/NewUser" } } } },
        responses: { "201": { description: "row", content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } } } },
      },
    },
  },
  components: {
    schemas: {
      User: { type: "object", required: ["id", "name"], properties: { id: { type: "integer" }, name: { type: "string" } } },
      NewUser: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
    },
  },
}

const inProcessFetch: typeof globalThis.fetch = async (input, init) => {
  const request = new Request(input as Request | string, init)
  // The schema was built once; the token comes from the request in flight.
  const token = als.getStore()?.token ?? "(none)"
  seen.push(`${request.method} ${new URL(request.url).pathname} token=${token}`)
  const body = request.method === "GET" ? "[]" : JSON.stringify({ id: 9, name: "cy" })
  return new Response(request.method === "GET" ? JSON.stringify([{ id: 1, name: "ann" }]) : body, {
    status: request.method === "GET" ? 200 : 201,
    headers: { "content-type": "application/json" },
  })
}

const { schema } = await createGraphQLSchema(document, {
  baseUrl: "http://bql.local/v1/db/acme/api",
  fetch: inProcessFetch,
})
console.log(printSchema(schema).split("\n").filter((l) => l.includes("createUser")).join("\n"))

for (const token of ["token-ann", "token-bob"]) {
  const r = await als.run({ token }, () =>
    graphql({ schema, source: `{ listUsers { id name } }` }))
  if (r.errors) console.log("ERR", r.errors)
}
const m = await als.run({ token: "token-admin" }, () =>
  graphql({ schema, source: `mutation { createUser(input: { name: "cy" }) { id name } }` }))
console.log("mutation:", JSON.stringify(m))
console.log("--- dispatches ---")
for (const line of seen) console.log(" ", line)
