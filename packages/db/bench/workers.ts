// What `[server] workers` is worth (`docs/c4-workers.md`, phase-2 milestone 4).
//
//   bun run bench/workers.ts [--workers 1,2,4] [--dbs 8] [--concurrent 64] [--seconds 5]
//                            [--replication] [--follow] [--cluster] [--transport ws|http]
//
// `--replication` (C4b) attaches a real replica to every node on the ladder before the load starts,
// so the figure is what a node does while it is also serving its replicas — each commit crossing
// the worker channel as one frame on its way to the socket the router holds.
//
// `--cluster` (C4d) makes each rung a one-node Raft cluster, so every write on it consults a real
// lease on the worker that took it. The claim is that it costs a `Map.get` and a `performance.now()`
// — the same as on one thread — so this ladder should land on the plain one.
//
// `--follow` (C4c) turns the ladder round: each rung is a *replica* of one single-threaded primary,
// and the load is **reads**, because a node that follows an upstream takes no writes. This is the
// lever C4c exists for — a replica was stuck on one thread while the rest of the machine idled.
//
// The shape is exactly the one `docs/performance.md` §5 measured across processes: N databases,
// single-row writes, many concurrent clients. There it was one process against four; here it is
// one process with one worker against the same process with N, over one port.
//
// The server runs in its own process and so does the load client, because a client that shares the
// server's event loop measures the loop rather than the server — the correction `bench/http.ts`
// already carries.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { emit, parseReport, type Sample } from "./report.ts"

function flag(name: string, fallback: string): string {
  const at = Bun.argv.indexOf(`--${name}`)
  return at >= 0 ? (Bun.argv[at + 1] as string) : fallback
}

const LADDER = flag("workers", "1,2,4")
  .split(",")
  .map((one) => Number(one.trim()))
  .filter((one) => Number.isFinite(one) && one >= 1)
const DBS = Number(flag("dbs", "8"))
const CONCURRENT = Number(flag("concurrent", "64"))
const SECONDS = Number(flag("seconds", "5"))
/** C4b: run the ladder with a real replica attached to each node. */
const REPLICATION = Bun.argv.includes("--replication")
/** C4c: make each rung a replica of one primary, and measure reads. */
const FOLLOW = Bun.argv.includes("--follow")
/** C4d: make each rung a one-node cluster, so the write path consults a lease on a worker. */
const CLUSTER = Bun.argv.includes("--cluster")
/** Which surface the load uses. See `bench/workers-client.ts` for why it changes the answer. */
const TRANSPORT = flag("transport", "ws")
const SECRET = "bench-cluster-secret-0123456789"
const ADMIN = "bench-admin-key"
const NAMES = Array.from({ length: DBS }, (_, i) => `bench${i}`)

const results: { workers: number; rate: number }[] = []

/** `--follow`: one single-threaded primary, seeded once, that every rung of the ladder follows. */
const upstream = FOLLOW ? await startUpstream() : null
try {
  for (const workers of LADDER) {
    results.push({ workers, rate: await run(workers) })
  }
} finally {
  if (upstream) {
    upstream.server.kill()
    await upstream.server.exited
    fs.rmSync(upstream.root, { recursive: true, force: true })
  }
}

const base = results[0]?.rate ?? 0
console.log(
  `bunql workers bench · ${DBS} databases · ${CONCURRENT} sockets · ${SECONDS}s · ` +
    `${FOLLOW ? "replica reads · " : REPLICATION ? "one replica attached · " : "no replication · "}` +
    `over ${TRANSPORT === "http" ? "HTTP" : "one socket"} · ` +
    `Bun ${Bun.version} · ${process.platform}/${process.arch} · ${os.cpus().length} cores\n`,
)
console.log(`workers    ${FOLLOW ? " reads/s" : "writes/s"}    speedup`)
console.log("-".repeat(31))
for (const { workers, rate } of results) {
  console.log(
    `${String(workers).padStart(7)}  ${rate.toFixed(0).padStart(10)}  ${(base ? rate / base : 1).toFixed(2).padStart(9)}x`,
  )
}

const legs: Record<string, Sample> = {}
for (const { workers, rate } of results) {
  legs[
    `${FOLLOW ? "replica point reads" : "single-row writes"} over ${TRANSPORT}, ` +
      `${workers} worker${workers === 1 ? "" : "s"}`
  ] = {
    p50: rate,
    p90: rate,
    p99: rate,
    unit: "rps",
  }
}
emit({
  bench: "workers",
  info: { databases: String(DBS), sockets: String(CONCURRENT), seconds: String(SECONDS) },
  legs,
})

/**
 * `--follow`: one single-threaded primary that every rung follows, seeded with the benchmark's
 * databases and one row each, because a point read wants a row to find.
 */
async function startUpstream(): Promise<{ server: Bun.Subprocess; root: string; url: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bunql-workers-upstream-"))
  const port = 4399
  const server = Bun.spawn(
    [
      process.execPath,
      "run",
      path.join(import.meta.dir, "..", "src", "cli.ts"),
      "serve",
      "--dir",
      root,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--cluster-secret",
      SECRET,
    ],
    {
      stdout: "ignore",
      stderr: "inherit",
      env: { ...process.env, BUNQL_AUTH_ADMIN_KEY: ADMIN, BUNQL_CONFIG: "" },
    },
  )
  const url = `http://127.0.0.1:${port}`
  await waitFor(url)
  for (const name of NAMES) {
    await post(url, "/v1/db", { name })
    await post(url, `/v1/db/${name}/query`, {
      sql: "create table t(id integer primary key, v text)",
    })
    await post(url, `/v1/db/${name}/query`, { sql: "insert into t(v) values ('seed')" })
  }
  return { server, root, url }
}

