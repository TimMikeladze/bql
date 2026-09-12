// The load half of `bench/workers.ts`, in its own process so the client does not share the
// server's event loop — the same correction `bench/http.ts` made, and the one that makes a
// throughput number mean anything.
//
//   bun run bench/workers-client.ts --url http://127.0.0.1:PORT --token K --dbs a,b,c
//                                   [--concurrent 64] [--inflight 8] [--seconds 5]
//
// Writes single rows over WebSocket, spread evenly over the databases named, and prints the rate.

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

const wsUrl = `${url.replace(/^http/, "ws")}/v1/ws`
let written = 0
let stop = false

async function connection(index: number): Promise<void> {
  const db = dbs[index % dbs.length] as string
  const socket = new WebSocket(wsUrl, "bunql.v1")
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error("socket failed"))
  })
  socket.send(JSON.stringify({ op: "hello", id: 0, token }))
  const write = (): void => {
    if (stop) return
    socket.send(JSON.stringify({ op: "query", id: 1, db, sql: "insert into t(v) values ('x')" }))
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
      if (frame.ok) written++
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

const startedNs = Bun.nanoseconds()
setTimeout(() => {
  stop = true
}, seconds * 1000)
await Promise.all(Array.from({ length: concurrent }, (_, i) => connection(i)))
const elapsed = (Bun.nanoseconds() - startedNs) / 1e9
const rate = Math.round(written / elapsed)
console.log(`${MARKER}${JSON.stringify({ writes: written, seconds: elapsed, rate })}`)
