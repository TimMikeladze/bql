// The load half of `bench/http.ts`: every request in this file is made by a process that is not
// the server's, which is the whole point of splitting them. `docs/m5-server.md` ends by saying its
// throughput figure was capped by the client sharing the server's event loop; this is the fix.
//
//   bun run bench/http-client.ts --url http://127.0.0.1:1234 --token KEY [--rounds 2000]
//
// Prints the human summary on stderr and one `##BENCH##` line on stdout, so the parent can read
// the numbers without parsing a table.

import { distribution, emit, type Sample } from "./report.ts"

function flag(name: string, fallback?: string): string {
  const at = Bun.argv.indexOf(`--${name}`)
  if (at >= 0 && Bun.argv[at + 1]) return Bun.argv[at + 1] as string
  const inline = Bun.argv.find((a) => a.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  if (fallback !== undefined) return fallback
  throw new Error(`bench/http-client.ts needs --${name}`)
}

const base = flag("url")
const token = flag("token")
const ROUNDS = Number(flag("rounds", "2000"))
const CONCURRENT = Number(flag("concurrent", "2000"))
const db = flag("db", "bench")

const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }

async function post(route: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${base}${route}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  return response.json()
}

const legs: { name: string; sample: Sample; budgetUs?: number }[] = []

async function measure(
  name: string,
  rounds: number,
  fn: (i: number) => Promise<unknown>,
  budgetUs?: number,
): Promise<void> {
  // Warm the connection, the prepared-statement cache and the server's policy memo.
  for (let i = 0; i < 50; i++) await fn(i)
  const samples: number[] = new Array(rounds)
  for (let i = 0; i < rounds; i++) {
    const started = Bun.nanoseconds()
    await fn(i)
    samples[i] = (Bun.nanoseconds() - started) / 1000
  }
  legs.push({ name, sample: distribution(samples), ...(budgetUs !== undefined ? { budgetUs } : {}) })
}

// ── HTTP latency ───────────────────────────────────────────────────────────────────────────────
//
// **Warm the client before the first leg, not inside it.** `measure`'s own 50 iterations warm the
// *server* — its prepared-statement cache, its policy memo — but not this process: Bun's `fetch`,
// the JSON codec and the keep-alive socket are cold on the first leg and warm for every leg after
// it. Measured: the identical point read is 94.8 µs as the first leg and 56.6 µs as the fourth,
// which is 40 µs of warm-up being attributed to HTTP. That artefact is the whole of the difference
// between the 48.2 µs this file once reported and the 87 µs it reported later, and it is why the
// budget row for HTTP kept moving. `docs/performance.md` §2.
for (let i = 0; i < 2000; i++) {
  await post(`/v1/db/${db}/query`, { sql: "select v, n from t where id = ?", args: [(i % 1000) + 1] })
}

await measure(
  "point read, HTTP keep-alive",
  ROUNDS,
  (i) => post(`/v1/db/${db}/query`, { sql: "select v, n from t where id = ?", args: [(i % 1000) + 1] }),
  60,
)

await measure("single-row write, ack local, HTTP", ROUNDS, (i) =>
  post(`/v1/db/${db}/query`, { sql: "insert into t(v, n) values (?, ?)", args: [`h${i}`, i] }),
)

// The cost this benchmark was not paying. `--token` is the **admin key**, a constant-time compare;
// every deployed client sends a signed token instead, which is a key-ring lookup and, on a miss,
// an EdDSA verification. The verification is cached per token, so the gap should be small — this
// leg is here so that it is measured rather than assumed (`docs/performance.md` §2).
const minted = (await post("/v1/tokens", { dbs: [db], scope: "rw" })) as { token?: string }
if (minted.token) {
  const scoped = { authorization: `Bearer ${minted.token}`, "content-type": "application/json" }
  await measure("point read, HTTP keep-alive, minted token", ROUNDS, (i) =>
    fetch(`${base}/v1/db/${db}/query`, {
      method: "POST",
      headers: scoped,
      body: JSON.stringify({ sql: "select v, n from t where id = ?", args: [(i % 1000) + 1] }),
    }).then((r) => r.json()),
  )
}

