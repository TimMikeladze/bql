// Per-database `PRAGMA foreign_keys` (`PATCH /v1/db/{db}`, `docs/p1-pragmas.md`).
//
// The point of every case is the **third state**: null is "follow `[sqlite] foreignKeys`", which is
// not the same fact as false. A node that turns the node-level switch on later has to be able to
// reach a database created before it did, and that only works if "nobody has said" is recorded as
// its own thing.

import { afterEach, describe, expect, test } from "bun:test"
import { loadConfig } from "../../src/server/config.ts"
import { startServer as startReal } from "../../src/server/app.ts"
import { startTestServer, stopAll, type TestServer } from "./harness.ts"

afterEach(stopAll)

async function setting(node: TestServer, db: string): Promise<boolean | null> {
  const stats = (await node.json(`/v1/db/${db}`)) as { foreignKeys: boolean | null }
  return stats.foreignKeys
}

/** Does this connection enforce foreign keys right now? Asked of SQLite, not of our own record. */
async function enforces(node: TestServer, db: string): Promise<boolean> {
  const response = await node.fetch(`/v1/db/${db}/query`, {
    method: "POST",
    body: JSON.stringify({ sql: "pragma foreign_keys" }),
  })
  const body = (await response.json()) as { rows: [number][] }
  return body.rows[0]?.[0] === 1
}

describe("per-database foreignKeys", () => {
  test("a new database follows the node, and says so with null", async () => {
    const node = await startTestServer()
    await node.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name: "acme" }) })
    expect(await setting(node, "acme")).toBeNull()
    // `[sqlite] foreignKeys` defaults off, as SQLite has it.
    expect(await enforces(node, "acme")).toBe(false)
  })

  test("turning it on for one database leaves the others alone", async () => {
    const node = await startTestServer()
    for (const name of ["acme", "other"]) {
      await node.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name }) })
    }
    const patched = await node.fetch("/v1/db/acme", {
      method: "PATCH",
      body: JSON.stringify({ foreignKeys: true }),
    })
    expect(patched.status).toBe(200)
    expect(await setting(node, "acme")).toBe(true)
    expect(await enforces(node, "acme")).toBe(true)

    expect(await setting(node, "other")).toBeNull()
    expect(await enforces(node, "other")).toBe(false)
  })

  test("it is actually enforced, which is the only thing that matters about it", async () => {
    const node = await startTestServer()
    await node.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name: "acme" }) })
    await node.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "create table parent (id integer primary key)" }),
    })
    await node.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({
        sql: "create table child (id integer primary key, p integer references parent(id))",
      }),
    })
    // Off: an orphan is accepted, which is SQLite's default and this server's.
    const before = await node.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "insert into child (id, p) values (1, 999)" }),
    })
    expect(before.status).toBe(200)

    await node.fetch("/v1/db/acme", { method: "PATCH", body: JSON.stringify({ foreignKeys: true }) })
    const after = await node.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "insert into child (id, p) values (2, 999)" }),
    })
    expect(after.status).toBeGreaterThan(399)
    expect(await after.text()).toContain("FOREIGNKEY")
  })

  test("null clears the override rather than meaning false", async () => {
    // The whole reason the column is nullable. A node whose `[sqlite] foreignKeys` is on must
    // enforce for a database that was set back to "follow the node".
    const node = await startTestServer({ sqlite: { foreignKeys: true } })
    await node.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name: "acme" }) })
    expect(await enforces(node, "acme")).toBe(true)

    await node.fetch("/v1/db/acme", { method: "PATCH", body: JSON.stringify({ foreignKeys: false }) })
    expect(await setting(node, "acme")).toBe(false)
    expect(await enforces(node, "acme")).toBe(false)

    await node.fetch("/v1/db/acme", { method: "PATCH", body: JSON.stringify({ foreignKeys: null }) })
    expect(await setting(node, "acme")).toBeNull()
    expect(await enforces(node, "acme")).toBe(true)
  })

  test("the setting survives a restart, because it is in the catalog", async () => {
    const node = await startTestServer()
    await node.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name: "acme" }) })
    await node.fetch("/v1/db/acme", { method: "PATCH", body: JSON.stringify({ foreignKeys: true }) })
    const dir = node.handle.config.data.dir
    const adminKey = node.adminKey
    await node.close()

    const again = await startReal(
      loadConfig({
        env: {},
        overrides: { server: { port: 0, host: "127.0.0.1" }, data: { dir }, auth: { adminKey } },
      }),
      { log: () => {} },
    )
    try {
      const url = `http://127.0.0.1:${again.server.port}`
      const stats = (await (
        await fetch(`${url}/v1/db/acme`, { headers: { authorization: `Bearer ${adminKey}` } })
      ).json()) as { foreignKeys: boolean | null }
      expect(stats.foreignKeys).toBe(true)
      const pragma = (await (
        await fetch(`${url}/v1/db/acme/query`, {
          method: "POST",
          headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
          body: JSON.stringify({ sql: "pragma foreign_keys" }),
        })
      ).json()) as { rows: [number][] }
      expect(pragma.rows[0]?.[0]).toBe(1)
    } finally {
      await again.close()
    }
  })

  test("a value that is neither a boolean nor null is a 400", async () => {
    const node = await startTestServer()
    await node.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name: "acme" }) })
    const bad = await node.fetch("/v1/db/acme", {
      method: "PATCH",
      body: JSON.stringify({ foreignKeys: "yes" }),
    })
    expect(bad.status).toBe(400)
  })
})
