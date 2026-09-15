// Runs every benchmark and prints two tables: the performance budget of design §10, and the
// phase-1 legs that budget never named.
//
//   bun run bench                 # everything
//   bun run bench --quick         # fewer rounds, for a laptop on battery
//   bun run bench --only http     # driver | wal | tenant | http | replication | storage | fsync
//
// `bench/workers.ts` and `bench/profile.ts` are deliberately not in this set: both measure a
// configuration the node does not run by default (`[server] workers`, and attribution for
// `docs/performance.md`), and both spawn whole servers. `bun run bench:workers`.
//   bun run bench --json          # every report as JSON, for docs/benchmarks.md
//
// Each benchmark runs as its own process: `bench/driver.ts` loads bun:sqlite, `bench/http.ts`
// binds a port and spawns a load client of its own, and six benchmarks sharing one heap would
// measure a JIT that six separate runs do not share. Every child prints its usual human table
// plus one `##BENCH##` line, which is the only thing read back.
//
// This never fails a build. A benchmark is a measurement of the machine it ran on, so a missed
// budget is a WARN and the exit code stays 0 — the one hard gate is `bench/driver.ts`'s own
// point-read target, which it enforces itself.
//
// Two tables come out: design §10's budget, which is the contract, and the phase-1 legs, which
// design §10 never budgeted — routing, durability levels, the Hrana surface and the S3 shipper.
// Those are printed with the number they should be read against rather than a verdict, because a
// forwarded write is not slow or fast on its own, only next to the local one.

import os from "node:os"
import path from "node:path"
import { sqlite } from "../src/sqlite/index.ts"
import { parseReport, type BenchReport } from "./report.ts"

const QUICK = Bun.argv.includes("--quick")
const JSON_OUT = Bun.argv.includes("--json")
const onlyAt = Bun.argv.indexOf("--only")
const ONLY = onlyAt >= 0 ? Bun.argv[onlyAt + 1] : null

interface BenchSpec {
  name: string
  file: string
  args: string[]
}

const BENCHES: BenchSpec[] = [
  { name: "driver", file: "driver.ts", args: [] },
  { name: "wal", file: "wal.ts", args: [] },
  { name: "tenant", file: "tenant.ts", args: QUICK ? ["500", "--tenants", "1000"] : ["2000", "--tenants", "10000"] },
  { name: "http", file: "http.ts", args: QUICK ? ["500"] : ["2000"] },
  {
    name: "replication",
    file: "replication.ts",
    args: QUICK ? ["100", "500"] : ["300", "2000"],
  },
  { name: "storage", file: "storage.ts", args: QUICK ? ["500"] : ["2000"] },
  // L5's instrument. The only benchmark here that runs *many* databases at once, which is the
  // whole point of it — and the reason its ladder is short by default: 500 tenants is 500 open
  // SQLite connections and three minutes of disk.
  {
    name: "fsync",
    file: "fsync.ts",
    args: QUICK ? ["40", "--tenants", "1,10,100"] : ["60", "--tenants", "1,10,100,500"],
  },
]

/** One row of design §10. `direction` says which side of the budget is good. */
interface Budget {
  row: string
  bench: string
  leg: string
  budget: number
  direction: "max" | "min"
  unit: "µs" | "req/s" | "msg/s" | "tenants"
  note?: string
}

const BUDGETS: Budget[] = [
  {
    row: "point read, in process (plan M2)",
    bench: "driver",
    leg: "point read by primary key -> object",
    budget: 1.2,
    direction: "max",
    unit: "µs",
  },
  {
    row: "point read over HTTP keep-alive",
    bench: "http",
    leg: "point read, HTTP keep-alive",
    budget: 60,
    direction: "max",
    unit: "µs",
  },
  {
    row: "point read over WebSocket",
    bench: "http",
    leg: "point read, WebSocket",
    budget: 35,
    direction: "max",
    unit: "µs",
  },
  {
    row: "single-row write, ack local, incl. tail+log",
    bench: "tenant",
    leg: "write, ack local",
    budget: 40,
    direction: "max",
    unit: "µs",
    note: "the in-process path the budget names",
  },
  {
    row: "write visible on a replica",
    bench: "replication",
    leg: "commit -> replica applied",
    budget: 1000,
    direction: "max",
    unit: "µs",
    note: "over a loopback WebSocket, so this is the floor of the LAN number",
  },
  {
    row: "write visible on a replica, no transport",
    bench: "wal",
    leg: "end to end",
    budget: 1000,
    direction: "max",
    unit: "µs",
    note: "the same path with the socket taken out, for comparison",
  },
  {
    row: "live-query invalidation → event on socket",
    bench: "http",
    leg: "live-query invalidation → event on socket",
    budget: 200,
    direction: "max",
    unit: "µs",
    note: "round trip minus a bare write over the same socket",
  },
  {
    row: "tenants open per process",
    bench: "tenant",
    leg: "tenants open per process",
    budget: QUICK ? 1000 : 10_000,
    direction: "min",
    unit: "tenants",
  },
  {
    row: "throughput, mixed 90/10, HTTP",
    bench: "http",
    leg: "throughput, mixed 90/10, HTTP",
    budget: 50_000,
    direction: "min",
    unit: "req/s",
  },
  {
    row: "throughput, mixed 90/10, WebSocket",
    bench: "http",
    leg: "throughput, mixed 90/10, WebSocket",
    budget: 150_000,
    direction: "min",
    unit: "msg/s",
  },
]

