// The operator-facing surface: `[s3]` config, a shipper started per database by the runtime, the
// backup routes, `/metrics`, and a restore from the bucket into a new database that then serves
// queries. This is the test that would catch a wiring mistake nothing else would.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { loadConfig } from "../../src/server/config.ts"
import { startServer, type ServerHandle } from "../../src/server/app.ts"
import { readManifest } from "../../src/storage/index.ts"
import { type Backend, cleanup, openBackend, tempDir } from "./harness.ts"

let backend: Backend
const running: ServerHandle[] = []

beforeAll(async () => {
  backend = await openBackend()
})

afterAll(async () => {
  for (const handle of running.splice(0)) await handle.close()
  cleanup()
})

interface TestServer {
  handle: ServerHandle
  url: string
  prefix: string
  json<T>(path: string, init?: RequestInit): Promise<T>
  call(path: string, init?: RequestInit): Promise<Response>
}

async function startShippingServer(overrides: Record<string, unknown> = {}): Promise<TestServer> {
  const prefix = backend.prefix()
  const credentials = backend.credentials
  const config = loadConfig({
    env: {},
    overrides: {
      server: { port: 0, host: "127.0.0.1", node: "s3-node" },
      data: { dir: tempDir("bunql-s3-server-") },
      s3: {
        ...credentials,
        prefix,
        shipIntervalMs: 20,
        snapshotIntervalMs: 0,
        snapshotEveryBytes: 0,
        retention: "0",
        retries: 2,
        ...overrides,
      },
    },
  })
  const handle = await startServer(config, { log: () => {} })
  running.push(handle)
  const url = `http://127.0.0.1:${handle.server.port}`
  const adminKey = handle.adminKey as string

  const call = (route: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set("authorization", `Bearer ${adminKey}`)
    if (init.body !== undefined) headers.set("content-type", "application/json")
    return fetch(`${url}${route}`, { ...init, headers })
  }
  return {
    handle,
    url,
    prefix,
    call,
    async json<T>(route: string, init: RequestInit = {}): Promise<T> {
      const response = await call(route, init)
      const body = (await response.json()) as T & { error?: { code: string; message: string } }
      if (!response.ok) {
        throw new Error(`${route} → ${response.status} ${body.error?.code}: ${body.error?.message}`)
      }
      return body
    },
  }
}

/** Ships everything outstanding on a running server and waits for it. */
async function flush(server: TestServer): Promise<void> {
  await server.handle.runtime.storage?.flush()
}

describe("[s3] configuration", () => {
  test("a bucket turns shipping on and `s3://bucket/prefix` splits into both", () => {
    const config = loadConfig({ env: {}, overrides: { s3: { bucket: "s3://backups/bunql/prod" } } })
    expect(config.s3.enabled).toBe(true)
    expect(config.s3.bucket).toBe("backups")
    expect(config.s3.prefix).toBe("bunql/prod")
  })

  test("no bucket means no shipping, and `enabled = false` keeps the bucket as a restore target", () => {
    expect(loadConfig({ env: {} }).s3.enabled).toBe(false)
    const kept = loadConfig({
      env: {},
      overrides: { s3: { bucket: "backups", enabled: false } },
    })
    expect(kept.s3.bucket).toBe("backups")
    expect(kept.s3.enabled).toBe(false)
  })

  test("every key takes a BUNQL_S3_* override", () => {
    const config = loadConfig({
      env: {
        BUNQL_S3_BUCKET: "from-env",
        BUNQL_S3_PREFIX: "env/",
        BUNQL_S3_SHIP_INTERVAL_MS: "250",
        BUNQL_S3_RETENTION: "7d",
        BUNQL_S3_CONCURRENCY: "8",
        BUNQL_S3_ENDPOINT: "https://example.invalid",
      },
    })
    expect(config.s3.bucket).toBe("from-env")
    expect(config.s3.prefix).toBe("env/")
    expect(config.s3.shipIntervalMs).toBe(250)
    expect(config.s3.retention).toBe("7d")
    expect(config.s3.concurrency).toBe(8)
    expect(config.s3.endpoint).toBe("https://example.invalid")
  })

  test("a retention that is not a duration is refused at startup", () => {
    expect(() =>
      loadConfig({ env: {}, overrides: { s3: { bucket: "b", retention: "a fortnight" } } }),
    ).toThrow(/retention/)
  })
})

