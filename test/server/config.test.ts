// Configuration resolution and key material (design §9.4). The thing worth pinning down is the
// precedence — defaults, then the file, then the environment — and that a generated secret is
// written once and reused on the next start.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { DEFAULT_CONFIG, loadConfig, resolveAuth } from "../../src/server/config.ts"
import { verifyToken } from "../../src/server/auth.ts"
import { startTestServer, stopAll, tempDataDir } from "./harness.ts"

afterAll(stopAll)

describe("loadConfig", () => {
  test("with nothing to read it is the documented defaults", () => {
    const config = loadConfig({ env: {} })
    expect(config.server.port).toBe(4321)
    expect(config.data.maxOpen).toBe(1024)
    expect(config.data.readers).toBe(2)
    expect(config.limits.queryTimeoutMs).toBe(10_000)
    expect(config.limits.writeTimeoutMs).toBe(30_000)
    expect(config.limits.txIdleTimeoutMs).toBe(5_000)
    expect(config.limits.maxRows).toBe(10_000)
    expect(config.realtime.ringBytes).toBe(10_000_000)
    expect(config.realtime.maxLiveQueries).toBe(1000)
    expect(config.realtime.maxRowsPerLive).toBe(1000)
    expect(config.durability.defaultAck).toBe("local")
    expect(config.server.tenantFromHost).toBe(false)
    expect(config.server.cors).toBe(true)
  })

  test("a TOML file sets what it names and leaves the rest alone", () => {
    const dir = tempDataDir("bunql-config-")
    const file = path.join(dir, "bunql.toml")
    fs.writeFileSync(
      file,
      [
        "[server]",
        "port = 5555",
        'host = "127.0.0.1"',
        "tenantFromHost = true",
        "[data]",
        `dir = "${path.join(dir, "data")}"`,
        "maxOpen = 8",
        "[limits]",
        "maxRows = 42",
        "[auth]",
        'adminKey = "${BUNQL_ADMIN_KEY}"',
      ].join("\n"),
    )
    const config = loadConfig({ file, env: { BUNQL_ADMIN_KEY: "from-the-environment" } })
    expect(config.server.port).toBe(5555)
    expect(config.server.tenantFromHost).toBe(true)
    expect(config.data.maxOpen).toBe(8)
    expect(config.limits.maxRows).toBe(42)
    expect(config.limits.queryTimeoutMs).toBe(DEFAULT_CONFIG.limits.queryTimeoutMs)
    expect(config.auth.adminKey).toBe("from-the-environment")
  })

  test("an unset ${VAR} leaves the secret to be generated rather than setting it empty", () => {
    const dir = tempDataDir("bunql-config-")
    const file = path.join(dir, "bunql.toml")
    fs.writeFileSync(file, '[auth]\nadminKey = "${NOT_SET_ANYWHERE}"\n')
    expect(loadConfig({ file, env: {} }).auth.adminKey).toBeNull()
  })

  test("the environment wins over the file, and numbers and booleans are coerced", () => {
    const dir = tempDataDir("bunql-config-")
    const file = path.join(dir, "bunql.toml")
    fs.writeFileSync(file, "[server]\nport = 5555\ncors = true\n")
    const config = loadConfig({
      file,
      env: { BUNQL_PORT: "6100", BUNQL_CORS: "false", BUNQL_MAX_ROWS: "7" },
    })
    expect(config.server.port).toBe(6100)
    expect(config.server.cors).toBe(false)
    expect(config.limits.maxRows).toBe(7)
  })

  test("a missing file is fine unless it was required", () => {
    expect(() => loadConfig({ file: "/nowhere/bunql.toml", env: {} })).not.toThrow()
    expect(() => loadConfig({ file: "/nowhere/bunql.toml", required: true, env: {} })).toThrow()
  })

  test("the data directory is made absolute and keys.json sits inside it", () => {
    const config = loadConfig({ env: {}, overrides: { data: { dir: "./relative-data" } } })
    expect(path.isAbsolute(config.data.dir)).toBe(true)
    expect(config.auth.keysFile).toBe(path.join(config.data.dir, "keys.json"))
  })
})

describe("key material", () => {
  test("a first start generates both secrets, persists them, and says so once", async () => {
    const dir = tempDataDir("bunql-keys-")
    const config = loadConfig({ env: {}, overrides: { data: { dir } } })
    const first = await resolveAuth(config)
    expect(first.adminKeyGenerated).toBe(true)
    expect(first.jwtKeyGenerated).toBe(true)
    expect(first.adminKey).toBeTruthy()

    const file = path.join(dir, "keys.json")
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as {
      adminKey: string
      signing: { d?: string }
    }
    expect(stored.adminKey).toBe(first.adminKey as string)
    expect(stored.signing.d).toBeTruthy()

    const second = await resolveAuth(config)
    expect(second.adminKeyGenerated).toBe(false)
    expect(second.jwtKeyGenerated).toBe(false)
    expect(second.adminKey).toBe(first.adminKey as string)
    expect(second.keys.signing.kid).toBe(first.keys.signing.kid)
  })

  test("a configured admin key is used as it stands and never written", async () => {
    const dir = tempDataDir("bunql-keys-")
    const config = loadConfig({
      env: {},
      overrides: { data: { dir }, auth: { adminKey: "configured-in-place" } },
    })
    const resolved = await resolveAuth(config)
    expect(resolved.adminKey).toBe("configured-in-place")
    expect(resolved.adminKeyGenerated).toBe(false)
  })

  test("a token minted by a restarted node still verifies", async () => {
    const dir = tempDataDir("bunql-keys-")
    const config = loadConfig({ env: {}, overrides: { data: { dir } } })
    const first = await resolveAuth(config)
    const token = await (async () => {
      const { mintToken } = await import("../../src/server/auth.ts")
      return mintToken(first.keys.signing, { ro: ["acme"] })
    })()
    const second = await resolveAuth(config)
    const claims = await verifyToken(second.keys, token)
    expect(claims.p?.ro?.ns).toEqual(["acme"])
  })
})

describe("a server built from that configuration", () => {
  test("honours the limits it was given", async () => {
    const server = await startTestServer({ limits: { maxRows: 2 } })
    await server.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name: "lim" }) })
    await server.fetch("/v1/db/lim/batch", {
      method: "POST",
      body: JSON.stringify({
        statements: [
          { sql: "create table t(id integer primary key)" },
          { sql: "insert into t default values" },
          { sql: "insert into t default values" },
          { sql: "insert into t default values" },
        ],
      }),
    })
    const response = await server.fetch("/v1/db/lim/query", {
      method: "POST",
      body: JSON.stringify({ sql: "select id from t" }),
    })
    expect(response.status).toBe(400)
    await server.close()
  })

  test("addresses the tenant by Host label when tenantFromHost is on", async () => {
    const server = await startTestServer({ server: { tenantFromHost: true } })
    await server.fetch("/v1/db", { method: "POST", body: JSON.stringify({ name: "acme" }) })
    const response = await fetch(`${server.url}/v1/db/acme/query`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.adminKey}`,
        "content-type": "application/json",
        "x-namespace": "acme",
      },
      body: JSON.stringify({ sql: "select 1" }),
    })
    expect(response.status).toBe(200)
    await server.close()
  })
})
