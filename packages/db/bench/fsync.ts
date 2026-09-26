// L5's instrument, written before L5's code. What N write-active tenants on one thread cost the
// disk, and what they cost each other.
//
//   bun run bench/fsync.ts [rounds] [--tenants 1,10,100,500] [--sweep shared|per-db] [--ack fsync]
//
// The question it exists to answer: `[durability] fsyncSweep = "shared"` is only worth building if
// it beats `"per-db"` at a hundred write-active databases on both p99 and fsyncs per second,
// without losing more than 5% at one. `docs/plan-limits.md` L5 says the number decides the
// default, so the number is taken here rather than argued about.
//
// **What is counted.** `fsyncSync`, `fdatasyncSync` and the callback `fsync` — which is how L5's
// sweep issues its barriers, off the event loop — are wrapped for the life of the process, so
// "fsyncs per second" is the real syscall count rather than an estimate from the policy. Nothing
// in `src/` knows this file exists.
//
// **What a round is.** Every tenant issues `--depth` writes at once; the round ends when all of
// them have been answered. `--depth 1` is the shape the plan describes — many databases, each with
// one client — and deeper values are the shape a real node has, where group commit gets something
// to fold. Latency is per write, so p99 is the tail one tenant sees while the other N-1 are
// competing with it for the same disk.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { TenantRegistry } from "../src/tenant/index.ts"
import type { AckLevel } from "../src/tenant/index.ts"
import { emit, percentile, wantsJson, type Sample } from "./report.ts"

// ── syscall counter ────────────────────────────────────────────────────────────────────────────
// Wrapped once, before anything opens a log, so every fsync any layer performs is counted.

let fsyncs = 0
const realFsyncSync = fs.fsyncSync
const realFdatasyncSync = fs.fdatasyncSync
fs.fsyncSync = ((fd: number) => {
  fsyncs++
  return realFsyncSync(fd)
}) as typeof fs.fsyncSync
fs.fdatasyncSync = ((fd: number) => {
  fsyncs++
  return realFdatasyncSync(fd)
}) as typeof fs.fdatasyncSync
const realFsync = fs.fsync
fs.fsync = ((fd: number, cb: (err: NodeJS.ErrnoException | null) => void) => {
  fsyncs++
  return realFsync(fd, cb)
}) as typeof fs.fsync

const flag = (name: string, fallback: string): string => {
  const at = Bun.argv.indexOf(`--${name}`)
  if (at >= 0 && Bun.argv[at + 1]) return Bun.argv[at + 1] as string
  const inline = Bun.argv.find((a) => a.startsWith(`--${name}=`))
  return inline ? (inline.split("=")[1] as string) : fallback
}

const positional = Bun.argv.slice(2).filter((a) => !a.startsWith("--"))
const ROUNDS = Number(positional[0] ?? 400)
const LADDER = flag("tenants", "1,10,100,500")
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
const SWEEP = flag("sweep", "per-db") as "shared" | "per-db"
/** Concurrent writes each tenant issues per round: how much there is to fold before the fsync. */
const DEPTH = Number(flag("depth", "1"))
const ACK = flag("ack", "fsync") as AckLevel

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bql-fsync-bench-"))
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }))

interface Rung {
  tenants: number
  writes: number
  seconds: number
  writesPerSecond: number
  fsyncs: number
  fsyncsPerSecond: number
  fsyncsPerWrite: number
  p50: number
  p99: number
  /** Deepest the busiest tenant's write queue got while the rung ran. */
  peakQueue: number
}

async function rung(tenants: number): Promise<Rung> {
  const dir = path.join(root, `n${tenants}`)
  fs.mkdirSync(dir, { recursive: true })
  const registry = TenantRegistry.open({
    dir,
    // Every database stays open: this measures the disk, not the LRU.
    maxOpen: Math.max(16, tenants + 8),
    fsyncSweep: SWEEP,
  })
  const open = []
  for (let i = 0; i < tenants; i++) {
    const tenant = await registry.create(`d${i}`, { pageSize: 4096 })
    tenant.write((db) => db.exec("create table t(id integer primary key, v text)"))
    open.push(tenant)
  }

  // Warm: the prepared-statement cache, the first segment, the WAL descriptor.
  for (const tenant of open) {
    await tenant.writeQueued((db) => db.run("insert into t(v) values ('warm')"), { ack: ACK })
  }

  const latencies: number[] = []
  let peakQueue = 0
  fsyncs = 0
  const started = Bun.nanoseconds()
  for (let round = 0; round < ROUNDS; round++) {
    const inflight: Promise<void>[] = []
    for (const tenant of open) {
      for (let d = 0; d < DEPTH; d++) {
        const at = Bun.nanoseconds()
        inflight.push(
          tenant
            .writeQueued((db) => db.run("insert into t(v) values (?)", [`r${round}`]), { ack: ACK })
            .then(() => {
              latencies.push((Bun.nanoseconds() - at) / 1000)
            }),
        )
      }
      const depth = tenant.stats().queuedWrites
      if (depth > peakQueue) peakQueue = depth
    }
    await Promise.all(inflight)
  }
  const seconds = (Bun.nanoseconds() - started) / 1e9
  const counted = fsyncs
  const writes = ROUNDS * tenants * DEPTH
  registry.close()
  return {
    tenants,
    writes,
    seconds,
    writesPerSecond: writes / seconds,
    fsyncs: counted,
    fsyncsPerSecond: counted / seconds,
    fsyncsPerWrite: counted / writes,
    p50: percentile(latencies, 50),
    p99: percentile(latencies, 99),
    peakQueue,
  }
}

const rungs: Rung[] = []
for (const tenants of LADDER) rungs.push(await rung(tenants))

console.log(
  `bql fsync bench · sweep=${SWEEP} · ack=${ACK} · depth=${DEPTH} · ${ROUNDS} rounds/tenant · ` +
    `Bun ${Bun.version} · ${process.platform}/${process.arch}\n`,
)
console.log(
  "tenants   writes/s    fsyncs/s  fsyncs/write      p50 µs      p99 µs  peak queue",
)
console.log("-".repeat(78))
for (const r of rungs) {
  console.log(
    `${String(r.tenants).padStart(7)}` +
      `${r.writesPerSecond.toFixed(0).padStart(11)}` +
      `${r.fsyncsPerSecond.toFixed(0).padStart(12)}` +
      `${r.fsyncsPerWrite.toFixed(2).padStart(14)}` +
      `${r.p50.toFixed(1).padStart(12)}` +
      `${r.p99.toFixed(1).padStart(12)}` +
      `${String(r.peakQueue).padStart(12)}`,
  )
}

if (wantsJson()) {
  const legs: Record<string, Sample> = {}
  for (const r of rungs) {
    legs[`writes/s, ${r.tenants} tenants`] = {
      p50: r.writesPerSecond,
      value: r.writesPerSecond,
      unit: "rps",
    }
    legs[`fsyncs/s, ${r.tenants} tenants`] = {
      p50: r.fsyncsPerSecond,
      value: r.fsyncsPerSecond,
      unit: "count",
    }
    legs[`commit latency, ${r.tenants} tenants`] = { p50: r.p50, p99: r.p99, unit: "us" }
  }
  emit({ bench: "fsync", info: { sweep: SWEEP, ack: ACK, depth: DEPTH, rounds: ROUNDS }, legs })
}
