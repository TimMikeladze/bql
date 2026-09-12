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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-repl-bench-"))
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

emit({
  bench: "replication",
  info: {
    rounds: ROUNDS,
    records,
    recordsPerSecond: Math.round(records / drainSeconds),
    primary: primaryUrl,
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