await measure("healthz, HTTP", ROUNDS, () => fetch(`${base}/healthz`).then((r) => r.json()))

// ── the same two statements through Hrana ──────────────────────────────────────────────────────
//
// One `POST /v2/pipeline` carrying `execute` and `close`, which is one round trip for one
// statement — the same unit of work as the native legs above, so the gap between them is what the
// compatibility layer costs. A stream is opened and closed per request here; `@libsql/client`
// keeps a baton alive instead, which saves the close but not the encoding.

const HRANA = `/v1/db/${db}/v2/pipeline`

async function pipeline(sql: string, args: unknown[]): Promise<unknown> {
  const body = await post(HRANA, {
    baton: null,
    requests: [{ type: "execute", stmt: { sql, args } }, { type: "close" }],
  })
  const first = (body as { results?: { type: string; error?: { message: string } }[] }).results?.[0]
  if (!first || first.type !== "ok") {
    throw new Error(`hrana pipeline failed: ${JSON.stringify(first)}`)
  }
  return body
}

const hranaInt = (value: number) => ({ type: "integer", value: String(value) })
const hranaText = (value: string) => ({ type: "text", value })

await measure("point read, Hrana pipeline", ROUNDS, (i) =>
  pipeline("select v, n from t where id = ?", [hranaInt((i % 1000) + 1)]),
)

await measure("single-row write, ack local, Hrana pipeline", ROUNDS, (i) =>
  pipeline("insert into t(v, n) values (?, ?)", [hranaText(`p${i}`), hranaInt(i)]),
)

// ── WebSocket ──────────────────────────────────────────────────────────────────────────────────

interface Conn {
  socket: WebSocket
  ask(frame: Record<string, unknown>): Promise<unknown>
  /** Sends without waiting; the reply resolves through `ask`'s table all the same. */
  close(): void
}

async function connect(onPush?: (message: Record<string, unknown>) => void): Promise<Conn> {
  const socket = new WebSocket(
    `${base.replace(/^http/, "ws")}/v1/ws?token=${encodeURIComponent(token)}`,
    "bunql.v1",
  )
  const waiters = new Map<number, (value: unknown) => void>()
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("socket failed")), { once: true })
  })
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number }
    if (typeof message.id === "number") {
      const waiter = waiters.get(message.id)
      if (waiter) {
        waiters.delete(message.id)
        waiter(message)
      }
      return
    }
    onPush?.(message as Record<string, unknown>)
  })
  let nextId = 1
  return {
    socket,
    ask(frame) {
      const id = nextId++
      socket.send(JSON.stringify({ ...frame, id }))
      return new Promise((resolve) => waiters.set(id, resolve))
    },
    close() {
      socket.close()
    },
  }
}

const conn = await connect()

await measure(
  "point read, WebSocket",
  ROUNDS,
  (i) =>
    conn.ask({ op: "query", db, sql: "select v, n from t where id = ?", args: [(i % 1000) + 1] }),
  35,
)

await measure("single-row write, ack local, WebSocket", ROUNDS, (i) =>
  conn.ask({ op: "query", db, sql: "insert into t(v, n) values (?, ?)", args: [`s${i}`, i] }),
)

const wsWriteP50 = legs.find((l) => l.name === "single-row write, ack local, WebSocket")?.sample.p50 ?? 0

// ── live query: a commit on one socket, the event on another ───────────────────────────────────
//
// Design §10 budgets "live-query invalidation → event on socket" at 200 µs p50. What can actually
// be timed from out here is the whole round trip — the write leaves this process, commits, and the
// event comes back on the other socket — so the invalidation leg is that minus a bare write of the
// same shape over the same transport, measured above.

let liveResolve: (() => void) | null = null
const watcher = await connect((message) => {
  if (message.event === "rows" || message.event === "diff") {
    const resolve = liveResolve
    liveResolve = null
    resolve?.()
  }
})
await watcher.ask({
  op: "subscribe",
  db,
  kind: "live",
  sql: "select id, n from live_t order by id desc limit 5",
  key: "id",
})
// The first result arrives from inside `subscribe`; wait it out before timing anything.
await new Promise((resolve) => setTimeout(resolve, 50))

