// What one row costs through the tenant owner: the whole design §4.3 write path (BEGIN
// IMMEDIATE → COMMIT → tail → record → log append → position save) at both ack levels, and a
// point read through the reader pool.
//
//   bun run bench/tenant.ts [rounds]

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Database } from "../src/sqlite/index.ts"
import { TenantRegistry } from "../src/tenant/index.ts"

const ROUNDS = Number(Bun.argv[2] ?? 2000)

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

registry.close()
