// `bql backup` and `bql restore --from s3://…` as an operator runs them: a spawned process
// against a server that is shipping to a bucket.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { parseS3Url } from "../../src/cli.ts"
import { startServer, type ServerHandle } from "../../src/server/app.ts"
import { loadConfig } from "../../src/server/config.ts"
import { type Backend, cleanup, openBackend, tempDir } from "./harness.ts"

const CLI = path.join(import.meta.dir, "..", "..", "src", "cli.ts")

let backend: Backend
let handle: ServerHandle
let prefix: string

beforeAll(async () => {
  backend = await openBackend()
  prefix = backend.prefix()
  const credentials = backend.credentials
  const config = loadConfig({
    env: {},
    overrides: {
      server: { port: 0, host: "127.0.0.1", node: "cli-node" },
      data: { dir: tempDir("bql-s3-cli-") },
      s3: {
        ...credentials,
        prefix,
        shipIntervalMs: 20,
        snapshotIntervalMs: 0,
        snapshotEveryBytes: 0,
        retention: "0",
        retries: 2,
      },
    },
  })
  handle = await startServer(config, { log: () => {} })
})

afterAll(async () => {
  await handle.close()
  cleanup()
})

interface Ran {
  code: number
  stdout: string
  stderr: string
}

async function bql(...args: string[]): Promise<Ran> {
  const child = Bun.spawn(["bun", CLI, ...args], {
    env: {
      ...process.env,
      BQL_URL: `http://127.0.0.1:${handle.server.port}`,
      BQL_ADMIN_KEY: handle.adminKey as string,
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

describe("parsing an s3 url", () => {
  test("splits the bucket from the prefix", () => {
    expect(parseS3Url("s3://backups")).toEqual({ bucket: "backups" })
    expect(parseS3Url("s3://backups/bql/prod")).toEqual({
      bucket: "backups",
      prefix: "bql/prod",
    })
  })

  test("refuses anything that is not an s3 url", () => {
    expect(() => parseS3Url("backups")).toThrow()
    expect(() => parseS3Url("s3:///prefix")).toThrow()
  })
})

describe("bql backup and restore", () => {
  test("status, verify and a restore from the bucket", async () => {
    expect((await bql("db", "create", "books")).code).toBe(0)
    expect(
      (await bql("exec", "books", "--sql", "create table b (id integer primary key, t text)")).code,
    ).toBe(0)
    for (let i = 1; i <= 5; i++) {
      await bql("exec", "books", "--sql", `insert into b (id, t) values (${i}, 'book ${i}')`)
    }
    await handle.runtime.storage?.flush()

    const status = await bql("backup", "status", "books")
    expect(status.code).toBe(0)
    expect(status.stdout).toContain("shipped txid 6")
    expect(status.stdout).toContain("caught up")

    const verified = await bql("backup", "verify", "books", "--at", "6")
    expect(verified.code).toBe(0)
    expect(verified.stdout).toContain("restorable to txid 6")

    const generations = await bql("backup", "generations", "books", "--json")
    expect(generations.code).toBe(0)
    expect(JSON.parse(generations.stdout).generations).toHaveLength(1)

    const restored = await bql(
      "restore",
      "books",
      "--from",
      `s3://${backend.bucket}/${prefix.replace(/\/$/, "")}`,
      "--at",
      "4",
      "--into",
      "books-old",
    )
    expect(restored.code).toBe(0)
    expect(restored.stdout).toContain("books-old")
    expect(restored.stdout).toContain("at txid 4")

    const rows = await bql("exec", "books-old", "--sql", "select count(*) as n from b", "--json")
    expect(rows.code).toBe(0)
    expect(JSON.parse(rows.stdout)[0].n).toBe(3)
  })

  test("verifying a database with nothing shipped fails with a readable message", async () => {
    const result = await bql("backup", "verify", "absent")
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("S3_NO_MANIFEST")
  })

  test("an unknown backup subcommand is refused", async () => {
    const result = await bql("backup", "wat", "books")
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("unknown backup command")
  })
})
