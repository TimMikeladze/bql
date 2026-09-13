// What a request costs over the wire, measured from a process that is not the server's.
//
//   bun run bench/http.ts [rounds] [--in-process]
//
// This half starts the server, seeds the database and spawns `bench/http-client.ts` to make every
// request. `docs/m5-server.md` ends by saying its throughput number was capped by the client
// sharing the server's event loop and that a real one needs the client elsewhere; two processes is
// that fix, and where `taskset` exists they are pinned to different CPUs.
//
// `--in-process` runs the load on this event loop instead, which is what design §2.4 and M5
// measured. It is kept so the two shapes can be compared on the same machine.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startServer } from "../src/server/app.ts"
import { loadConfig } from "../src/server/config.ts"
import { distribution, emit, parseReport, type BenchReport, type Sample } from "./report.ts"

const positional = Bun.argv.slice(2).filter((a) => !a.startsWith("--"))
const ROUNDS = Number(positional[0] ?? 2000)
const CONCURRENT = 2000
const IN_PROCESS = Bun.argv.includes("--in-process")

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-http-bench-"))
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }))

// The environment is honoured so that a default can be benchmarked against its alternative
// without editing this file — `BUNQL_DEFAULT_ACK=local bun run bench:http` is how the cost of the
// 2026-09-13 defaults was attributed (`docs/performance.md` §1).
const config = loadConfig({
  env: process.env as Record<string, string | undefined>,
  overrides: { server: { port: 0, host: "127.0.0.1", node: "bench" }, data: { dir: root } },
})
const handle = await startServer(config, { log: () => {} })
const base = `http://127.0.0.1:${handle.server.port}`
const admin = handle.adminKey as string
const headers = { authorization: `Bearer ${admin}`, "content-type": "application/json" }

async function post(route: string, body: unknown): Promise<Response> {
  return fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(body) })
}

await post("/v1/db", { name: "bench" })
await post("/v1/db/bench/query", { sql: "create table t(id integer primary key, v text, n real)" })
await post("/v1/db/bench/query", { sql: "create table live_t(id integer primary key, n integer)" })
for (let i = 0; i < 1000; i += 100) {
  await post("/v1/db/bench/batch", {
    statements: Array.from({ length: 100 }, (_, j) => ({
      sql: "insert into t(v, n) values (?, ?)",
      args: [`row${i + j}`, i + j],
    })),
  })
}

/** `taskset` where it exists, so the two processes do not land on one core. Linux only. */
function pinned(cpu: number, command: string[]): string[] {
  if (process.platform !== "linux") return command
  const which = Bun.spawnSync(["sh", "-c", "command -v taskset"])
  if (!which.success) return command
  return ["taskset", "-c", String(cpu), ...command]
}

let report: BenchReport | null = null

if (IN_PROCESS) {
  report = await runInProcess()
} else {
  const child = Bun.spawn(
    pinned(1, [
      process.execPath,
      "run",
      path.join(import.meta.dir, "http-client.ts"),
      "--url",
      base,
      "--token",
      admin,
      "--rounds",
      String(ROUNDS),
      "--concurrent",
      String(CONCURRENT),
    ]),
    { stdout: "pipe", stderr: "inherit", env: { ...process.env, BUNQL_BENCH_JSON: "1" } },
  )
  const output = await new Response(child.stdout).text()
  const code = await child.exited
  if (code !== 0) throw new Error(`the load client exited ${code}`)
  report = parseReport(output)
  if (!report) throw new Error("the load client printed no ##BENCH## line")
}

// ── report ─────────────────────────────────────────────────────────────────────────────────────

const stats = (await (await fetch(`${base}/v1/db/bench`, { headers })).json()) as { txid: number }

console.log(
  `bunql http bench · ${ROUNDS} rounds · txid ${stats.txid} · Bun ${Bun.version} · ` +
    `${process.platform}/${process.arch} · ${IN_PROCESS ? "client in this process" : "client in its own process"}\n`,
)

if (IN_PROCESS) {
  console.log("leg                                             p50       p90       p99")
  console.log("-".repeat(74))
  for (const [name, sample] of Object.entries(report.legs)) {
    const fmt = (v: number | undefined) =>
      v === undefined ? "        —" : sample.unit === "rps" || sample.unit === "mps" ? v.toFixed(0).padStart(9) : v.toFixed(1).padStart(9)
    console.log(`${name.padEnd(44)}${fmt(sample.p50)} ${fmt(sample.p90)} ${fmt(sample.p99)}`)
  }
}

emit({
  ...report,
  info: { ...report.info, mode: IN_PROCESS ? "one process" : "two processes" },
})

await handle.close()

// ── the single-process path ────────────────────────────────────────────────────────────────────

async function runInProcess(): Promise<BenchReport> {
  const legs: Record<string, Sample> = {}

  async function measure(name: string, rounds: number, fn: (i: number) => Promise<unknown>) {
    for (let i = 0; i < 50; i++) await fn(i)
    const samples: number[] = new Array(rounds)
    for (let i = 0; i < rounds; i++) {
      const started = Bun.nanoseconds()
      await fn(i)
      samples[i] = (Bun.nanoseconds() - started) / 1000
    }
    legs[name] = distribution(samples)
  }

  await measure("point read, HTTP keep-alive", ROUNDS, async (i) => {
    const response = await post("/v1/db/bench/query", {
      sql: "select v, n from t where id = ?",
      args: [(i % 1000) + 1],
    })
    await response.json()
  })
  await measure("single-row write, ack local, HTTP", ROUNDS, async (i) => {
    const response = await post("/v1/db/bench/query", {
      sql: "insert into t(v, n) values (?, ?)",
      args: [`w${i}`, i],
    })
    await response.json()
  })
  await measure("healthz, HTTP", ROUNDS, async () => {
    await (await fetch(`${base}/healthz`)).json()
  })

  const socket = new WebSocket(
    `ws://127.0.0.1:${handle.server.port}/v1/ws?token=${encodeURIComponent(admin)}`,
    "bunql.v1",
  )
  const waiters = new Map<number, (value: unknown) => void>()
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
    waiter(message)
  })
  let nextId = 1
  const ask = (frame: Record<string, unknown>): Promise<unknown> => {
    const id = nextId++
    socket.send(JSON.stringify({ ...frame, id }))
    return new Promise((resolve) => waiters.set(id, resolve))
  }

  await measure("point read, WebSocket", ROUNDS, (i) =>
    ask({ op: "query", db: "bench", sql: "select v, n from t where id = ?", args: [(i % 1000) + 1] }),
  )
  await measure("single-row write, ack local, WebSocket", ROUNDS, (i) =>
    ask({ op: "query", db: "bench", sql: "insert into t(v, n) values (?, ?)", args: [`s${i}`, i] }),
  )
  socket.close()

  const started = Bun.nanoseconds()
  await Promise.all(
    Array.from({ length: CONCURRENT }, (_, i) =>
      post("/v1/db/bench/query", {
        sql: "select v from t where id = ?",
        args: [(i % 1000) + 1],
      }).then((response) => response.json()),
    ),
  )
  const rps = CONCURRENT / ((Bun.nanoseconds() - started) / 1e9)
  legs["throughput, mixed 90/10, HTTP"] = { p50: rps, value: rps, unit: "rps" }

  return { bench: "http", info: { rounds: ROUNDS, concurrent: CONCURRENT }, legs }
}
