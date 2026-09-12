// What a request costs over the wire: a point read over HTTP keep-alive, the same over a
// WebSocket, a single-row write over HTTP, and 2000 concurrent reads. Compared against the
// budgets of design §10.
//
//   bun run bench/http.ts [rounds]
//
// The client and the server share this process, which is what design §2.4 measured too: it takes
// the network out of the number and leaves the transport, the codec and SQLite.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startServer } from "../src/server/app.ts"
import { loadConfig } from "../src/server/config.ts"

const ROUNDS = Number(Bun.argv[2] ?? 2000)
const CONCURRENT = 2000

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-http-bench-"))
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }))

const config = loadConfig({
  env: {},
  overrides: { server: { port: 0, host: "127.0.0.1", node: "bench" }, data: { dir: root } },
})
const handle = await startServer(config, { log: () => {} })
const base = `http://127.0.0.1:${handle.server.port}`
const admin = handle.adminKey as string
const headers = {
  authorization: `Bearer ${admin}`,
  "content-type": "application/json",
}

async function post(route: string, body: unknown): Promise<Response> {
  return fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(body) })
}

await post("/v1/db", { name: "bench" })
await post("/v1/db/bench/query", {
  sql: "create table t(id integer primary key, v text, n real)",
})
for (let i = 0; i < 1000; i += 100) {
  await post("/v1/db/bench/batch", {
    statements: Array.from({ length: 100 }, (_, j) => ({
      sql: "insert into t(v, n) values (?, ?)",
      args: [`row${i + j}`, i + j],
    })),
  })
}

interface Leg {
  name: string
  samples: number[]
  budgetUs?: number
}

const legs: Leg[] = []

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[at] as number
}

async function measure(
  name: string,
  rounds: number,
  fn: (i: number) => Promise<unknown>,
  budgetUs?: number,
): Promise<void> {
  // Warm the connection, the prepared-statement cache and the policy memo.
  for (let i = 0; i < 50; i++) await fn(i)
  const samples: number[] = new Array(rounds)
  for (let i = 0; i < rounds; i++) {
    const started = Bun.nanoseconds()
    await fn(i)
    samples[i] = (Bun.nanoseconds() - started) / 1000
  }
  legs.push({ name, samples, ...(budgetUs !== undefined ? { budgetUs } : {}) })
}

// ── HTTP ───────────────────────────────────────────────────────────────────────────────────────

await measure(
  "point read, HTTP keep-alive",
  ROUNDS,
  async (i) => {
    const response = await post("/v1/db/bench/query", {
      sql: "select v, n from t where id = ?",
      args: [(i % 1000) + 1],
    })
    await response.json()
  },
  60,
)

await measure(
  "single-row write, ack local, HTTP",
  ROUNDS,
  async (i) => {
    const response = await post("/v1/db/bench/query", {
      sql: "insert into t(v, n) values (?, ?)",
      args: [`w${i}`, i],
    })
    await response.json()
  },
  40,
)

await measure("healthz, HTTP", ROUNDS, async () => {
  await (await fetch(`${base}/healthz`)).json()
})

// ── WebSocket ──────────────────────────────────────────────────────────────────────────────────

interface Waiter {
  resolve: (value: unknown) => void
}

const socket = new WebSocket(`ws://127.0.0.1:${handle.server.port}/v1/ws?token=${encodeURIComponent(admin)}`, "bunql.v1")
const waiters = new Map<number, Waiter>()
await new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true })
  socket.addEventListener("error", () => reject(new Error("socket failed")), { once: true })
})
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as { id?: number }
  if (typeof message.id !== "number") return
  const waiter = waiters.get(message.id)
  if (!waiter) return
  waiters.delete(message.id)
  waiter.resolve(message)
})

let nextId = 1
function ask(frame: Record<string, unknown>): Promise<unknown> {
  const id = nextId++
  socket.send(JSON.stringify({ ...frame, id }))
  return new Promise((resolve) => waiters.set(id, { resolve }))
}

await measure(
  "point read, WebSocket",
  ROUNDS,
  (i) =>
    ask({
      op: "query",
      db: "bench",
      sql: "select v, n from t where id = ?",
      args: [(i % 1000) + 1],
    }),
  35,
)

await measure("single-row write, ack local, WebSocket", ROUNDS, (i) =>
  ask({ op: "query", db: "bench", sql: "insert into t(v, n) values (?, ?)", args: [`s${i}`, i] }),
)

socket.close()

// ── Concurrency ────────────────────────────────────────────────────────────────────────────────

const concurrentStart = Bun.nanoseconds()
await Promise.all(
  Array.from({ length: CONCURRENT }, (_, i) =>
    fetch(`${base}/v1/db/bench/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sql: "select v from t where id = ?", args: [(i % 1000) + 1] }),
    }).then((response) => response.json()),
  ),
)
const concurrentMs = (Bun.nanoseconds() - concurrentStart) / 1e6

// ── Report ─────────────────────────────────────────────────────────────────────────────────────

const stats = (await (await fetch(`${base}/v1/db/bench`, { headers })).json()) as { txid: number }

console.log(
  `bunql http bench · ${ROUNDS} rounds · txid ${stats.txid} · Bun ${Bun.version} · ${process.platform}/${process.arch}\n`,
)
console.log("leg                                       p50 µs    p90 µs    p99 µs   budget")
console.log("-".repeat(80))
for (const leg of legs) {
  const line = [50, 90, 99]
    .map((p) => percentile(leg.samples, p).toFixed(1).padStart(9))
    .join(" ")
  const budget = leg.budgetUs === undefined ? "       —" : `${String(leg.budgetUs).padStart(6)} µs`
  console.log(`${leg.name.padEnd(40)}${line} ${budget}`)
}
console.log(
  `\n${CONCURRENT} concurrent reads in ${concurrentMs.toFixed(0)} ms ` +
    `(${((CONCURRENT / concurrentMs) * 1000).toFixed(0)} req/s)`,
)

await handle.close()
