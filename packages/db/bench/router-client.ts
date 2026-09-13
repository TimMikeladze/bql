// The load half of `bench/router.ts`, in its own process because one process is the ceiling
// (`docs/p4-router-hop.md` §2), and **long-lived** because process churn was the noise
// (`docs/p6-router-resolution.md` §2).
//
//   bun run bench/router-client.ts --url http://127.0.0.1:PORT --token K --dbs a,b,c
//                                  [--lanes 64]
//
// It opens its lanes once and then waits on stdin. `go <seconds>` measures a window and prints one
// report line; `quit` ends it. Between windows the lanes keep running against the same server, so
// the sockets stay warm and nothing is ever in TIME_WAIT when a window starts — which is what the
// first version of this file got wrong, and it cost it a factor of three between the first round
// and the ninth.
//
// One request at a time per lane, `POST /v1/db/{db}/query` with a point read. Deliberately the same
// request against the control and against a real node, so the only difference between two windows
// is the server.

import { MARKER } from "./report.ts"

function flag(name: string, fallback = ""): string {
  const at = Bun.argv.indexOf(`--${name}`)
  return at >= 0 ? (Bun.argv[at + 1] as string) : fallback
}

const url = flag("url")
const token = flag("token")
const dbs = flag("dbs").split(",").filter((one) => one.length > 0)
const lanes = Number(flag("lanes", "64"))

const BODY = JSON.stringify({ sql: "select v from t where id = 1" })
const HEADERS = { authorization: `Bearer ${token}`, "content-type": "application/json" }

let done = 0
let failures = 0
let running = true
/** Lanes only issue requests inside a window, so an idle target is genuinely idle. */
let active = false

async function lane(index: number): Promise<void> {
  const db = dbs[index % dbs.length] as string
  const route = `${url}/v1/db/${db}/query`
  while (running) {
    if (!active) {
      await Bun.sleep(2)
      continue
    }
    try {
      const response = await fetch(route, { method: "POST", headers: HEADERS, body: BODY })
      await response.arrayBuffer()
      if (response.ok) done++
      else failures++
    } catch {
      failures++
      // Back off rather than spin: a hot retry loop would make the client the thing measured.
      await Bun.sleep(5)
    }
  }
}

const workers = Array.from({ length: lanes }, (_, i) => lane(i))

/** One measurement window: zero the counters, wait, print what happened in between. */
async function window(seconds: number): Promise<void> {
  // A tenth of a second of load before the counters are zeroed: the lanes have to be in flight
  // when the clock starts, or the window pays for their ramp.
  active = true
  await Bun.sleep(100)
  done = 0
  failures = 0
  const startedNs = Bun.nanoseconds()
  await Bun.sleep(seconds * 1000)
  const elapsed = (Bun.nanoseconds() - startedNs) / 1e9
  active = false
  const completed = done
  const failed = failures
  console.log(
    `${MARKER}${JSON.stringify({ done: completed, failures: failed, seconds: elapsed, rate: completed / elapsed })}`,
  )
  if (failed > completed / 100) {
    console.error(`router-client: ${failed} failures against ${completed} successes — window suspect`)
  }
}

// One short burst so every lane has an open connection before the first window is asked for.
active = true
await Bun.sleep(250)
active = false
console.log(`${MARKER}${JSON.stringify({ ready: true })}`)

for await (const line of console) {
  const text = line.trim()
  if (text === "quit") break
  if (text.startsWith("go")) {
    await window(Number(text.slice(2).trim() || "3"))
  }
}
running = false
await Promise.all(workers)
