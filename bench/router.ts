// Can a benchmark on this machine see a 5% difference in the router's per-request cost?
// (`docs/p6-router-resolution.md`, continuing `docs/p4-router-hop.md` §4.)
//
//   bun run bench/router.ts [--targets control,node] [--rounds 7] [--clients 2] [--seconds 3]
//                           [--workers 4] [--lanes 256]
//
// P4 left two suspects and no instrument fine enough to tell them apart: one load-client process
// tops out near 75 000 requests/s, and the run-to-run spread at one rung was 40%. So this is the
// instrument, and **the first thing it reports is its own resolution** — if it cannot separate a
// target from itself, it cannot separate two targets either, and saying so is the result.
//
// Three things make it finer than `bench/workers.ts`:
//
//  1. **Two or more load-client processes**, summed. §2 of P4 showed one is the ceiling.
//  2. **Interleaved rounds.** Targets run A,B,A,B,… rather than all of A then all of B, so thermal
//     drift and whatever else the machine is doing lands on both.
//  3. **Paired ratios.** Each round yields one B/A ratio; the median of those and their spread is
//     the answer. A difference smaller than the spread of the `control` against itself is not a
//     difference this harness can report.
//
// Targets are servers started by `--targets`; `control*` are `bench/router-control.ts` modes and
// `node*` are real `bunql serve` processes.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseReport } from "./report.ts"

function flag(name: string, fallback: string): string {
  const at = Bun.argv.indexOf(`--${name}`)
  return at >= 0 ? (Bun.argv[at + 1] as string) : fallback
}

const TARGETS = flag("targets", "control,node").split(",").map((one) => one.trim())
const ROUNDS = Number(flag("rounds", "7"))
const CLIENTS = Number(flag("clients", "2"))
const SECONDS = Number(flag("seconds", "3"))
const WORKERS = Number(flag("workers", "4"))
const LANES = Number(flag("lanes", "256"))
const ADMIN = "bench-admin-key"
const DBS = 8
const NAMES = Array.from({ length: DBS }, (_, i) => `bench${i}`)

interface Target {
  name: string
  url: string
  clients: LoadClient[]
  stop: () => Promise<void>
}

/** A long-lived load process: lanes open, sockets warm, waiting to be asked for a window. */
interface LoadClient {
  proc: Bun.Subprocess
  lines: AsyncIterableIterator<string>
  go: (seconds: number) => void
}

const started: Target[] = []
try {
  const seen = new Map<string, number>()
  for (const [at, name] of TARGETS.entries()) {
    const target = await start(name, 4500 + at * 10)
    // The same target twice is the *point* of the first run — "can it tell a thing from itself" —
    // so a repeated name gets a suffix rather than overwriting the first one's samples.
    const count = (seen.get(name) ?? 0) + 1
    seen.set(name, count)
    started.push(count === 1 ? target : { ...target, name: `${name}#${count}` })
  }
  const samples = new Map<string, number[]>()
  for (const target of started) samples.set(target.name, [])

  // A warm-up round nobody records: the first window against a freshly started server includes
  // its JIT and its first allocations, and folding that into round one would bias whichever
  // target happened to go first.
  for (const target of started) await load(target)

  for (let round = 0; round < ROUNDS; round++) {
    // Alternate the order every round. Whichever target goes second inherits the machine the first
    // one left behind — warmer, or with its sockets still settling — and alternating cancels that
    // rather than charging it to one of them.
    const order = round % 2 === 0 ? started : [...started].reverse()
    for (const target of order) {
      const rate = await load(target)
      ;(samples.get(target.name) as number[]).push(rate)
      process.stderr.write(`  round ${round + 1} ${target.name.padEnd(12)} ${rate.toFixed(0)}/s\n`)
    }
  }

  report(samples)
} finally {
  for (const target of started.reverse()) await target.stop()
}