describe("a server that ships", () => {
  test("writes reach the bucket and restore into a new database that serves queries", async () => {
    const server = await startShippingServer()
    await server.json("/v1/db", { method: "POST", body: JSON.stringify({ name: "shop" }) })
    await server.json("/v1/db/shop/query", {
      method: "POST",
      body: JSON.stringify({ sql: "create table items (id integer primary key, name text)" }),
    })
    for (let i = 1; i <= 15; i++) {
      await server.json("/v1/db/shop/query", {
        method: "POST",
        body: JSON.stringify({ sql: "insert into items (id, name) values (?, ?)", args: [i, `item ${i}`] }),
      })
    }
    await flush(server)

    const manifest = await readManifest(backend.store(), server.prefix, "shop")
    expect(Number(manifest.shippedTxid)).toBe(16)

    const status = await server.json<{
      enabled: boolean
      bucket: string
      shipper: { shippedTxid: number; behind: boolean; errors: number }
    }>("/v1/db/shop/backup")
    expect(status.enabled).toBe(true)
    expect(status.bucket).toBe(backend.bucket)
    expect(status.shipper.shippedTxid).toBe(16)
    expect(status.shipper.behind).toBe(false)
    expect(status.shipper.errors).toBe(0)

    const verified = await server.json<{ ok: boolean; latest: number }>(
      "/v1/db/shop/backup/verify",
      { method: "POST", body: JSON.stringify({}) },
    )
    expect(verified.ok).toBe(true)
    expect(verified.latest).toBe(16)

    // A restore on a *different* node, reading the same bucket, is the real recovery story.
    const other = await startShippingServer({ prefix: server.prefix, enabled: false })
    const restored = await other.json<{ name: string; txid: number; applied: number }>(
      "/v1/db/shop/restore",
      { method: "POST", body: JSON.stringify({ from: "s3", into: "shop-recovered" }) },
    )
    expect(restored.name).toBe("shop-recovered")
    expect(restored.txid).toBe(16)

    const rows = await other.json<{ rows: unknown[][] }>("/v1/db/shop-recovered/query", {
      method: "POST",
      body: JSON.stringify({ sql: "select count(*) from items" }),
    })
    expect(rows.rows[0]?.[0]).toBe(15)
  })

  test("restores to a txid in the middle of the timeline", async () => {
    const server = await startShippingServer()
    await server.json("/v1/db", { method: "POST", body: JSON.stringify({ name: "half" }) })
    await server.json("/v1/db/half/query", {
      method: "POST",
      body: JSON.stringify({ sql: "create table t (id integer primary key)" }),
    })
    for (let i = 1; i <= 6; i++) {
      await server.json("/v1/db/half/query", {
        method: "POST",
        body: JSON.stringify({ sql: "insert into t (id) values (?)", args: [i] }),
      })
    }
    const midway = await server.json<{ txid: number }>("/v1/db/half")
    for (let i = 100; i < 106; i++) {
      await server.json("/v1/db/half/query", {
        method: "POST",
        body: JSON.stringify({ sql: "insert into t (id) values (?)", args: [i] }),
      })
    }
    await flush(server)

    const restored = await server.json<{ txid: number }>("/v1/db/half/restore", {
      method: "POST",
      body: JSON.stringify({ from: "s3", at: midway.txid, into: "half-mid" }),
    })
    expect(restored.txid).toBe(midway.txid)
    const rows = await server.json<{ rows: unknown[][] }>("/v1/db/half-mid/query", {
      method: "POST",
      body: JSON.stringify({ sql: "select count(*) from t" }),
    })
    expect(rows.rows[0]?.[0]).toBe(6)
  })

  test("`/v1/db/:db/replication` carries the shipper position", async () => {
    const server = await startShippingServer()
    await server.json("/v1/db", { method: "POST", body: JSON.stringify({ name: "pos" }) })
    await server.json("/v1/db/pos/query", {
      method: "POST",
      body: JSON.stringify({ sql: "create table t (id integer primary key)" }),
    })
    await flush(server)
    const body = await server.json<{ s3: { shippedTxid: number; bucket: string } | null }>(
      "/v1/db/pos/replication",
    )
    expect(body.s3?.bucket).toBe(backend.bucket)
    expect(body.s3?.shippedTxid).toBe(1)
  })

  test("`/metrics` exports the four bunql_s3_* series", async () => {
    const server = await startShippingServer()
    await server.json("/v1/db", { method: "POST", body: JSON.stringify({ name: "met" }) })
    await server.json("/v1/db/met/query", {
      method: "POST",
      body: JSON.stringify({ sql: "create table t (id integer primary key)" }),
    })
    await flush(server)
    const text = await (await server.call("/metrics")).text()
    expect(text).toContain("bunql_s3_shipped_txid{")
    expect(text).toContain("bunql_s3_pending_records{")
    expect(text).toContain("bunql_s3_errors_total{")
    expect(text).toContain("bunql_s3_bytes_total{")
    expect(text).toMatch(/bunql_s3_shipped_txid\{[^}]*\} 1/)
  })

  test("a node with no bucket says so rather than pretending", async () => {
    const config = loadConfig({
      env: {},
      overrides: {
        server: { port: 0, host: "127.0.0.1" },
        data: { dir: tempDir("bunql-nos3-") },
      },
    })
    // The refusal below is a 503, which the wrapper reports; this test expects it, so the report
    // goes nowhere rather than into the test output.
    const handle = await startServer(config, { log: () => {}, onError: () => {} })
    running.push(handle)
    expect(handle.runtime.storage).toBeNull()
    const url = `http://127.0.0.1:${handle.server.port}`
    const headers = { authorization: `Bearer ${handle.adminKey}`, "content-type": "application/json" }
    await fetch(`${url}/v1/db`, { method: "POST", headers, body: JSON.stringify({ name: "solo" }) })

    const status = (await (await fetch(`${url}/v1/db/solo/backup`, { headers })).json()) as {
      enabled: boolean
      shipper: unknown
    }
    expect(status.enabled).toBe(false)
    expect(status.shipper).toBeNull()

    const restore = await fetch(`${url}/v1/db/solo/restore`, {
      method: "POST",
      headers,
      body: JSON.stringify({ from: "s3" }),
    })
    expect(restore.status).toBe(503)
    expect(((await restore.json()) as { error: { code: string } }).error.code).toBe("S3_DISABLED")

    // And `/metrics` omits the series rather than exporting zeroes.
    const text = await (await fetch(`${url}/metrics`, { headers })).text()
    expect(text).not.toContain("bunql_s3_shipped_txid")
  })

  test("verifying a bucket with nothing in it is a 404, not a false success", async () => {
    const server = await startShippingServer({ enabled: false })
    await server.json("/v1/db", { method: "POST", body: JSON.stringify({ name: "void" }) })
    const response = await server.call("/v1/db/void/backup/verify", {
      method: "POST",
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "S3_NO_MANIFEST",
    )
  })

  test("a restore whose target the bucket cannot reach is a 400 naming the shortfall", async () => {
    const server = await startShippingServer()
    await server.json("/v1/db", { method: "POST", body: JSON.stringify({ name: "short" }) })
    await server.json("/v1/db/short/query", {
      method: "POST",
      body: JSON.stringify({ sql: "create table t (id integer primary key)" }),
    })
    await flush(server)
    const response = await server.call("/v1/db/short/restore", {
      method: "POST",
      body: JSON.stringify({ from: "s3", at: 9999, into: "short-restore" }),
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("S3_INCOMPLETE")
    expect(body.error.message).toContain("9999")
  })

  test("closing the server drains the shippers first", async () => {
    const server = await startShippingServer({ shipIntervalMs: 60_000 })
    await server.json("/v1/db", { method: "POST", body: JSON.stringify({ name: "drain" }) })
    await server.json("/v1/db/drain/query", {
      method: "POST",
      body: JSON.stringify({ sql: "create table t (id integer primary key)" }),
    })
    for (let i = 1; i <= 5; i++) {
      await server.json("/v1/db/drain/query", {
        method: "POST",
        body: JSON.stringify({ sql: "insert into t (id) values (?)", args: [i] }),
      })
    }
    // The interval has not elapsed, so nothing has been shipped yet.
    await server.handle.close()
    running.splice(running.indexOf(server.handle), 1)

    const manifest = await readManifest(backend.store(), server.prefix, "drain")
    expect(Number(manifest.shippedTxid)).toBe(6)
  })
})
