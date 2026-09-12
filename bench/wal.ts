// WAL shipping benchmark: what one 5-row transaction costs on each leg of the path, from the
// primary's COMMIT to a replica reader seeing the row. Design §2.1 measured 184 µs p50 for the
// whole loop with bun:sqlite; this measures the same loop through our own driver and the real
// record/log/applier stack.
//
//   bun run bench/wal.ts

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Database } from "../src/sqlite/index.ts"
import {
  computeFull,
  decode,
  encode,
  TxnLog,
  TxnRecorder,
  type TxnRecordInput,
  WalApplier,
} from "../src/wal/index.ts"

const ROUNDS = 500
const ROWS_PER_TXN = 5
// "each" fsyncs the replica position file after every transaction; "rename" relies on the atomic
// rename alone. Pass an argument to compare.
const META_FSYNC = (Bun.argv[2] as "each" | "rename" | undefined) ?? "each"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-wal-bench-"))
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }))
const primaryDir = path.join(root, "primary")
const replicaDir = path.join(root, "replica")
fs.mkdirSync(primaryDir)
fs.mkdirSync(replicaDir)

const dbPath = path.join(primaryDir, "main.db")
const replicaPath = path.join(replicaDir, "main.db")

const db = Database.open(dbPath)
db.exec("pragma synchronous = normal")
db.exec("pragma wal_autocheckpoint = 0")
db.exec("create table t(id integer primary key, v text, n real)")
db.walCheckpoint("TRUNCATE")
fs.copyFileSync(dbPath, replicaPath)

const base = computeFull(replicaPath, { includeWal: false })
const recorder = TxnRecorder.open({ dbPath, epoch: 1 })
const log = TxnLog.open({ dir: primaryDir, fsync: "never" })
const applier = new WalApplier({ dbPath: replicaPath, dir: replicaDir, fsync: META_FSYNC })
applier.seed({
  txid: 0n,
  epoch: 1,
  postChecksum: base.checksum,
  dbSizePages: base.pages,
  pageSize: base.pageSize,
})
const reader = Database.open(replicaPath, { readonly: true })

const insert = db.prepare("insert into t(v, n) values (?, ?)")
const count = reader.prepare("select count(*) c from t")

interface Leg {
  name: string
  samples: number[]
}

const legs: Record<string, Leg> = {
  commit: { name: "primary commit", samples: [] },
  tail: { name: "tail + checksum", samples: [] },
  encodeLeg: { name: "encode (zstd)", samples: [] },
  append: { name: "log append", samples: [] },
  decodeLeg: { name: "decode", samples: [] },
  apply: { name: "replica apply (fdatasync)", samples: [] },
  read: { name: "replica read", samples: [] },
  total: { name: "end to end", samples: [] },
}

function record(leg: Leg, startedNs: number): number {
  const now = Bun.nanoseconds()
  leg.samples.push((now - startedNs) / 1000)
  return now
}

let bytesEncoded = 0
let bytesPlain = 0
let pagesShipped = 0

for (let round = 0; round < ROUNDS; round++) {
  const t0 = Bun.nanoseconds()

  db.transaction(() => {
    for (let i = 0; i < ROWS_PER_TXN; i++) insert.run(`row-${round}-${i}`, round + i / 10)
  })()
  let mark = record(legs.commit as Leg, t0)

  const inputs: TxnRecordInput[] = recorder.poll()
  mark = record(legs.tail as Leg, mark)

  const encoded = inputs.map((input) => encode(input))
  mark = record(legs.encodeLeg as Leg, mark)

  for (const bytes of encoded) log.appendEncoded(bytes)
  mark = record(legs.append as Leg, mark)

  const records = encoded.map((bytes) => decode(bytes).record)
  mark = record(legs.decodeLeg as Leg, mark)

  for (const decoded of records) applier.apply(decoded)
  mark = record(legs.apply as Leg, mark)

  const rows = count.get()?.c
  record(legs.read as Leg, mark)
  record(legs.total as Leg, t0)

  if (Number(rows) !== (round + 1) * ROWS_PER_TXN) {
    throw new Error(`replica is behind at round ${round}: ${String(rows)}`)
  }
  for (let i = 0; i < encoded.length; i++) {
    bytesEncoded += (encoded[i] as Uint8Array).byteLength
    const input = inputs[i] as TxnRecordInput
    bytesPlain += input.pages.size * input.pageSize
    pagesShipped += input.pages.size
  }

  // Keep the WAL from growing without bound, the way the checkpoint policy of design §4.3 will.
  if (round % 100 === 99) {
    db.walCheckpoint("TRUNCATE")
    applier.checkpoint("TRUNCATE")
  }
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))
  return sorted[index] as number
}

console.log(
  `\nWAL shipping: ${ROUNDS} transactions of ${ROWS_PER_TXN} rows, primary -> replica, same process` +
    `\nreplica position fsync: ${META_FSYNC}\n`,
)
console.log("leg                         p50 µs    p90 µs    p99 µs     max µs")
console.log("-".repeat(66))
for (const leg of Object.values(legs)) {
  const line = [
    percentile(leg.samples, 50),
    percentile(leg.samples, 90),
    percentile(leg.samples, 99),
    percentile(leg.samples, 100),
  ]
    .map((v) => v.toFixed(1).padStart(9))
    .join(" ")
  console.log(`${leg.name.padEnd(26)}${line}`)
}

console.log(
  `\npages per transaction ${(pagesShipped / ROUNDS).toFixed(1)}` +
    ` · record ${(bytesEncoded / ROUNDS).toFixed(0)} B` +
    ` vs ${(bytesPlain / ROUNDS).toFixed(0)} B of pages` +
    ` (${(bytesPlain / bytesEncoded).toFixed(1)}x)`,
)
console.log(
  `primary checksum ${recorder.position.checksum} · replica ${applier.position.postChecksum}` +
    ` · match ${recorder.position.checksum === applier.position.postChecksum}`,
)

reader.close()
applier.close()
log.close()
recorder.close()
db.close()
