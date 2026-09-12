// Runs the four benchmarks and prints one table against the performance budget of design §10.
//
//   bun run bench                 # everything
//   bun run bench --quick         # fewer rounds, for a laptop on battery
//   bun run bench --only http     # one of driver | wal | tenant | http | replication
//   bun run bench --json          # every report as JSON, for docs/benchmarks.md
//
// Each benchmark runs as its own process: `bench/driver.ts` loads bun:sqlite, `bench/http.ts`
// binds a port and spawns a load client of its own, and four benchmarks sharing one heap would
// measure a JIT that four separate runs do not share. Every child prints its usual human table
// plus one `##BENCH##` line, which is the only thing read back.
//
// This never fails a build. A benchmark is a measurement of the machine it ran on, so a missed
// budget is a WARN and the exit code stays 0 — the one hard gate is `bench/driver.ts`'s own
// point-read target, which it enforces itself.

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
      benches: Object.fromEntries(reports),
    })}`,
  )
}
