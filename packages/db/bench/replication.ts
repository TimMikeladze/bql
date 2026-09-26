// What replication costs over a real socket: the time from a commit on the primary to the row
// being readable on a replica in another process-shaped stack, and how many records a second the
// transport sustains. `bench/wal.ts` measures the same path with the transport taken out, so the
// difference between the two is the WebSocket, the frame codec and the event loop.
//
//   bun run bench/replication.ts [rounds]
//
// Both nodes run in this process on ephemeral ports, which is what makes the loopback socket a
// real socket rather than a function call. Latency is the gap between the two commit listeners
// for one txid — the primary's fires once the record is in its log, the replica's once the record
// is applied and its position is durable — so nothing is measured by polling and the figure is
// not rounded up to a timer tick. Throughput drives the primary's writer directly rather than
// over HTTP, because the question is what the transport carries, not what `fetch` costs.
//
// Three phase-1 routing legs sit beside the transport ones, all measured from a client's point of
// view: a write forwarded through a replica, and a write on the primary held for `ack: "replica"`
// and `ack: "quorum"`. Each is the same single-row insert as the plain HTTP write leg, so the
// difference between them is exactly what the routing or the durability level costs.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startServer, type ServerHandle } from "../src/server/app.ts"
import { loadConfig, type ServerConfigInput } from "../src/server/config.ts"
import { distribution, emit, percentile } from "./report.ts"

const ROUNDS = Number(Bun.argv[2] ?? 300)
const SUSTAINED = Number(Bun.argv[3] ?? 2000)
const SECRET = "bench-cluster-secret"
const DB = "bench"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bql-repl-bench-"))
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }))

async function startNode(name: string, overrides: ServerConfigInput): Promise<ServerHandle> {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  const config = loadConfig({
    env: {},
    overrides: {
      ...overrides,
      server: { port: 0, host: "127.0.0.1", node: name, ...overrides.server },
      data: { dir, ...overrides.data },
    },
  })
  return await startServer(config, { log: () => {} })
}

const primary = await startNode("primary", { replication: { secret: SECRET } })
const primaryUrl = `http://127.0.0.1:${primary.server.port}`
const replicationUrl = `ws://127.0.0.1:${primary.server.port}/v1/replication`

