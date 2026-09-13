// What one row costs through the tenant owner: the whole design §4.3 write path (BEGIN
// IMMEDIATE → COMMIT → tail → record → log append → position save) at both ack levels, and a
// point read through the reader pool.
//
//   bun run bench/tenant.ts [rounds] [--tenants N]
//
// `--tenants N` adds the design §10 "tenants open per process" leg: N databases created and then
// all held open at once, which is fd-bound at three descriptors each.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Database } from "../src/sqlite/index.ts"
import { fileDescriptorLimit, TenantRegistry } from "../src/tenant/index.ts"
import { distribution, emit } from "./report.ts"

const positional = Bun.argv.slice(2).filter((a) => !a.startsWith("--"))
const ROUNDS = Number(positional[0] ?? 2000)
const tenantsFlag = Bun.argv.find((a) => a.startsWith("--tenants"))
const TENANT_TARGET = tenantsFlag
  ? Number(tenantsFlag.includes("=") ? tenantsFlag.split("=")[1] : Bun.argv[Bun.argv.indexOf(tenantsFlag) + 1])
  : 0

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-tenant-bench-"))
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }))

const registry = TenantRegistry.open({ dir: root, maxOpen: 16 })
const tenant = await registry.create("bench", { pageSize: 4096 })
tenant.write((db) => db.exec("create table t(id integer primary key, v text, n real)"))

interface Leg {
  name: string
  samples: number[]
}

const legs: Leg[] = []

function measure(name: string, rounds: number, fn: (i: number) => void): Leg {
  const leg: Leg = { name, samples: new Array(rounds) }
  for (let i = 0; i < rounds; i++) {
    const started = Bun.nanoseconds()
    fn(i)
    leg.samples[i] = (Bun.nanoseconds() - started) / 1000
  }
  legs.push(leg)
  return leg
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[at] as number
}

// Warm the prepared-statement caches and the reader pool.
for (let i = 0; i < 50; i++) {
  tenant.write((db) => db.run("insert into t(v, n) values (?, ?)", [`warm${i}`, i]))
  tenant.readSync((db) => db.prepare("select v from t where id = ?").get(i + 1))
}

measure("write, ack local", ROUNDS, (i) => {
  tenant.write((db) => db.run("insert into t(v, n) values (?, ?)", [`row${i}`, i]))
})

measure("write, ack fsync", ROUNDS, (i) => {
  tenant.write((db) => db.run("insert into t(v, n) values (?, ?)", [`sync${i}`, i]), {
    ack: "fsync",
  })
})

measure("write, raw transaction only", ROUNDS, (i) => {
  tenant.writer.transaction(
    (db: Database) => db.run("insert into t(v, n) values (?, ?)", [`raw${i}`, i]),
    "immediate",
  )(tenant.writer)
})
// Those raw commits bypassed the recorder and the checkpoint policy; fold them into the log and
// checkpoint by hand so the legs below start from the same state as the ones above.
tenant.drain()
tenant.checkpoint("TRUNCATE")

measure("read by primary key (readSync)", ROUNDS, (i) => {
  tenant.readSync((db) => db.prepare("select v, n from t where id = ?").get((i % 1000) + 1))
})

const asyncReads: Leg = { name: "read by primary key (await read)", samples: [] }
for (let i = 0; i < ROUNDS; i++) {
  const started = Bun.nanoseconds()
  await tenant.read((db) => db.prepare("select v, n from t where id = ?").get((i % 1000) + 1))
  asyncReads.samples.push((Bun.nanoseconds() - started) / 1000)
}
legs.push(asyncReads)

const stats = tenant.stats()
console.log(
  `bunql tenant bench · ${ROUNDS} rounds · txid ${stats.txid} · db ${(stats.sizeBytes / 1e6).toFixed(1)} MB` +
    ` · wal ${(stats.walBytes / 1e6).toFixed(1)} MB · log ${(stats.logBytes / 1e6).toFixed(1)} MB\n`,
)
console.log("leg                                   p50 µs    p90 µs    p99 µs     max µs")
console.log("-".repeat(76))
for (const leg of legs) {
  const line = [50, 90, 99, 100]
    .map((p) => percentile(leg.samples, p).toFixed(1).padStart(9))
    .join(" ")
  console.log(`${leg.name.padEnd(36)}${line}`)
}

// Cold open: what an LRU miss costs. `close` folds the WAL into the database file, which is why
// the open that follows it does not have to re-verify a WAL to resume the tailer.
const closes: number[] = []
const opens: number[] = []
let current = tenant
for (let i = 0; i < 200; i++) {
  current.write((db) => db.run("insert into t(v, n) values (?, ?)", [`cold${i}`, i]))
  const a = Bun.nanoseconds()
  registry.release("bench")
  const b = Bun.nanoseconds()
  current = registry.open("bench")
  const c = Bun.nanoseconds()
  closes.push((b - a) / 1000)
  opens.push((c - b) / 1000)
}
console.log(
  `\nclose p50 ${percentile(closes, 50).toFixed(1)} µs · open p50 ${percentile(opens, 50).toFixed(1)} µs` +
    ` · open p90 ${percentile(opens, 90).toFixed(1)} µs`,
)

// ── tenants open per process (design §10: 10k, fd-bound at three descriptors each) ─────────────
//
// The number that matters is how many tenants can be open *at once*, so eviction is turned off by
// giving the registry a cap above the target and nothing is released until the count is taken.

let openedTenants = 0
const openFdLimit = fileDescriptorLimit() ?? 0
if (TENANT_TARGET > 0) {
  const manyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-tenants-"))
  process.on("exit", () => fs.rmSync(manyRoot, { recursive: true, force: true }))
  const many = TenantRegistry.open({ dir: manyRoot, maxOpen: TENANT_TARGET + 16, readers: 0 })
  const createdAt = Bun.nanoseconds()
  try {
    for (let i = 0; i < TENANT_TARGET; i++) {
      const t = await many.create(`t${i}`)
      t.write((db) => db.exec("create table t(id integer primary key)"))
      openedTenants++
    }
  } catch (err) {
    console.log(`\nstopped at ${openedTenants} tenants: ${String(err)}`)
  }
  const elapsedMs = (Bun.nanoseconds() - createdAt) / 1e6
  console.log(
    `\n${openedTenants.toLocaleString()} tenants created and held open in ${elapsedMs.toFixed(0)} ms` +
      ` · ulimit -n ${openFdLimit.toLocaleString()} · registry open ${many.openNames.length.toLocaleString()}`,
  )
  many.close()
}

emit({
  bench: "tenant",
  info: { rounds: ROUNDS, fdLimit: openFdLimit },
  legs: {
    ...Object.fromEntries(legs.map((leg) => [leg.name, distribution(leg.samples)])),
    "cold open (LRU miss)": distribution(opens),
    "tenant close": distribution(closes),
    ...(TENANT_TARGET > 0
      ? {
          "tenants open per process": {
            p50: openedTenants,
            value: openedTenants,
            unit: "count" as const,
          },
        }
      : {}),
  },
})

registry.close()
