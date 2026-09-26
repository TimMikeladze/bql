// The load half of `bench/workers.ts`, in its own process so the client does not share the
// server's event loop — the same correction `bench/http.ts` made, and the one that makes a
// throughput number mean anything.
//
//   bun run bench/workers-client.ts --url http://127.0.0.1:PORT --token K --dbs a,b,c
//                                   [--concurrent 64] [--inflight 8] [--seconds 5] [--op read]
//                                   [--transport ws|http]
//
// Writes single rows over WebSocket, spread evenly over the databases named, and prints the rate.
// `--op read` (C4c) does point reads instead, which is what a *replica* is for: a node that follows
// an upstream takes no writes, so its ladder has to be measured on the leg it actually serves.
//
// `--transport http` measures the same load over `POST /v1/db/{db}/query`. The two transports
// answer different questions on a sharded node: a socket frame is relayed by the router, so its
// ceiling is the router's message loop, while an HTTP request is parsed and answered on the worker
// and its ceiling is the work itself.

import { MARKER } from "./report.ts"

function flag(name: string, fallback = ""): string {
  const at = Bun.argv.indexOf(`--${name}`)
  return at >= 0 ? (Bun.argv[at + 1] as string) : fallback
}

const url = flag("url")
const token = flag("token")
const dbs = flag("dbs").split(",").filter((one) => one.length > 0)
const concurrent = Number(flag("concurrent", "64"))
const inflight = Number(flag("inflight", "8"))
const seconds = Number(flag("seconds", "5"))
/** C4c: `read` measures a replica, which is the only leg a follower serves. */
const op = flag("op", "write")
const transport = flag("transport", "ws")
const SQL =
  op === "read"
    ? "select v from t where id = 1"
    : "insert into t(v) values ('x')"

const wsUrl = `${url.replace(/^http/, "ws")}/v1/ws`
let done = 0
let stop = false

async function connection(index: number): Promise<void> {
  const db = dbs[index % dbs.length] as string
  const socket = new WebSocket(wsUrl, "bql.v1")
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error("socket failed"))
  })
  socket.send(JSON.stringify({ op: "hello", id: 0, token }))
  const write = (): void => {
    if (stop) return
    socket.send(JSON.stringify({ op: "query", id: 1, db, sql: SQL }))
  }
  await new Promise<void>((resolve) => {
    let outstanding = inflight
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as { id?: number; event?: string; ok?: boolean }
      if (frame.event === "hello") {
        for (let i = 0; i < inflight; i++) write()
        return
      }
      if (frame.id !== 1) return
      if (frame.ok) done++
      if (stop) {
        if (--outstanding <= 0) resolve()
        return
      }
      write()
    }
    setTimeout(
      () => {
        stop = true
        setTimeout(resolve, 500)
      },
      seconds * 1000 + 50,
    )
  })
  try {
    socket.close()
  } catch {
    // Already gone.
  }
}

/** The same load over HTTP: one request at a time per lane, `concurrent * inflight` lanes. */
async function httpLane(index: number): Promise<void> {
  const db = dbs[index % dbs.length] as string
  const route = `${url}/v1/db/${db}/query`
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
  const body = JSON.stringify({ sql: SQL })
  let first = true
  while (!stop) {
    try {
      const response = await fetch(route, { method: "POST", headers, body })
      await response.arrayBuffer()
      if (response.ok) done++
      first = false
    } catch (err) {
      // A lane that cannot reach the server on its *first* request is a real failure. Later on it
      // is the client running out of ephemeral ports at high lane counts, which is the client's
      // limit rather than the server's, so the lane retires instead of failing the run.
      if (first) throw err
      return
    }
  }
}

const startedNs = Bun.nanoseconds()
setTimeout(() => {
  stop = true
}, seconds * 1000)
await (transport === "http"
  ? Promise.all(Array.from({ length: concurrent * inflight }, (_, i) => httpLane(i)))
  : Promise.all(Array.from({ length: concurrent }, (_, i) => connection(i))))
const elapsed = (Bun.nanoseconds() - startedNs) / 1e9
const rate = Math.round(done / elapsed)
console.log(`${MARKER}${JSON.stringify({ [op === "read" ? "reads" : "writes"]: done, seconds: elapsed, rate })}`)
