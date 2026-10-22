// Compares two runs saved by `bun run bench --save`.
//
//   bun run bench:compare bench/results/2026-10-21-bf52584.json bench/results/2026-10-22-abc1234.json
//
// Prints every leg present in both, the change, and a verdict. `~` means the change is inside the
// larger of the two runs' spreads across rounds, which is noise rather than a regression or a win.
// Exits 0 either way: a benchmark measures the machine it ran on.

import { compare, type SavedRun } from "./rounds.ts"

const [beforePath, afterPath] = Bun.argv.slice(2)
if (!beforePath || !afterPath) {
  console.error("usage: bun run bench:compare <before.json> <after.json>")
  process.exit(1)
}
const before = (await Bun.file(beforePath).json()) as SavedRun
const after = (await Bun.file(afterPath).json()) as SavedRun

const describe = (run: SavedRun) =>
  `${run.git.sha}${run.git.dirty ? "-dirty" : ""} · ${run.machine.at} · ${run.rounds} rounds · load ${run.load.before
    .map((n) => n.toFixed(2))
    .join(" ")}`
console.log(`before  ${describe(before)}`)
console.log(`after   ${describe(after)}`)
if (before.machine.cpu !== after.machine.cpu || before.machine.cores !== after.machine.cores) {
  console.log(`! different machines: ${before.machine.cpu} vs ${after.machine.cpu}`)
}
if (JSON.stringify(before.env ?? {}) !== JSON.stringify(after.env ?? {})) {
  console.log(`! different BQL_* settings: ${JSON.stringify(before.env ?? {})} vs ${JSON.stringify(after.env ?? {})}`)
}
if (before.rounds < 2 || after.rounds < 2) {
  console.log("! a run with one round has no spread, so nothing can be called noise")
}

const fmt = (n: number) => (n >= 1000 ? Math.round(n).toLocaleString("en-US") : n.toFixed(n < 10 ? 2 : 1))
const changes = compare(before, after)
const width = Math.min(60, Math.max(...changes.map((c) => c.leg.length), 10))
let bench = ""
for (const c of changes) {
  if (c.bench !== bench) {
    bench = c.bench
    console.log(`\n${bench}`)
  }
  const pct = `${c.change >= 0 ? "+" : ""}${(c.change * 100).toFixed(1)}%`
  const verdict = c.withinNoise ? "~" : c.better ? "better" : "worse"
  console.log(
    `  ${c.leg.slice(0, width).padEnd(width)}  ${fmt(c.before).padStart(10)}  ${fmt(c.after).padStart(10)}  ${pct.padStart(8)}  ${verdict}`,
  )
}
const worse = changes.filter((c) => !c.withinNoise && !c.better)
const better = changes.filter((c) => !c.withinNoise && c.better)
console.log(`\n${changes.length} legs · ${better.length} better · ${worse.length} worse · the rest inside the noise`)