async function api(handle: ServerHandle, route: string, body?: unknown): Promise<Response> {
  return await fetch(`http://127.0.0.1:${handle.server.port}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${handle.adminKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

await api(primary, "/v1/db", { name: DB })
await api(primary, `/v1/db/${DB}/query`, {
  sql: "create table t (id integer primary key, v text, n real)",
})

const replica = await startNode("replica", {
  replication: { secret: SECRET, primary: replicationUrl, heartbeatMs: 1000, reconnectMs: 20 },
})

const primaryTenant = primary.registry.open(DB)

async function waitUntil(check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(1)
  }
}

await waitUntil(() => {
  const client = replica.runtime.replica
  return Boolean(client?.connected && replica.registry.has(DB))
}, "the replica to attach")

/** The replica's applied txid, read straight off its tenant rather than over HTTP. */
function appliedTxid(): bigint {
  return replica.registry.open(DB).txid
}

await waitUntil(() => appliedTxid() >= primaryTenant.txid, "the replica to catch up")

// ── latency: commit on the primary to applied on the replica ───────────────────────────────────

const replicaTenant = replica.registry.open(DB)
const committedAtNs = new Map<bigint, number>()
const latency: number[] = []
const httpWrite: number[] = []

// Only the one-at-a-time phase below is a latency measurement: during the throughput phase the
// records are queued behind each other by design, and timing them would report the queue.
let measuring = true
primaryTenant.onCommit((event) => {
  if (measuring) committedAtNs.set(event.txid, Bun.nanoseconds())
})
replicaTenant.onCommit((event) => {
  const started = committedAtNs.get(event.txid)
  if (started === undefined) return
  committedAtNs.delete(event.txid)
  latency.push((Bun.nanoseconds() - started) / 1000)
})

for (let round = 0; round < ROUNDS; round++) {
  const started = Bun.nanoseconds()
  const response = await api(primary, `/v1/db/${DB}/query`, {
    sql: "insert into t (v, n) values (?, ?)",
    args: [`row-${round}`, round],
  })
  if (!response.ok) throw new Error(`write ${round}: ${await response.text()}`)
  const written = BigInt(((await response.json()) as { txid: number }).txid)
  httpWrite.push((Bun.nanoseconds() - started) / 1000)
  while (appliedTxid() < written) await Bun.sleep(0)
}

measuring = false
if (latency.length === 0) throw new Error("no commit pairs were observed")

// ── routing and durability: what a client waits for ────────────────────────────────────────────

const ROUTING_ROUNDS = Math.max(20, Math.round(ROUNDS / 3))

async function measureWrites(
  node: ServerHandle,
  body: (round: number) => Record<string, unknown>,
): Promise<number[]> {
  const samples: number[] = []
  for (let round = -5; round < ROUTING_ROUNDS; round++) {
    const started = Bun.nanoseconds()
    const response = await api(node, `/v1/db/${DB}/query`, body(round))
    if (!response.ok) throw new Error(`routing write ${round}: ${await response.text()}`)
    await response.json()
    // The first few rounds warm the connection and the primary's prepared-statement cache.
    if (round >= 0) samples.push((Bun.nanoseconds() - started) / 1000)
  }
  return samples
}

const insertSql = "insert into t (v, n) values (?, ?)"
const forwarded = await measureWrites(replica, (round) => ({
  sql: insertSql,
  args: [`fwd-${round}`, round],
}))
const ackReplica = await measureWrites(primary, (round) => ({
  sql: insertSql,
  args: [`ack-${round}`, round],
  ack: "replica",
}))
const ackQuorum = await measureWrites(primary, (round) => ({
  sql: insertSql,
  args: [`quo-${round}`, round],
  ack: "quorum",
}))
await waitUntil(() => appliedTxid() >= primaryTenant.txid, "the replica to catch up after routing")

// ── throughput: how fast the transport carries a stream of records ─────────────────────────────

const insert = "insert into t (v, n) values (?, ?)"
const before = appliedTxid()
const startedNs = Bun.nanoseconds()
for (let i = 0; i < SUSTAINED; i++) {
  // Straight at the writer: one transaction, one record, no HTTP in the way.
  primaryTenant.write((db) => db.prepare(insert).run(`bulk-${i}`, i))
  // Every few hundred, let the event loop ship what has piled up, the way a real workload would.
  if (i % 200 === 199) await Bun.sleep(0)
}
const writtenNs = Bun.nanoseconds()
const target = primaryTenant.txid
while (appliedTxid() < target) await Bun.sleep(0)
const drainedNs = Bun.nanoseconds()

const records = Number(target - before)
const writeSeconds = (writtenNs - startedNs) / 1e9
const drainSeconds = (drainedNs - startedNs) / 1e9
const client = replica.runtime.replica
const server = primary.runtime.replication

const replicaChecksum = replica.registry.open(DB).checksum
const primaryChecksum = primaryTenant.checksum

console.log(
  `\nReplication over a loopback WebSocket: ${ROUNDS} single-row transactions, ` +
    `then ${records} records streamed\n`,
)
console.log("leg                         p50 µs    p90 µs    p99 µs     max µs")
console.log("-".repeat(66))
for (const [name, samples] of [
  ["primary write (HTTP)", httpWrite],
  ["commit -> replica applied", latency],
  ["write forwarded via replica", forwarded],
  ["write, ack replica", ackReplica],
  ["write, ack quorum", ackQuorum],
] as const) {
  const line = [50, 90, 99, 100]
    .map((p) => percentile(samples, p).toFixed(1).padStart(9))
    .join(" ")
  console.log(`${name.padEnd(26)}${line}`)
}

console.log(
  `\nsustained: ${records} records in ${drainSeconds.toFixed(3)} s ` +
    `= ${Math.round(records / drainSeconds)} records/s applied end to end ` +
    `(${Math.round(records / writeSeconds)} records/s committed on the primary).` +
    `\nBoth nodes share one event loop here, so this is the pair's combined ceiling, not each` +
    ` node's.`,
)
console.log(
  `transport: ${server?.recordsSent ?? 0} records sent, ${client?.recordsApplied ?? 0} applied, ` +
    `${((server?.bytesSent ?? 0) / 1024).toFixed(0)} KiB on the wire`,
)
console.log(
  `primary checksum ${primaryChecksum} · replica ${replicaChecksum} ` +
    `· match ${primaryChecksum === replicaChecksum}`,
)
if (primaryChecksum !== replicaChecksum) {
  throw new Error("the replica diverged during the benchmark")
}

// ── P9: what the logical section costs, in bytes ───────────────────────────────────────────────
//
// A count, not a timing, so it resolves on a loaded machine where a latency figure would not. The
// same transactions are written on two standalone primaries, one recording row changes and one
// not, and what is compared is the total encoded record bytes — the thing that goes on the wire,
// into the log and into the bucket. Three shapes, because the ratio is entirely a function of how
// much row there is per page touched: a narrow single-row insert is the cheap end and a wide row
// is where the logical bytes overtake the page bytes.

type Run = (sql: string, args: unknown[]) => void

interface SizeShape {
  name: string
  schema: string
  /** Rows to put there before the measurement starts, in one untimed transaction. */
  setup?: (run: Run) => void
  /** One transaction. */
  write(run: Run, round: number): void
  rounds: number
  /** What to record when the flag is on. Default `"row"`. */
  level?: "pk" | "row" | "row+old"
}

/**
 * 200 bytes of deterministic high-entropy text. A repeated character would be squashed by the
 * zstd the record body already pays for — in both halves — and would report a ratio a real
 * payload never sees. This is the shape where the logical bytes genuinely compete with the page
 * bytes, because the same row is in both and neither compresses.
 */
function wideValue(round: number): string {
  let out = ""
  let state = (round * 2654435761) >>> 0
  for (let i = 0; i < 200; i++) {
    state = (state * 1664525 + 1013904223) >>> 0
    out += String.fromCharCode(33 + (state >>> 25) % 90)
  }
  return out
}

const SHAPES: SizeShape[] = [
  {
    name: "single-row insert",
    schema: "create table t (id integer primary key, v text, n real)",
    write: (run, round) => run("insert into t (v, n) values (?, ?)", [`row-${round}`, round]),
    rounds: 200,
  },
  {
    name: "wide row, 200 B random",
    schema: "create table t (id integer primary key, v text, n real)",
    write: (run, round) => run("insert into t (v, n) values (?, ?)", [wideValue(round), round]),
    rounds: 200,
  },
  {
    // The expensive end, and the reason the flag is off by default: small rows pack many to a
    // page, so a transaction that touches a thousand of them writes a handful of pages and a
    // thousand row changes. The logical section is then paying per row where the pages pay per
    // page.
    name: "1000 small rows, 1 txn",
    schema: "create table t (id integer primary key, v text, n real)",
    write: (run, round) => {
      for (let i = 0; i < 1000; i++) run("insert into t (v, n) values (?, ?)", [`b${round}-${i}`, i])
    },
    rounds: 10,
  },
  {
    // `row+old` is the whole row twice on the wire, which is why the recorded level is its own
    // setting rather than whatever the primary happens to be capturing.
    name: "1000 updates, row+old",
    schema: "create table t (id integer primary key, v text, n real)",
    level: "row+old",
    setup: (run) => {
      for (let i = 0; i < 1000; i++) run("insert into t (v, n) values (?, ?)", [`seed-${i}`, i])
    },
    write: (run, round) => {
      for (let i = 1; i <= 1000; i++) run("update t set v = ? where id = ?", [`u${round}-${i}`, i])
    },
    rounds: 10,
  },
]

/** Total encoded record bytes for one shape on a node with `logicalChanges` set as given. */
async function recordBytes(shape: SizeShape, on: boolean, tag: string): Promise<number> {
  const logical = on ? (shape.level ?? "row") : false
  const node = await startNode(`size-${tag}`, { replication: { logicalChanges: logical } })
  try {
    await api(node, "/v1/db", { name: DB })
    await api(node, `/v1/db/${DB}/query`, { sql: shape.schema })
    const tenant = node.registry.open(DB)
    // Opening the tenant through the registry is what installs the recorder, exactly as a request
    // would; the first write then carries rows whether or not anything is subscribed.
    const setup = shape.setup
    if (setup) {
      tenant.write((db) => {
        setup((sql, args) => {
          db.prepare(sql).run(...(args as never[]))
        })
      })
      tenant.drain()
    }
    let total = 0
    const off = tenant.onCommit((event) => {
      total += event.bytes.byteLength
    })
    for (let round = 0; round < shape.rounds; round++) {
      tenant.write((db) => {
        shape.write((sql, args) => {
          db.prepare(sql).run(...(args as never[]))
        }, round)
      })
    }
    tenant.drain()
    off()
    return total
  } finally {
    await node.close()
  }
}

const sizes: { name: string; off: number; on: number; ratio: number }[] = []
for (const shape of SHAPES) {
  const plain = await recordBytes(shape, false, `${shape.name.replace(/[^a-z]/gi, "")}-off`)
  const withRows = await recordBytes(shape, true, `${shape.name.replace(/[^a-z]/gi, "")}-on`)
  sizes.push({ name: shape.name, off: plain, on: withRows, ratio: withRows / plain })
}

console.log("\nP9 record size, [replication] logicalChanges off vs row\n")
console.log("shape                        off B      on B     ratio")
console.log("-".repeat(56))
for (const size of sizes) {
  console.log(
    `${size.name.padEnd(24)}${String(size.off).padStart(9)}${String(size.on).padStart(10)}` +
      `${`${size.ratio.toFixed(2)}x`.padStart(10)}`,
  )
}

emit({
  bench: "replication",
  info: {
    rounds: ROUNDS,
    records,
    recordsPerSecond: Math.round(records / drainSeconds),
    primary: primaryUrl,
    ...Object.fromEntries(
      sizes.map((size) => [`logical size, ${size.name}`, `${size.off} B -> ${size.on} B, ${size.ratio.toFixed(2)}x`]),
    ),
  },
  legs: {
    "primary write (HTTP)": distribution(httpWrite),
    "commit -> replica applied": distribution(latency),
    "write forwarded via replica": distribution(forwarded),
    "write, ack replica": distribution(ackReplica),
    "write, ack quorum": distribution(ackQuorum),
    "records/s applied": { p50: Math.round(records / drainSeconds), unit: "rps" },
  },
})

await replica.close()
await primary.close()
