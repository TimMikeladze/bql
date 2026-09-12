// What shipping to object storage costs: how fast a backlog of records reaches the bucket, and
// how long a single commit takes to get there once the shipper is idle.
//
//   bun run bench/storage.ts [records]
//
// The bucket is `test/storage/fake-s3.ts`, the same in-process S3 the storage tests run against.
// That makes this a measurement of BunQL's side of the wire — batching, the segment layout, the
// manifest write and `Bun.S3Client`'s request path — with the network and a real S3's queueing
// taken out. A number from a real bucket will be slower and is a different question; this one is
// the ceiling, and the one that regresses when the shipper does.
//
// Steady-state latency is measured one commit at a time, because a shipper that is behind batches
// whatever has piled up: timing a commit inside a backlog would report the batch, not the trip.
//
// Throughput is measured commit-to-bucket over the whole burst, never over the flush at the end:
// the shipper runs on a timer while the writes are happening, so by the time the last commit
// lands most of the burst is already in the bucket and the final drain is a tail, not the work.
// Two byte counts come out of it, because they answer different questions — what BunQL pushed
// (the shipper re-uploads a segment as it grows) and what the bucket ends up holding.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startServer, type ServerHandle } from "../src/server/app.ts"
import { loadConfig } from "../src/server/config.ts"
import { FakeS3 } from "../test/storage/fake-s3.ts"
import { distribution, emit, percentile } from "./report.ts"

const RECORDS = Number(Bun.argv[2] ?? 2000)
const STEADY = Math.max(20, Math.min(200, Math.round(RECORDS / 10)))
const DB = "bench"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-s3-bench-"))
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }))

const bucket = await FakeS3.start({ bucket: "bunql-bench" })
const prefix = `bench-${Date.now().toString(36)}/`

const config = loadConfig({
  env: {},
  overrides: {
    server: { port: 0, host: "127.0.0.1", node: "s3-bench" },
    data: { dir: root },
    s3: {
      ...bucket.storeOptions,
      prefix,
      shipIntervalMs: 25,
      snapshotIntervalMs: 0,
      snapshotEveryBytes: 0,
      retention: "0",
      retries: 2,
    },
  },
})
const handle: ServerHandle = await startServer(config, { log: () => {} })

async function api(route: string, body?: unknown): Promise<Response> {
  return await fetch(`http://127.0.0.1:${handle.server.port}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${handle.adminKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

await api("/v1/db", { name: DB })
await api(`/v1/db/${DB}/query`, { sql: "create table t (id integer primary key, v text, n real)" })

const tenant = handle.registry.open(DB)
const shipper = handle.runtime.storage?.shipperFor(DB)
if (!shipper) throw new Error("the shipper pool did not attach a shipper to the benchmark database")

const insert = "insert into t (v, n) values (?, ?)"

/** Bytes the bucket holds under our prefix, which is what the shipper actually put there. */
function bytesInBucket(): number {
  let total = 0
  for (const [key, object] of bucket.objects) {
    if (key.includes(prefix)) total += object.body.byteLength
  }
  return total
}

// ── backlog: a burst of commits, then everything drained to the bucket ─────────────────────────

await shipper.flush()
const bytesBefore = bytesInBucket()
const wireBefore = shipper.bytesShipped
const startedNs = Bun.nanoseconds()
for (let i = 0; i < RECORDS; i++) {
  tenant.write((db) => db.prepare(insert).run(`row-${i}`, i))
  // The shipper is a timer and an async drain; yielding now and then is what a real workload does.
  if (i % 200 === 199) await Bun.sleep(0)
}
const committedNs = Bun.nanoseconds()
await shipper.flush()
const shippedNs = Bun.nanoseconds()

if (shipper.shippedTxid < tenant.txid) {
  throw new Error(`flush returned with the bucket at ${shipper.shippedTxid}, tenant at ${tenant.txid}`)
}
const bytes = bytesInBucket() - bytesBefore
const wireBytes = shipper.bytesShipped - wireBefore
const commitSeconds = (committedNs - startedNs) / 1e9
const shipSeconds = (shippedNs - startedNs) / 1e9

// ── steady state: one commit at a time, timed to the bucket ────────────────────────────────────

const steady: number[] = []
for (let i = 0; i < STEADY; i++) {
  const at = Bun.nanoseconds()
  tenant.write((db) => db.prepare(insert).run(`steady-${i}`, i))
  await shipper.flush()
  steady.push((Bun.nanoseconds() - at) / 1000)
}

const status = (await (await api(`/v1/db/${DB}/backup`)).json()) as {
  shipper: { shippedTxid: number; errors: number }
}

console.log(
  `\nShipping to ${bucket.endpoint} (the in-process fake), prefix ${prefix}\n` +
    `${RECORDS} single-row records, then ${STEADY} one at a time\n`,
)
console.log("leg                                       value")
console.log("-".repeat(56))
console.log(`${"records committed/s".padEnd(38)}${Math.round(RECORDS / commitSeconds).toLocaleString("en-US").padStart(14)}`)
console.log(`${"records shipped/s (commit to bucket)".padEnd(38)}${Math.round(RECORDS / shipSeconds).toLocaleString("en-US").padStart(14)}`)
console.log(`${"MiB/s pushed to the bucket".padEnd(38)}${(wireBytes / 1024 / 1024 / shipSeconds).toFixed(1).padStart(14)}`)
console.log(`${"bytes pushed per record".padEnd(38)}${Math.round(wireBytes / RECORDS).toLocaleString("en-US").padStart(14)}`)
console.log(`${"bytes retained per record".padEnd(38)}${Math.round(bytes / RECORDS).toLocaleString("en-US").padStart(14)}`)
console.log(
  `${"one commit to the bucket, p50 µs".padEnd(38)}${percentile(steady, 50).toFixed(1).padStart(14)}`,
)
console.log(
  `${"one commit to the bucket, p99 µs".padEnd(38)}${percentile(steady, 99).toFixed(1).padStart(14)}`,
)
console.log(
  `\nbucket holds ${bucket.objects.size} objects · shipped txid ${status.shipper.shippedTxid}` +
    ` · errors ${status.shipper.errors} · ${wireBytes.toLocaleString("en-US")} bytes pushed for` +
    ` ${bytes.toLocaleString("en-US")} retained (a segment is re-uploaded as it grows)`,
)

emit({
  bench: "storage",
  info: {
    records: RECORDS,
    backend: "fake-s3 (in process)",
    objects: bucket.objects.size,
    bytesPushed: wireBytes,
    bytesRetained: bytes,
  },
  legs: {
    "records shipped/s": {
      p50: Math.round(RECORDS / shipSeconds),
      value: Math.round(RECORDS / shipSeconds),
      unit: "rps",
    },
    "MiB/s to the bucket": {
      p50: Number((wireBytes / 1024 / 1024 / shipSeconds).toFixed(1)),
      value: Number((wireBytes / 1024 / 1024 / shipSeconds).toFixed(1)),
      unit: "count",
    },
    "one commit to the bucket": distribution(steady),
  },
})

await handle.close()
bucket.stop()