function report(samples: Map<string, number[]>): void {
  console.log(
    `\nbunql router resolution · ${CLIENTS} load processes · ${LANES} lanes each · ${SECONDS}s · ` +
      `${ROUNDS} interleaved rounds · Bun ${Bun.version} · ${process.platform}/${process.arch} · ` +
      `${os.cpus().length} cores\n`,
  )
  console.log(`${"target".padEnd(14)}${"median".padStart(10)}${"min".padStart(10)}${"max".padStart(10)}${"spread".padStart(9)}`)
  console.log("-".repeat(53))
  for (const [name, rates] of samples) {
    const sorted = [...rates].sort((a, b) => a - b)
    const low = sorted[0] as number
    const high = sorted.at(-1) as number
    console.log(
      `${name.padEnd(14)}${median(sorted).toFixed(0).padStart(10)}${low.toFixed(0).padStart(10)}` +
        `${high.toFixed(0).padStart(10)}${`${(((high - low) / median(sorted)) * 100).toFixed(1)}%`.padStart(9)}`,
    )
  }

  const [first, ...rest] = [...samples.keys()]
  if (first === undefined) return
  const base = samples.get(first) as number[]
  for (const name of rest) {
    const other = samples.get(name) as number[]
    // Paired, round by round: the pair shared a moment, so whatever the machine was doing is in
    // both halves of the ratio.
    const ratios = base.map((one, at) => (other[at] as number) / one).sort((a, b) => a - b)
    const lo = ratios[0] as number
    const hi = ratios.at(-1) as number
    console.log(
      `\n${name} / ${first}: median ${median(ratios).toFixed(3)}x, ` +
        `range ${lo.toFixed(3)}–${hi.toFixed(3)} over ${ratios.length} paired rounds`,
    )
    // One round is noisy; the statistic being compared is the *median* of the rounds, so the
    // question is how wide that median's own interval is. Bootstrapped, because the ratios are not
    // normal and there are only a handful of them.
    const q1 = ratios[Math.floor(ratios.length * 0.25)] as number
    const q3 = ratios[Math.floor(ratios.length * 0.75)] as number
    const band = bootstrapMedian(ratios)
    console.log(
      `  per round: middle half ${q1.toFixed(3)}–${q3.toFixed(3)}, full ${lo.toFixed(3)}–${hi.toFixed(3)}`,
    )
    const width = ((band.hi - band.lo) / median(ratios)) * 100
    console.log(
      `  the median's 90% interval is ${band.lo.toFixed(3)}–${band.hi.toFixed(3)} (${width.toFixed(1)}% wide), ` +
        `so this harness resolves a difference of about ${Math.max(1, width).toFixed(0)}% and nothing finer.`,
    )
  }
}

/** A 90% interval for the median, by resampling the rounds with replacement. */
function bootstrapMedian(values: number[], samples = 2000): { lo: number; hi: number } {
  const medians: number[] = []
  for (let i = 0; i < samples; i++) {
    const draw: number[] = []
    for (let j = 0; j < values.length; j++) {
      draw.push(values[Math.floor(Math.random() * values.length)] as number)
    }
    medians.push(median(draw.sort((a, b) => a - b)))
  }
  medians.sort((a, b) => a - b)
  return {
    lo: medians[Math.floor(samples * 0.05)] as number,
    hi: medians[Math.floor(samples * 0.95)] as number,
  }
}

function median(sorted: number[]): number {
  const at = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[at] as number
  return (((sorted[at - 1] as number) + (sorted[at] as number)) / 2)
}

/** One window on every client of a target, summed. The clients are already running. */
async function load(target: Target): Promise<number> {
  for (const client of target.clients) client.go(SECONDS)
  let total = 0
  for (const client of target.clients) {
    const parsed = (await nextReport(client)) as { rate?: number }
    if (typeof parsed.rate !== "number") throw new Error("a load client printed no rate")
    total += parsed.rate
  }
  return total
}

