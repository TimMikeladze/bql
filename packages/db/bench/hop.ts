// What the router's worker channel costs, isolated from SQLite, from HTTP and from the network
// (`docs/p4-router-hop.md`).
//
//   bun run bench/hop.ts [--workers 1,2,4,6] [--concurrent 64] [--seconds 3] [--shape http|empty]
//                        [--batch]
//
// Why this exists: `bench/workers.ts --follow --transport http` says a sharded node's HTTP reads
// stop scaling past two workers, and its run-to-run variance is wide enough (34k to 58k reads/s at
// the same rung) that it cannot say *why*. This measures the one thing underneath it — a round
// trip across the `postMessage` channel — where the numbers are stable to a few percent.
//
// `--shape http` sends a message the size and shape of a real hop: the method, the URL, four
// headers and a 200-byte body back. `--shape empty` sends `{ id }` and gets `{ id }` back, which
// separates what the payload costs from what the channel costs.
//
// `--batch` collects everything produced in one tick and posts it as a single message, in both
// directions. It is the obvious fix for a per-message cost and it is in here because measuring it
// is how we know the cost is not per message.

function flag(name: string, fallback: string): string {
  const at = Bun.argv.indexOf(`--${name}`)
  return at >= 0 ? (Bun.argv[at + 1] as string) : fallback
}

const LADDER = flag("workers", "1,2,4,6")
  .split(",")
  .map((one) => Number(one.trim()))
  .filter((one) => Number.isFinite(one) && one >= 1)
const CONCURRENT = Number(flag("concurrent", "64"))
const SECONDS = Number(flag("seconds", "3"))
const SHAPE = flag("shape", "http") === "empty" ? "empty" : "http"
const BATCH = Bun.argv.includes("--batch")

const HEADERS: [string, string][] = [
  ["host", "127.0.0.1:4400"],
  ["authorization", "Bearer bench-admin-key"],
  ["content-type", "application/json"],
  ["accept", "*/*"],
]

interface Hop {
  id: number
  method?: string
  url?: string
  headers?: [string, string][]
  body?: Uint8Array | null
}

async function run(workers: number): Promise<number> {
  const pool: Worker[] = []
  const pending = new Map<number, () => void>()
  const outbox: Hop[][] = []
  let scheduled = false
  let seq = 0

  const settle = (message: { id?: number; items?: Hop[] }): void => {
    if (message.items) {
      for (const one of message.items) pending.get(one.id)?.(), pending.delete(one.id)
      return
    }
    const id = message.id as number
    const waiting = pending.get(id)
    if (waiting) {
      pending.delete(id)
      waiting()
    }
  }

  const flush = (): void => {
    scheduled = false
    for (let i = 0; i < pool.length; i++) {
      const box = outbox[i] as Hop[]
      if (box.length === 0) continue
      const out = box.splice(0, box.length)
      const worker = pool[i] as Worker
      worker.postMessage(out.length === 1 ? out[0] : { items: out })
    }
  }

  const url = new URL(`./hop-worker.ts?shape=${SHAPE}`, import.meta.url).href
  for (let i = 0; i < workers; i++) {
    const worker = new Worker(url)
    worker.onmessage = (event: MessageEvent) => settle(event.data as { id?: number; items?: Hop[] })
    pool.push(worker)
    outbox.push([])
  }
  // Let every thread finish starting, so the first second is not measuring `new Worker`.
  await new Promise((resolve) => setTimeout(resolve, 300))

  let done = 0
  const deadline = Date.now() + SECONDS * 1000
  const client = async (): Promise<void> => {
    while (Date.now() < deadline) {
      const id = seq++
      const slot = id % pool.length
      const hop: Hop =
        SHAPE === "empty"
          ? { id }
          : { id, method: "POST", url: "http://127.0.0.1:4400/v1/db/bench0/query", headers: HEADERS, body: null }
      await new Promise<void>((resolve) => {
        pending.set(id, resolve)
        if (BATCH) {
          ;(outbox[slot] as Hop[]).push(hop)
          if (!scheduled) {
            scheduled = true
            queueMicrotask(flush)
          }
        } else {
          ;(pool[slot] as Worker).postMessage(hop)
        }
      })
      done++
    }
  }

  const startedAt = Date.now()
  await Promise.all(Array.from({ length: CONCURRENT }, () => client()))
  const rate = Math.round(done / ((Date.now() - startedAt) / 1000))
  for (const worker of pool) worker.terminate()
  return rate
}

console.log(
  `bunql hop bench · ${SHAPE} messages · ${CONCURRENT} in flight · ${SECONDS}s` +
    `${BATCH ? " · batched per tick" : ""} · Bun ${Bun.version} · ${process.platform}/${process.arch}`,
)
console.log("")
console.log("workers   round trips/s   per worker")
console.log("------------------------------------")
for (const workers of LADDER) {
  const rate = await run(workers)
  console.log(
    `${String(workers).padStart(7)}${String(rate).padStart(16)}${String(Math.round(rate / workers)).padStart(13)}`,
  )
}