const liveSamples: number[] = []
for (let i = 0; i < Math.min(ROUNDS, 500) + 20; i++) {
  const arrived = new Promise<void>((resolve) => {
    liveResolve = resolve
  })
  const started = Bun.nanoseconds()
  conn.ask({ op: "query", db, sql: "insert into live_t(n) values (?)", args: [i] })
  await arrived
  if (i >= 20) liveSamples.push((Bun.nanoseconds() - started) / 1000)
}
watcher.close()

const liveTotal = distribution(liveSamples)
legs.push({ name: "write → live event on another socket", sample: liveTotal })
legs.push({
  name: "live-query invalidation → event on socket",
  sample: {
    p50: Math.max(0, liveTotal.p50 - wsWriteP50),
    p90: Math.max(0, (liveTotal.p90 ?? 0) - wsWriteP50),
    unit: "us",
  },
  budgetUs: 200,
})

// ── throughput ─────────────────────────────────────────────────────────────────────────────────
//
// Design §10: ≥ 50k req/s HTTP and ≥ 150k msg/s WS on one core, mixed 90 % reads / 10 % writes.

async function httpThroughput(total: number): Promise<number> {
  const started = Bun.nanoseconds()
  await Promise.all(
    Array.from({ length: total }, (_, i) =>
      i % 10 === 9
        ? post(`/v1/db/${db}/query`, { sql: "insert into t(v, n) values (?, ?)", args: [`c${i}`, i] })
        : post(`/v1/db/${db}/query`, {
            sql: "select v from t where id = ?",
            args: [(i % 1000) + 1],
          }),
    ),
  )
  return total / ((Bun.nanoseconds() - started) / 1e9)
}

const httpRps = await httpThroughput(CONCURRENT)

async function wsThroughput(total: number): Promise<number> {
  const started = Bun.nanoseconds()
  const inflight: Promise<unknown>[] = new Array(total)
  for (let i = 0; i < total; i++) {
    inflight[i] =
      i % 10 === 9
        ? conn.ask({ op: "query", db, sql: "insert into t(v, n) values (?, ?)", args: [`m${i}`, i] })
        : conn.ask({ op: "query", db, sql: "select v from t where id = ?", args: [(i % 1000) + 1] })
  }
  await Promise.all(inflight)
  return total / ((Bun.nanoseconds() - started) / 1e9)
}

const wsMps = await wsThroughput(CONCURRENT)
conn.close()

legs.push({
  name: "throughput, mixed 90/10, HTTP",
  sample: { p50: httpRps, value: httpRps, unit: "rps" },
})
legs.push({
  name: "throughput, mixed 90/10, WebSocket",
  sample: { p50: wsMps, value: wsMps, unit: "mps" },
})

// ── report ─────────────────────────────────────────────────────────────────────────────────────

const lines = ["leg                                             p50       p90       p99   budget"]
lines.push("-".repeat(80))
for (const leg of legs) {
  const unit = leg.sample.unit
  const fmt = (v: number | undefined) =>
    v === undefined ? "        —" : unit === "rps" || unit === "mps" ? v.toFixed(0).padStart(9) : v.toFixed(1).padStart(9)
  const budget = leg.budgetUs === undefined ? "       —" : `${String(leg.budgetUs).padStart(6)} µs`
  lines.push(
    `${leg.name.padEnd(44)}${fmt(leg.sample.p50)} ${fmt(leg.sample.p90)} ${fmt(leg.sample.p99)} ${budget}`,
  )
}
console.error(lines.join("\n"))

emit(
  {
    bench: "http",
    info: {
      rounds: ROUNDS,
      concurrent: CONCURRENT,
      mode: "two processes",
      bun: Bun.version,
    },
    legs: Object.fromEntries(legs.map((leg) => [leg.name, leg.sample])),
  },
  // The parent always wants the line; it spawned this process to get it.
  { BUNQL_BENCH_JSON: "1" },
)
