// Database lifecycle over HTTP (design §6.5): create, fork, stat, snapshot, restore, dump,
// import, checkpoint, delete. Each one is checked by what it leaves behind, not by its status.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { ErrorBody, QueryResult } from "../../src/client/protocol.ts"
import { createDb, startTestServer, stopAll, type TestServer } from "./harness.ts"

let server: TestServer

interface Stats {
  name: string
  sizeBytes: number
  walBytes: number
  txid: number
  epoch: number
  checksum: string
  openConns: number
  liveQueries: number
  replicas: unknown[]
}

beforeAll(async () => {
  server = await startTestServer()
})
afterAll(stopAll)

async function rows(db: string, sql: string): Promise<QueryResult["rows"]> {
  const result = await server.json<QueryResult>(`/v1/db/${db}/query`, {
    method: "POST",
    body: JSON.stringify({ sql }),
  })
  return result.rows
}

async function seed(db: string, howMany: number): Promise<void> {
  await createDb(server, db, "create table t(id integer primary key, v text)")
  for (let i = 0; i < howMany; i++) {
    await server.fetch(`/v1/db/${db}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t(v) values (?)", args: [`v${i}`] }),
    })
  }
}

describe("create and list", () => {
  test("a new database is created, listed and reports stats", async () => {
    await seed("alpha", 3)
    const listed = await server.json<{ databases: { name: string; open: boolean }[] }>("/v1/db")
    expect(listed.databases.map((d) => d.name)).toContain("alpha")
    const stats = await server.json<Stats>("/v1/db/alpha")
    expect(stats.name).toBe("alpha")
    expect(stats.txid).toBeGreaterThan(0)
    expect(stats.sizeBytes).toBeGreaterThan(0)
    expect(stats.replicas).toEqual([])
  })

  test("creating the same name twice is a 409", async () => {
    const again = await server.fetch("/v1/db", {
      method: "POST",
      body: JSON.stringify({ name: "alpha" }),
    })
    expect(again.status).toBe(409)
  })

  test("an illegal name never reaches the filesystem", async () => {
    for (const name of ["../escape", "Upper", "_system", ""]) {
      const response = await server.fetch("/v1/db", {
        method: "POST",
        body: JSON.stringify({ name }),
      })
      expect(response.status).toBe(400)
    }
  })
})

describe("fork and restore", () => {
  test("a fork starts as a copy and then diverges", async () => {
    const created = await server.fetch("/v1/db", {
      method: "POST",
      body: JSON.stringify({ name: "alpha-fork", from: { db: "alpha" } }),
    })
    expect(created.status).toBe(201)
    expect(await rows("alpha-fork", "select count(*) from t")).toEqual([[3]])
    await server.fetch("/v1/db/alpha-fork/query", {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t(v) values ('only here')" }),
    })
    expect(await rows("alpha-fork", "select count(*) from t")).toEqual([[4]])
    expect(await rows("alpha", "select count(*) from t")).toEqual([[3]])
  })

  test("a fork at a txid is the database as it was then", async () => {
    const created = await server.fetch("/v1/db", {
      method: "POST",
      body: JSON.stringify({ name: "alpha-early", from: { db: "alpha", at: 2 } }),
    })
    expect(created.status).toBe(201)
    expect(await rows("alpha-early", "select count(*) from t")).toEqual([[1]])
  })

  test("restore rebuilds into a new database and leaves the original alone", async () => {
    const restored = await server.json<{ name: string; txid: number }>("/v1/db/alpha/restore", {
      method: "POST",
      body: JSON.stringify({ at: 3, into: "alpha-at3" }),
    })
    expect(restored.name).toBe("alpha-at3")
    expect(restored.txid).toBe(3)
    expect(await rows("alpha-at3", "select count(*) from t")).toEqual([[2]])
    expect(await rows("alpha", "select count(*) from t")).toEqual([[3]])
  })

  test("`at` also takes a timestamp, resolved against the log", async () => {
    // Everything `alpha` holds was written just now, so "now" is its latest txid and a time
    // before the log starts has nothing to restore to.
    const restored = await server.json<{ name: string; txid: number; at: number }>(
      "/v1/db/alpha/restore",
      {
        method: "POST",
        body: JSON.stringify({ at: new Date().toISOString(), into: "alpha-by-time" }),
      },
    )
    expect(restored.at).toBeGreaterThan(0)
    expect(await rows("alpha-by-time", "select count(*) from t")).toEqual([[3]])

    const tooEarly = await server.fetch("/v1/db/alpha/restore", {
      method: "POST",
      body: JSON.stringify({ at: "2001-01-01T00:00:00Z", into: "alpha-too-early" }),
    })
    expect(tooEarly.status).toBe(400)
    expect(((await tooEarly.json()) as ErrorBody).error.message).toContain("no transaction at or")

    const nonsense = await server.fetch("/v1/db/alpha/restore", {
      method: "POST",
      body: JSON.stringify({ at: "soon", into: "alpha-soon" }),
    })
    expect(nonsense.status).toBe(400)
  })

  test("restore without `into` picks a name of its own", async () => {
    const restored = await server.json<{ name: string }>("/v1/db/alpha/restore", {
      method: "POST",
      body: JSON.stringify({ at: 2 }),
    })
    expect(restored.name).toBe("alpha-restore-2")
  })
})

describe("snapshot, dump and import", () => {
  test("a snapshot names the txid it holds", async () => {
    const snapshot = await server.json<{ snapshotId: string; txid: number }>(
      "/v1/db/alpha/snapshot",
      { method: "POST" },
    )
    expect(snapshot.txid).toBeGreaterThan(0)
    expect(snapshot.snapshotId).toEndWith(".db")
    const stats = await server.json<{ lastSnapshotTxid: number }>("/v1/db/alpha")
    expect(stats.lastSnapshotTxid).toBe(snapshot.txid)
  })

  test("a dump is a real SQLite file that import takes back", async () => {
    const dump = await server.fetch("/v1/db/alpha/dump")
    expect(dump.status).toBe(200)
    expect(dump.headers.get("content-type")).toBe("application/vnd.sqlite3")
    const bytes = await dump.arrayBuffer()
    expect(new TextDecoder().decode(bytes.slice(0, 15))).toBe("SQLite format 3")

    const imported = await server.fetch("/v1/db/alpha-copy/import", {
      method: "POST",
      headers: { "content-type": "application/vnd.sqlite3" },
      body: bytes,
    })
    expect(imported.status).toBe(201)
    expect(await rows("alpha-copy", "select count(*) from t")).toEqual([[3]])
  })

  test("import refuses a body that is not a database, and an existing name", async () => {
    const notADatabase = await server.fetch("/v1/db/junk/import", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(1024),
    })
    expect(notADatabase.status).toBe(400)
    expect((await server.fetch("/v1/db/junk/query", { method: "POST", body: '{"sql":"select 1"}' })).status).toBe(404)

    const dump = await server.fetch("/v1/db/alpha/dump")
    const clash = await server.fetch("/v1/db/alpha/import", {
      method: "POST",
      headers: { "content-type": "application/vnd.sqlite3" },
      body: await dump.arrayBuffer(),
    })
    expect(clash.status).toBe(409)
  })
})

describe("checkpoint, replication and delete", () => {
  test("a TRUNCATE checkpoint empties the WAL", async () => {
    await seed("beta", 5)
    const result = await server.json<{ mode: string; walBytes: number }>(
      "/v1/db/beta/checkpoint",
      { method: "POST", body: JSON.stringify({ mode: "TRUNCATE" }) },
    )
    expect(result.mode).toBe("TRUNCATE")
    expect(result.walBytes).toBe(0)
  })

  test("an unknown checkpoint mode is a 400", async () => {
    const response = await server.fetch("/v1/db/beta/checkpoint", {
      method: "POST",
      body: JSON.stringify({ mode: "SOMETHING" }),
    })
    expect(response.status).toBe(400)
  })

  test("replication reports the position a replica would subscribe from", async () => {
    const info = await server.json<{
      txid: number
      epoch: number
      checksum: string
      role: string
      replicas: unknown[]
    }>("/v1/db/beta/replication")
    expect(info.txid).toBeGreaterThan(0)
    expect(info.epoch).toBe(0)
    expect(info.checksum).toMatch(/^\d+$/)
    expect(info.role).toBe("primary")
    expect(info.replicas).toEqual([])
  })

  test("a deleted database is gone from the list and from the routes", async () => {
    const deleted = await server.json<{ deleted: boolean; trash: string }>("/v1/db/beta", {
      method: "DELETE",
    })
    expect(deleted.deleted).toBe(true)
    expect(deleted.trash).toContain("trash")
    const listed = await server.json<{ databases: { name: string }[] }>("/v1/db")
    expect(listed.databases.map((d) => d.name)).not.toContain("beta")
    const gone = await server.fetch("/v1/db/beta/query", {
      method: "POST",
      body: JSON.stringify({ sql: "select 1" }),
    })
    expect(gone.status).toBe(404)
    expect(((await gone.json()) as ErrorBody).error.code).toBe("DB_NOT_FOUND")
  })

  test("deleting a database that was never there is a 404", async () => {
    expect((await server.fetch("/v1/db/never/", { method: "DELETE" })).status).toBe(404)
  })
})
