// Liveness, readiness, metrics, CORS and the 404 fallback — the parts an operator and a browser
// meet before anything else.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createDb, startTestServer, stopAll, type TestServer } from "./harness.ts"

let server: TestServer

beforeAll(async () => {
  server = await startTestServer()
  await createDb(server, "acme", "create table t(id integer primary key, v text)")
})
afterAll(stopAll)

describe("health", () => {
  test("healthz needs no credential and names the node", async () => {
    const response = await server.fetch("/healthz", { token: null })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; node: string; role: string }
    expect(body).toMatchObject({ ok: true, node: "test-node", role: "primary" })
  })

  test("readyz reports a primary that can serve", async () => {
    const response = await server.fetch("/readyz", { token: null })
    expect(response.status).toBe(200)
    expect((await response.json()) as { ready: boolean }).toMatchObject({ ready: true })
  })
})

describe("metrics", () => {
  test("the exposition is Prometheus text and counts what happened", async () => {
    await server.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "insert into t(v) values ('one')" }),
    })
    await server.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "select * from t" }),
    })
    const response = await server.fetch("/metrics")
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/plain")
    const body = await response.text()
    expect(body).toContain("# TYPE bql_requests_total counter")
    expect(body).toContain("# TYPE bql_request_duration_us histogram")
    expect(body).toMatch(/bql_requests_total\{node="test-node",status="2xx"\} [1-9]/)
    expect(body).toMatch(/bql_writes_total\{node="test-node"\} [1-9]/)
    expect(body).toMatch(/bql_queries_total\{node="test-node"\} [1-9]/)
    expect(body).toMatch(/bql_open_tenants\{node="test-node"\} [1-9]/)
    expect(body).toContain('bql_request_duration_us_bucket{node="test-node",le="+Inf"}')
  })

  test("metrics need the admin key when one is configured", async () => {
    expect((await server.fetch("/metrics", { token: null })).status).toBe(401)
    const { token } = await server.token({ dbs: ["acme"], scope: "ro" })
    expect((await server.fetch("/metrics", { token })).status).toBe(403)
  })

  test("vm steps accumulate, which is what quotas are billed on", async () => {
    const before = await readGauge("bql_vm_steps_total")
    await server.fetch("/v1/db/acme/query", {
      method: "POST",
      body: JSON.stringify({ sql: "select count(*) from t" }),
    })
    expect(await readGauge("bql_vm_steps_total")).toBeGreaterThan(before)
  })
})

async function readGauge(name: string): Promise<number> {
  const body = await (await server.fetch("/metrics")).text()
  const line = body.split("\n").find((one) => one.startsWith(`${name}{`))
  return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : 0
}

describe("CORS", () => {
  test("a preflight is answered without a credential", async () => {
    const response = await server.fetch("/v1/db/acme/query", {
      method: "OPTIONS",
      token: null,
      headers: {
        origin: "https://app.example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.com")
    expect(response.headers.get("access-control-allow-methods")).toContain("POST")
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization")
    expect(response.headers.get("access-control-max-age")).toBe("86400")
  })

  test("a real response echoes the origin and exposes the bql.sh headers", async () => {
    const response = await server.fetch("/v1/db/acme/query", {
      method: "POST",
      headers: { origin: "https://app.example.com" },
      body: JSON.stringify({ sql: "select 1" }),
    })
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.com")
    expect(response.headers.get("access-control-allow-credentials")).toBe("true")
    expect(response.headers.get("access-control-expose-headers")).toContain("BQL-Txid")
  })

  test("cors: false leaves the headers off", async () => {
    const plain = await startTestServer({ server: { cors: false } })
    const response = await plain.fetch("/healthz", {
      token: null,
      headers: { origin: "https://app.example.com" },
    })
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
    await plain.close()
  })
})

describe("routing", () => {
  test("an unknown path is a 404 with the error shape", async () => {
    const response = await server.fetch("/v1/nowhere", { token: null })
    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: { status: number; message: string } }
    expect(body.error.status).toBe(404)
    expect(body.error.message).toContain("/v1/nowhere")
    expect(response.headers.get("BQL-Node")).toBe("test-node")
  })

  test("a verb a route does not serve is not a 200", async () => {
    const response = await server.fetch("/v1/db/acme/query", { method: "GET" })
    expect(response.status).not.toBe(200)
  })
})
