// `bql` as an operator actually runs it: a spawned process against a server this test started.
// The shell is exempt — it needs a terminal — and `serve` is covered by the server's own tests.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { parseFrom, parseTables, parseTtlMs } from "../../src/cli.ts"
import { startTestServer, stopAll, type TestServer } from "../server/harness.ts"

const CLI = path.join(import.meta.dir, "..", "..", "src", "cli.ts")

let server: TestServer

beforeAll(async () => {
  server = await startTestServer()
})
afterAll(stopAll)

interface Ran {
  code: number
  stdout: string
  stderr: string
}

async function bql(...args: string[]): Promise<Ran> {
  const child = Bun.spawn(["bun", CLI, ...args], {
    env: {
      ...process.env,
      BQL_URL: server.url,
      BQL_ADMIN_KEY: server.adminKey,
      BQL_TOKEN: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr }
}

describe("db", () => {
  test("create, list and stat a database", async () => {
    const created = await bql("db", "create", "cli")
    expect(created.code).toBe(0)
    expect(created.stdout).toContain("created cli")

    const listed = await bql("db", "list", "--json")
    expect(listed.code).toBe(0)
    const databases = (JSON.parse(listed.stdout) as { databases: { name: string }[] }).databases
    expect(databases.map((row) => row.name)).toContain("cli")

    const stat = await bql("db", "stat", "cli", "--json")
    expect(stat.code).toBe(0)
    expect((JSON.parse(stat.stdout) as { name: string }).name).toBe("cli")
  })

  test("a human-readable list is a table", async () => {
    const listed = await bql("db", "list")
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain("cli")
    expect(listed.stdout).toContain("txid")
  })

  test("fork, checkpoint, snapshot and delete", async () => {
    await bql("exec", "cli", "--sql", "create table t(id integer primary key, v text)")
    await bql("exec", "cli", "--sql", "insert into t(v) values ('one')")

    const forked = await bql("db", "fork", "cli-copy", "--from", "cli")
    expect(forked.code).toBe(0)
    expect(forked.stdout).toContain("forked cli into cli-copy")

    const rows = await bql("exec", "cli-copy", "--sql", "select v from t", "--json")
    expect(JSON.parse(rows.stdout)).toEqual([{ v: "one" }])

    const snapshot = await bql("snapshot", "cli", "--json")
    expect(snapshot.code).toBe(0)
    expect(JSON.parse(snapshot.stdout).txid).toBeGreaterThan(0)

    const checkpoint = await bql("checkpoint", "cli", "--mode", "TRUNCATE", "--json")
    expect(checkpoint.code).toBe(0)
    expect(JSON.parse(checkpoint.stdout).walBytes).toBe(0)

    const deleted = await bql("db", "delete", "cli-copy")
    expect(deleted.code).toBe(0)
    expect(deleted.stdout).toContain("deleted cli-copy")
  })

  test("a failure is a message on stderr and a non-zero exit", async () => {
    const missing = await bql("db", "stat", "nope")
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain("DB_NOT_FOUND")

    const unknown = await bql("wat")
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain("unknown command")
  })
})

describe("token", () => {
  test("mints a token the server then accepts", async () => {
    const minted = await bql(
      "token",
      "--db",
      "cli",
      "--scope",
      "ro",
      "--ttl",
      "30d",
      "--tables",
      "t:r",
    )
    expect(minted.code).toBe(0)
    const token = minted.stdout.trim()
    expect(token.split(".")).toHaveLength(3)

    const allowed = await fetch(`${server.url}/v1/db/cli/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sql: "select count(*) as n from t", rows: "object" }),
    })
    expect(allowed.status).toBe(200)

    // `ro` means read-only, which is the point of handing this token out.
    const refused = await fetch(`${server.url}/v1/db/cli/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sql: "insert into t(v) values ('nope')" }),
    })
    expect(refused.status).toBe(403)
  })
})

describe("help", () => {
  test("no command prints the usage and exits non-zero", async () => {
    const bare = await bql()
    expect(bare.code).toBe(1)
    expect(bare.stdout).toContain("bql serve")

    const asked = await bql("--help")
    expect(asked.code).toBe(0)
    expect(asked.stdout).toContain("bql token")
  })
})

describe("flag parsing", () => {
  test("a ttl is a duration or a count of seconds", () => {
    expect(parseTtlMs("30d")).toBe(30 * 86_400_000)
    expect(parseTtlMs("12h")).toBe(12 * 3_600_000)
    expect(parseTtlMs("90")).toBe(90_000)
    expect(() => parseTtlMs("soon")).toThrow()
  })

  test("a table ACL is name:scope pairs", () => {
    expect(parseTables("todos:r,users:rw")).toEqual({ todos: "r", users: "rw" })
    expect(() => parseTables("todos")).toThrow()
    expect(() => parseTables("todos:x")).toThrow()
  })

  test("--from takes a database, a txid or a time", () => {
    expect(parseFrom("acme")).toEqual({ db: "acme" })
    expect(parseFrom("acme@4812")).toEqual({ db: "acme", at: 4812 })
    expect(parseFrom("acme@2026-09-11T10:00:00Z")).toEqual({
      db: "acme",
      at: "2026-09-11T10:00:00Z",
    })
  })
})