/**
 * A phase-1 leg. `against` names the leg on the same bench it should be read next to — the local
 * write for a forwarded one, the native route for the Hrana one — so the table shows the cost of
 * the feature rather than the cost of the machine.
 */
interface Phase1Row {
  row: string
  bench: string
  leg: string
  unit: "µs" | "rec/s" | "MiB/s"
  against?: string
}

const PHASE1: Phase1Row[] = [
  {
    row: "write, ack local, on the primary (HTTP)",
    bench: "replication",
    leg: "primary write (HTTP)",
    unit: "µs",
  },
  {
    row: "write forwarded through a replica",
    bench: "replication",
    leg: "write forwarded via replica",
    unit: "µs",
    against: "primary write (HTTP)",
  },
  {
    row: "write, ack replica",
    bench: "replication",
    leg: "write, ack replica",
    unit: "µs",
    against: "primary write (HTTP)",
  },
  {
    row: "write, ack quorum",
    bench: "replication",
    leg: "write, ack quorum",
    unit: "µs",
    against: "primary write (HTTP)",
  },
  {
    row: "point read, Hrana pipeline",
    bench: "http",
    leg: "point read, Hrana pipeline",
    unit: "µs",
    against: "point read, HTTP keep-alive",
  },
  {
    row: "write, Hrana pipeline",
    bench: "http",
    leg: "single-row write, ack local, Hrana pipeline",
    unit: "µs",
    against: "single-row write, ack local, HTTP",
  },
  { row: "records shipped to S3 per second", bench: "storage", leg: "records shipped/s", unit: "rec/s" },
  { row: "pushed to S3, MiB/s", bench: "storage", leg: "MiB/s to the bucket", unit: "MiB/s" },
  { row: "one commit to the bucket", bench: "storage", leg: "one commit to the bucket", unit: "µs" },
]

// ── run ────────────────────────────────────────────────────────────────────────────────────────

const reports = new Map<string, BenchReport>()
const failures: string[] = []

for (const spec of BENCHES) {
  if (ONLY && spec.name !== ONLY) continue
  const banner = `── ${spec.name} ${"─".repeat(Math.max(0, 76 - spec.name.length))}`
  console.log(`\n${banner}\n`)
  const started = Bun.nanoseconds()
  const child = Bun.spawn(
    [process.execPath, "run", path.join(import.meta.dir, spec.file), ...spec.args],
    { stdout: "pipe", stderr: "inherit", env: { ...process.env, BUNQL_BENCH_JSON: "1" } },
  )
  const output = await new Response(child.stdout).text()
  const code = await child.exited
  // The `##BENCH##` line is machine-only; everything else is what a human runs the benchmark for.
  for (const line of output.split("\n")) {
    if (!line.startsWith("##BENCH##")) console.log(line)
  }
  const report = parseReport(output)
  if (report) reports.set(spec.name, report)
  else failures.push(`${spec.name} printed no ##BENCH## line`)
  if (code !== 0) failures.push(`${spec.name} exited ${code}`)
  console.log(`(${spec.name}: ${((Bun.nanoseconds() - started) / 1e9).toFixed(1)} s)`)
}

// ── the §10 table ──────────────────────────────────────────────────────────────────────────────

export interface BudgetRow {
  row: string
  measured: number | null
  budget: number
  unit: string
  verdict: "PASS" | "WARN" | "SKIP"
  note?: string
}

function verdictOf(budget: Budget, measured: number | null): "PASS" | "WARN" | "SKIP" {
  if (measured === null) return "SKIP"
  return budget.direction === "max"
    ? measured <= budget.budget
      ? "PASS"
      : "WARN"
    : measured >= budget.budget
      ? "PASS"
      : "WARN"
}