/** Starts a node with `workers` threads, seeds it, runs the load client, returns writes/s. */
async function run(workers: number): Promise<number> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bunql-workers-${workers}-`))
  const port = 4400 + workers
  const server = Bun.spawn(
    [
      process.execPath,
      "run",
      path.join(import.meta.dir, "..", "src", "cli.ts"),
      "serve",
      "--dir",
      root,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--workers",
      String(workers),
      ...(REPLICATION || FOLLOW || CLUSTER ? ["--cluster-secret", SECRET] : []),
      // C4c: this rung *is* the replica, and the load below reads from it.
      ...(FOLLOW && upstream ? ["--replica-of", `ws://127.0.0.1:4399/v1/replication`] : []),
    ],
    {
      stdout: "ignore",
      stderr: "inherit",
      env: {
        ...process.env,
        BUNQL_AUTH_ADMIN_KEY: ADMIN,
        BUNQL_CONFIG: "",
        // A cluster of one: it is its own raft leader, so every write goes through a lease this
        // node granted itself and renews on the router, and reads on a worker.
        ...(CLUSTER
          ? {
              BUNQL_CLUSTER_ENABLED: "1",
              BUNQL_CLUSTER_BOOTSTRAP: "1",
              BUNQL_CLUSTER_ADVERTISE: `ws://127.0.0.1:${port}`,
            }
          : {}),
      },
    },
  )
  let replica: Bun.Subprocess | null = null
  let replicaRoot: string | null = null
  try {
    const url = `http://127.0.0.1:${port}`
    await waitFor(url)
    if (FOLLOW) {
      // Every database bootstrapped before the load starts, so the figure measures reads against a
      // settled replica rather than reads racing a snapshot.
      await untilFollowing(url)
    } else {
      for (const name of NAMES) {
        await post(url, "/v1/db", { name })
        await post(url, `/v1/db/${name}/query`, {
          sql: "create table t(id integer primary key, v text)",
        })
      }
    }
    if (REPLICATION) {
      replicaRoot = fs.mkdtempSync(path.join(os.tmpdir(), `bunql-workers-${workers}-replica-`))
      const replicaPort = port + 100
      replica = Bun.spawn(
        [
          process.execPath,
          "run",
          path.join(import.meta.dir, "..", "src", "cli.ts"),
          "serve",
          "--dir",
          replicaRoot,
          "--port",
          String(replicaPort),
          "--host",
          "127.0.0.1",
          "--cluster-secret",
          SECRET,
          "--replica-of",
          `ws://127.0.0.1:${port}/v1/replication`,
        ],
        {
          stdout: "ignore",
          stderr: "inherit",
          env: { ...process.env, BUNQL_AUTH_ADMIN_KEY: ADMIN, BUNQL_CONFIG: "" },
        },
      )
      const replicaUrl = `http://127.0.0.1:${replicaPort}`
      await waitFor(replicaUrl)
      // Every database bootstrapped before the load starts, so the figure measures streaming
      // rather than a snapshot racing the first write.
      await untilFollowing(replicaUrl)
    }
    const client = Bun.spawn(
      [
        process.execPath,
        "run",
        path.join(import.meta.dir, "workers-client.ts"),
        "--url",
        url,
        "--token",
        ADMIN,
        "--dbs",
        NAMES.join(","),
        "--concurrent",
        String(CONCURRENT),
        "--seconds",
        String(SECONDS),
        ...(FOLLOW ? ["--op", "read"] : []),
        "--transport",
        TRANSPORT,
      ],
      { stdout: "pipe", stderr: "inherit" },
    )
    const output = await new Response(client.stdout).text()
    if ((await client.exited) !== 0) throw new Error("the load client failed")
    const report = parseReport(output) as unknown as { rate?: number } | null
    if (!report || typeof report.rate !== "number") throw new Error("the load client printed no rate")
    return report.rate
  } finally {
    if (replica) {
      replica.kill()
      await replica.exited
    }
    server.kill()
    await server.exited
    fs.rmSync(root, { recursive: true, force: true })
    if (replicaRoot) fs.rmSync(replicaRoot, { recursive: true, force: true })
  }
}

/** Waits until the replica holds every one of the benchmark's databases. */
async function untilFollowing(replicaUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const response = await fetch(`${replicaUrl}/v1/db`, {
      headers: { authorization: `Bearer ${ADMIN}` },
    })
    const body = (await response.json()) as { databases?: { name: string }[] }
    const held = new Set((body.databases ?? []).map((one) => one.name))
    if (NAMES.every((name) => held.has(name))) return
    if (Date.now() > deadline) throw new Error("the replica never picked up every database")
    await Bun.sleep(50)
  }
}

async function post(url: string, route: string, body: unknown): Promise<void> {
  const response = await fetch(`${url}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!response.ok && response.status !== 409) {
    throw new Error(`${route}: ${response.status} ${await response.text()}`)
  }
  await response.arrayBuffer()
}

async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      const response = await fetch(`${url}/healthz`)
      if (response.ok) {
        await response.arrayBuffer()
        return
      }
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(50)
  }
  throw new Error(`${url} never became ready`)
}
