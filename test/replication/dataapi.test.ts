// The generated data API on a replica. It has no forwarding of its own: every statement it builds
// goes through the `exec` `src/server/surfaces.ts` closes over `src/server/exec.ts`, which is where
// R2's forwarding already lives — so a read is served locally and an insert lands on the primary
// and comes back. That is the claim `docs/h6-mount.md` decision 3 makes, and this is where it is
// checked rather than asserted.

import { afterAll, expect, test } from "bun:test"
import { HEADERS } from "../../src/client/protocol.ts"
import { createDb, query, startCluster, stopAll, until } from "./harness.ts"

afterAll(stopAll)

test("a replica serves reads locally and forwards a generated write", async () => {
  const cluster = await startCluster(1)
  const replica = cluster.replicas[0]!
  await createDb(cluster.primary, "shop", "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)")
  await query(cluster.primary, "shop", "INSERT INTO users (name) VALUES (?)", ["ann"])

  await until(
    async () => (await replica.fetch("/v1/db/shop/api/users")).status === 200,
    "the replica to have bootstrapped shop",
  )

  const read = await replica.fetch("/v1/db/shop/api/users")
  expect(read.headers.get(HEADERS.role)).toBe("replica")
  expect(await read.json()).toEqual([{ id: 1, name: "ann" }])

  // The document is generated on the replica, from the replica's own copy of the schema.
  const document = await replica.json<{ paths: Record<string, unknown> }>(
    "/v1/db/shop/openapi.json",
  )
  expect(Object.keys(document.paths).sort()).toEqual(["/users", "/users/{id}"])

  // A write: `[replication] forwardWrites` is on by default, so this is not a `NOT_PRIMARY`.
  const written = await replica.fetch("/v1/db/shop/api/users", {
    method: "POST",
    body: JSON.stringify({ name: "bob" }),
  })
  expect(written.status).toBe(201)
  expect(await written.json()).toEqual([{ id: 2, name: "bob" }])

  // And it really went to the primary, rather than to the replica's own copy.
  const onPrimary = await cluster.primary.json<Record<string, unknown>[]>("/v1/db/shop/api/users")
  expect(onPrimary).toEqual([
    { id: 1, name: "ann" },
    { id: 2, name: "bob" },
  ])
  await cluster.close()
}, 30_000)