const rows: BudgetRow[] = BUDGETS.map((budget) => {
  const sample = reports.get(budget.bench)?.legs[budget.leg]
  const measured = sample === undefined ? null : (sample.value ?? sample.p50)
  return {
    row: budget.row,
    measured,
    budget: budget.budget,
    unit: budget.unit,
    verdict: verdictOf(budget, measured),
    ...(budget.note ? { note: budget.note } : {}),
  }
})

function format(value: number, unit: string): string {
  if (unit === "req/s" || unit === "msg/s" || unit === "tenants") {
    return Math.round(value).toLocaleString("en-US")
  }
  return value.toFixed(value < 10 ? 2 : 1)
}

const cpu = os.cpus()[0]?.model ?? "unknown"
const lib = sqlite()

console.log(`\n${"═".repeat(84)}`)
console.log("design §10 performance budget")
console.log(
  `${cpu} · ${os.cpus().length} cores · ${process.platform}/${process.arch} · Bun ${Bun.version}`,
)
console.log(`SQLite ${lib.version} (${lib.path})${QUICK ? " · --quick" : ""}`)
console.log("═".repeat(84))

const width = Math.max(...rows.map((r) => r.row.length))
console.log(
  `${"path".padEnd(width)}  ${"measured".padStart(12)}  ${"budget".padStart(12)}  verdict`,
)
console.log("-".repeat(width + 40))
for (const row of rows) {
  const measured = row.measured === null ? "—" : format(row.measured, row.unit)
  const arrow = BUDGETS.find((b) => b.row === row.row)?.direction === "max" ? "≤" : "≥"
  console.log(
    `${row.row.padEnd(width)}  ${measured.padStart(12)}  ` +
      `${`${arrow} ${format(row.budget, row.unit)}`.padStart(12)}  ${row.verdict}` +
      `${row.unit === "µs" ? "" : ` ${row.unit}`}`,
  )
}

const warned = rows.filter((r) => r.verdict === "WARN")
const skipped = rows.filter((r) => r.verdict === "SKIP")
console.log("")
if (warned.length === 0 && skipped.length === 0) {
  console.log("every design §10 budget met.")
} else {
  if (warned.length > 0) console.log(`WARN: ${warned.map((r) => r.row).join("; ")}`)
  if (skipped.length > 0) console.log(`not measured: ${skipped.map((r) => r.row).join("; ")}`)
}
for (const note of rows.filter((r) => r.note)) console.log(`  · ${note.row}: ${note.note}`)
for (const failure of failures) console.log(`  ! ${failure}`)

// ── the phase-1 legs ───────────────────────────────────────────────────────────────────────────

export interface Phase1Measurement {
  row: string
  measured: number | null
  unit: string
  against: number | null
}

const phase1: Phase1Measurement[] = PHASE1.map((one) => {
  const report = reports.get(one.bench)
  const sample = report?.legs[one.leg]
  const reference = one.against === undefined ? undefined : report?.legs[one.against]
  return {
    row: one.row,
    measured: sample === undefined ? null : (sample.value ?? sample.p50),
    unit: one.unit,
    against: reference === undefined ? null : (reference.value ?? reference.p50),
  }
})

if (phase1.some((one) => one.measured !== null)) {
  console.log(`\n${"═".repeat(84)}`)
  console.log("phase 1: routing, durability, Hrana and the shipper (no design §10 budget)")
  console.log("═".repeat(84))
  const phaseWidth = Math.max(...phase1.map((one) => one.row.length))
  console.log(
    `${"path".padEnd(phaseWidth)}  ${"measured".padStart(12)}  ${"read against".padStart(14)}  unit`,
  )
  console.log("-".repeat(phaseWidth + 40))
  for (const one of phase1) {
    if (one.measured === null) continue
    // Only a per-second count is rounded to whole units; a latency or a rate keeps its decimal.
    const as = one.unit === "rec/s" ? "req/s" : "µs"
    const measured = format(one.measured, as)
    const against = one.against === null ? "—" : format(one.against, as)
    console.log(
      `${one.row.padEnd(phaseWidth)}  ${measured.padStart(12)}  ${against.padStart(14)}  ${one.unit}`,
    )
  }
  const missing = phase1.filter((one) => one.measured === null)
  if (missing.length > 0) console.log(`not measured: ${missing.map((o) => o.row).join("; ")}`)
}

if (JSON_OUT) {
  console.log(
    `\n##REPORTS## ${JSON.stringify({
      machine: {
        cpu,
        cores: os.cpus().length,
        platform: `${process.platform}/${process.arch}`,
        memoryGb: Math.round(os.totalmem() / 1e9),
        bun: Bun.version,
        sqlite: lib.version,
        sqliteLib: lib.path,
        at: new Date().toISOString(),
      },
      budget: rows,
      phase1,
      benches: Object.fromEntries(reports),
    })}`,
  )
}
