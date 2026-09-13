// What a **router** reports about a node whose databases live on worker threads
// (`docs/c4-workers.md` §10's "known gaps", closed). Three facts the router does not itself hold:
// which databases are open and where they have got to, the S3 shipper's gauges, and a large body
// hopped to the worker that owns it.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startServer, type ServerHandle } from "../../src/server/app.ts"
import { loadConfig, type ServerConfigInput } from "../../src/server/config.ts"
import { FakeS3 } from "../storage/fake-s3.ts"
import { removeTempDir } from "../tmpdir.ts"

const WORKERS = 3
const dirs: string[] = []
const running: ServerHandle[] = []
let bucket: FakeS3 | null = null

afterAll(async () => {
  await bucket?.stop()
  bucket = null
})

afterEach(async () => {
  while (running.length > 0) {
    const handle = running.pop()
    if (handle) await handle.close()
  }
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) removeTempDir(dir)
  }
})

interface Sharded {
  url: string
  fetch(route: string, init?: RequestInit): Promise<Response>
  json<T>(route: string, init?: RequestInit): Promise<T>
}

async function start(overrides: ServerConfigInput = {}): Promise<Sharded> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-c4e-"))
  dirs.push(dir)
  const handle = await startServer(
    loadConfig({
      env: {},
      overrides: {
        ...overrides,
        server: { port: 0, host: "127.0.0.1", workers: WORKERS, ...overrides.server },
        data: { dir, ...overrides.data },
        auth: { adminKey: "test-admin-key", ...overrides.auth },
      },
    }),
    { log: () => {} },
  )
  running.push(handle)
  const url = `http://127.0.0.1:${handle.server.port}`
  const call = (route: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${url}${route}`, {
      ...init,
      headers: {
        authorization: "Bearer test-admin-key",
        "content-type": "application/json",
        ...((init.headers as Record<string, string>) ?? {}),
      },
    })
  return {
    url,
    fetch: call,
    async json<T>(route: string, init?: RequestInit): Promise<T> {
      return (await (await call(route, init)).json()) as T
    },
  }
}

const NAMES = ["alpha", "delta", "epsilon"]

async function seed(node: Sharded): Promise<void> {
  for (const name of NAMES) {
    await node.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name }) })
    await node.fetch(`/v1/db/${name}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: "create table t (a integer)" }),
    })
    await node.fetch(`/v1/db/${name}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t values (1)" }),
    })
  }
}

describe("what a router reports", () => {
  test("GET /v1/db says a database is open, and how far it has got", async () => {
    // The gap: the router owns the catalog and no tenant, so it used to answer `"open": false` for
    // every database and the catalog's *throttled* txid — true of the router, false of the node.
    const node = await start()
    await seed(node)
    const list = await node.json<{ databases: { name: string; open: boolean; txid: number }[] }>(
      "/v1/db",
    )
    expect(list.databases.length).toBe(NAMES.length)
    for (const name of NAMES) {
      const row = list.databases.find((one) => one.name === name)
      expect(`${name}: open=${String(row?.open)}`).toBe(`${name}: open=true`)
      // Two transactions: the schema and the insert. The catalog row would still say 0 or 1.
      expect(`${name}: txid=${String(row?.txid)}`).toBe(`${name}: txid=2`)
    }
  }, 30_000)

  test("the S3 gauges are the node's, merged across the shards", async () => {
    bucket ??= await FakeS3.start({ bucket: "bunql-c4e" })
    const node = await start({
      s3: {
        ...bucket.storeOptions,
        prefix: `c4e-${Date.now().toString(36)}/`,
        shipIntervalMs: 25,
        retries: 2,
      },
    })
    await seed(node)
    // Give the shippers a tick to reach the bucket.
    await new Promise((resolve) => setTimeout(resolve, 400))
    const body = await (await node.fetch("/metrics")).text()

    // Present at all, which they were not: a shipper lives on a worker and `/metrics` is answered
    // by the router.
    expect(body).toContain("bunql_s3_shipped_txid")
    expect(body).toContain("bunql_s3_errors_total")
    expect(body).toContain("bunql_s3_behind")
    // `shippedTxid` is the highest across databases — the same rule one node applies across its
    // own, because the shards hold disjoint databases.
    const shipped = Number(/bunql_s3_shipped_txid\{[^}]*\} (\d+)/.exec(body)?.[1] ?? "-1")
    expect(shipped).toBeGreaterThan(0)
  }, 30_000)

  test("a large body is hopped whole to the worker that owns it", async () => {
    // Above the transfer threshold, so it crosses by transfer rather than by copy. The oracle is
    // that the bytes arrive intact — a detached or half-transferred buffer is not a subtle failure.
    const node = await start()
    await node.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name: "source" }) })
    await node.fetch("/v1/db/source/query", {
      method: "POST",
      body: JSON.stringify({ sql: "create table t (id integer primary key, v text)" }),
    })
    // Enough rows that the file is comfortably over a megabyte.
    for (let i = 0; i < 40; i++) {
      await node.fetch("/v1/db/source/query", {
        method: "POST",
        body: JSON.stringify({
          sql: `insert into t (v) values ('${"x".repeat(30_000)}')`,
        }),
      })
    }
    const dump = await (await node.fetch("/v1/db/source/dump")).arrayBuffer()
    expect(dump.byteLength).toBeGreaterThan(1 << 20)

    const imported = await node.fetch("/v1/db/copy/import", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: dump,
    })
    expect(imported.status).toBe(201)
    const rows = await node.json<{ rows: [number][] }>("/v1/db/copy/query", {
      method: "POST",
      body: JSON.stringify({ sql: "select count(*) from t" }),
    })
    expect(rows.rows[0]?.[0]).toBe(40)
  }, 60_000)
})