/** The next `MARKER` line a client prints. */
async function nextReport(client: LoadClient): Promise<Record<string, unknown>> {
  for (;;) {
    const next = await client.lines.next()
    if (next.done) throw new Error("a load client exited")
    const parsed = parseReport(next.value) as unknown as Record<string, unknown> | null
    if (parsed) return parsed
  }
}

/** `CLIENTS` load processes against one URL, lanes open and waiting. */
async function startClients(url: string): Promise<LoadClient[]> {
  const clients: LoadClient[] = []
  for (let i = 0; i < CLIENTS; i++) {
    const proc = Bun.spawn(
      [
        process.execPath,
        "run",
        path.join(import.meta.dir, "router-client.ts"),
        "--url",
        url,
        "--token",
        ADMIN,
        "--dbs",
        NAMES.join(","),
        "--lanes",
        String(LANES),
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
    )
    const lines = linesOf(proc.stdout as ReadableStream<Uint8Array>)
    const client: LoadClient = {
      proc,
      lines,
      go: (seconds) => {
        ;(proc.stdin as { write(data: string): void; flush?(): void }).write(`go ${seconds}\n`)
        ;(proc.stdin as { flush?(): void }).flush?.()
      },
    }
    await nextReport(client)
    clients.push(client)
  }
  return clients
}

async function stopClients(clients: LoadClient[]): Promise<void> {
  for (const client of clients) {
    try {
      ;(client.proc.stdin as { write(data: string): void }).write("quit\n")
    } catch {
      // Already gone.
    }
  }
  for (const client of clients) {
    client.proc.kill()
    await client.proc.exited
  }
}

async function* linesOf(stream: ReadableStream<Uint8Array>): AsyncIterableIterator<string> {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    let at = buffer.indexOf("\n")
    while (at >= 0) {
      yield buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      at = buffer.indexOf("\n")
    }
  }
  if (buffer.length > 0) yield buffer
}

async function start(name: string, port: number): Promise<Target> {
  const url = `http://127.0.0.1:${port}`
  if (name.startsWith("control")) {
    const mode = name.includes(":") ? (name.split(":")[1] as string) : "plain"
    const proc = Bun.spawn(
      [process.execPath, "run", path.join(import.meta.dir, "router-control.ts"), "--port", String(port), "--mode", mode],
      { stdout: "ignore", stderr: "inherit" },
    )
    await waitFor(url)
    const clients = await startClients(url)
    return {
      name,
      url,
      clients,
      stop: async () => {
        await stopClients(clients)
        proc.kill()
        await proc.exited
      },
    }
  }

  // `node[@<tree>][:<workers>]` — `@` points at another checkout of this repo, which is how a
  // change is A/B'd against its own parent *inside one run* rather than across two (§5).
  const [kind, workersText] = name.split(":")
  const at = (kind as string).indexOf("@")
  const tree = at >= 0 ? (kind as string).slice(at + 1) : path.join(import.meta.dir, "..")
  const workers = workersText ? Number(workersText) : WORKERS
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bunql-router-${port}-`))
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      path.join(tree, "src", "cli.ts"),
      "serve",
      "--dir",
      root,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--workers",
      String(workers),
    ],
    {
      stdout: "ignore",
      stderr: "inherit",
      env: { ...process.env, BUNQL_AUTH_ADMIN_KEY: ADMIN, BUNQL_CONFIG: "" },
    },
  )
  await waitFor(url)
  for (const db of NAMES) {
    await post(url, "/v1/db", { name: db })
    await post(url, `/v1/db/${db}/query`, { sql: "create table t(id integer primary key, v text)" })
    await post(url, `/v1/db/${db}/query`, { sql: "insert into t(id, v) values (1, 'x')" })
  }
  const clients = await startClients(url)
  return {
    name,
    url,
    clients,
    stop: async () => {
      await stopClients(clients)
      proc.kill()
      await proc.exited
      fs.rmSync(root, { recursive: true, force: true })
    },
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
