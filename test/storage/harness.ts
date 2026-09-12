// Shared fixtures for the storage tests: a bucket to ship to, a tenant to ship from, and scratch
// directories that are always cleaned up.
//
// The bucket is a real S3-compatible server when `BUNQL_TEST_S3_ENDPOINT` names one (a MinIO in
// Docker, say) and the in-process `FakeS3` otherwise — `describeBackend()` says which ran, so a
// test report never has to guess.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { S3Store } from "../../src/storage/index.ts"
import { Catalog, TenantRegistry } from "../../src/tenant/index.ts"
import type { Tenant } from "../../src/tenant/index.ts"
import { FakeS3 } from "./fake-s3.ts"

const created: string[] = []
const registries: TenantRegistry[] = []
const fakes: FakeS3[] = []

export function tempDir(prefix = "bunql-s3-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  created.push(dir)
  return dir
}

export function cleanup(): void {
  for (const registry of registries.splice(0)) {
    try {
      registry.close()
    } catch {
      // A registry a test already closed is not a failure.
    }
  }
  for (const fake of fakes.splice(0)) fake.stop()
  while (created.length > 0) {
    const dir = created.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
}

export interface Backend {
  kind: "minio" | "fake"
  store(prefixSuffix?: string): S3Store
  /** Credentials for a caller building its own store or server config. */
  credentials: {
    bucket: string
    endpoint: string
    region: string
    accessKeyId: string
    secretAccessKey: string
  }
  /** The fake, when that is what is running; tests that inject faults skip without it. */
  fake: FakeS3 | null
  bucket: string
  endpoint: string
  describe(): string
  /** A prefix nothing else in the run uses. */
  prefix(): string
}

let counter = 0

/**
 * A real bucket when the environment names one, the in-process fake otherwise. A real endpoint is
 * used exactly as given: the test never creates or deletes a bucket, only keys under a prefix of
 * its own.
 */
export async function openBackend(): Promise<Backend> {
  const endpoint = process.env.BUNQL_TEST_S3_ENDPOINT
  const bucket = process.env.BUNQL_TEST_S3_BUCKET ?? "bunql-test"
  const base = `test-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`

  if (endpoint) {
    const options = {
      bucket,
      endpoint,
      region: process.env.BUNQL_TEST_S3_REGION ?? "us-east-1",
      accessKeyId: process.env.BUNQL_TEST_S3_ACCESS_KEY ?? "minioadmin",
      secretAccessKey: process.env.BUNQL_TEST_S3_SECRET_KEY ?? "minioadmin",
    }
    return {
      kind: "minio",
      fake: null,
      bucket,
      endpoint,
      credentials: options,
      store: () => new S3Store({ ...options, concurrency: 4, retries: 2, retryBaseMs: 10 }),
      describe: () => `a real S3-compatible server at ${endpoint}, bucket ${bucket}`,
      prefix: () => `${base}/${counter++}/`,
    }
  }

  const fake = await FakeS3.start({ bucket })
  fakes.push(fake)
  return {
    kind: "fake",
    fake,
    bucket,
    endpoint: fake.endpoint,
    credentials: fake.storeOptions,
    store: () => new S3Store({ ...fake.storeOptions, concurrency: 4, retries: 2, retryBaseMs: 10 }),
    describe: () => `the in-process fake S3 at ${fake.endpoint}, bucket ${bucket}`,
    prefix: () => `${base}/${counter++}/`,
  }
}

/** A registry in a scratch directory, closed by `cleanup()`. */
export function openRegistry(options: { dir?: string; segmentBytes?: number } = {}): TenantRegistry {
  const registry = TenantRegistry.open({
    dir: options.dir ?? tempDir(),
    ...(options.segmentBytes !== undefined ? { segmentBytes: options.segmentBytes } : {}),
    logFsync: "never",
    sweepIntervalMs: 10_000,
  })
  registries.push(registry)
  return registry
}

/** A tenant with a `todos` table, ready to be written to. */
export async function openTenant(
  registry: TenantRegistry,
  name = "acme",
): Promise<Tenant> {
  const tenant = await registry.create(name)
  tenant.write((db) => {
    db.exec("create table todos (id integer primary key, title text not null, done integer)")
  })
  return tenant
}

/** `n` rows, one transaction each, so the log gains exactly `n` records. */
export function writeRows(tenant: Tenant, from: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const id = from + i
    tenant.write((db) => {
      db.prepare("insert into todos (id, title, done) values (?, ?, ?)").run(
        id,
        `todo ${id}`,
        id % 2,
      )
    })
  }
}

/** Every user table and its rows, ordered, as one comparable string. */
export function dumpFile(dbPath: string): string {
  const { Database } = require("../../src/sqlite/index.ts") as typeof import("../../src/sqlite/index.ts")
  const db = Database.open(dbPath, { readonly: true, wal: false })
  try {
    const tables = db
      .prepare(
        "select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name",
      )
      .all()
    const parts: string[] = []
    for (const row of tables) {
      const table = row.name as string
      const rows = db.prepare(`select * from "${table}" order by rowid`).values()
      parts.push(`## ${table}\n${rows.map((one) => JSON.stringify(one)).join("\n")}`)
    }
    return parts.join("\n")
  } finally {
    db.close()
  }
}

export function catalogOf(registry: TenantRegistry): Catalog {
  return registry.catalog
}
