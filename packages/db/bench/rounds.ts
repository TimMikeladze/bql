// What makes `bun run bench` repeatable: the suite runs N rounds, and each leg is reported as the
// median across rounds with its spread, so a reader can tell a change from the machine's noise.
// `bench/run.ts` runs and saves; `bench/compare.ts` reads two saved runs. Pure functions only, so
// `test/bench/rounds.test.ts` can pin them without spawning anything.

import type { BenchReport, Sample } from "./report.ts"

/** Above this, a leg's spread across rounds is wider than the 10% docs/performance.md §8 trusts. */
export const NOISY = 0.1

/** One leg across every round it was measured in. */
export interface LegRounds {
  /** The median of the per-round values; what every table prints. */
  median: number
  /** `(max - min) / median` across rounds. 0 with a single round. */
  spread: number
  /** Each round's value, in round order. */
  samples: number[]
  unit?: Sample["unit"]
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

/** A leg's one number: `value` when the leg is a count or a rate, otherwise its p50. */
export function headline(sample: Sample): number {
  return sample.value ?? sample.p50
}

/**
 * Folds one benchmark's per-round reports into one report the budget tables can read, plus the
 * per-leg rounds. A leg missing from some rounds is aggregated over the rounds that have it.
 */
export function aggregate(runs: readonly BenchReport[]): { report: BenchReport; legs: Record<string, LegRounds> } {
  const first = runs[0]
  if (!first) throw new Error("aggregate needs at least one round")
  const names = [...new Set(runs.flatMap((run) => Object.keys(run.legs)))]
  const legs: Record<string, LegRounds> = {}
  const merged: Record<string, Sample> = {}
  for (const name of names) {
    const samples = runs.map((run) => run.legs[name]).filter((s): s is Sample => s !== undefined)
    const values = samples.map(headline)
    const mid = median(values)
    legs[name] = {
      median: mid,
      spread: values.length < 2 || mid === 0 ? 0 : (Math.max(...values) - Math.min(...values)) / Math.abs(mid),
      samples: values,
      ...(samples[0]?.unit ? { unit: samples[0].unit } : {}),
    }
    const pick = (key: "p50" | "p90" | "p99" | "value") => {
      const present = samples.map((s) => s[key]).filter((v): v is number => v !== undefined)
      return present.length === 0 ? {} : { [key]: median(present) }
    }
    merged[name] = {
      p50: median(samples.map((s) => s.p50)),
      ...pick("p90"),
      ...pick("p99"),
      ...pick("value"),
      ...(samples[0]?.unit ? { unit: samples[0].unit } : {}),
    }
  }
  return { report: { ...first, legs: merged }, legs }
}

/** A process that has held most of a core for a long time — the runaway shells of §8. */
export interface Runaway {
  pid: number
  cpu: number
  elapsed: string
  command: string
}

/** `ps -A -o pid=,%cpu=,etime=,comm=` elapsed time, `[[dd-]hh:]mm:ss`, in seconds. */
export function elapsedSeconds(etime: string): number {
  const [days, rest] = etime.includes("-") ? etime.split("-") : ["0", etime]
  const parts = (rest ?? "").split(":").map(Number)
  while (parts.length < 3) parts.unshift(0)
  const [h, m, s] = parts as [number, number, number]
  return Number(days) * 86_400 + h * 3600 + m * 60 + s
}

/** Parses `ps -A -o pid=,%cpu=,etime=,comm=`; keeps anything above 80% CPU for over ten minutes. */
export function findRunaways(ps: string, self = process.pid): Runaway[] {
  const found: Runaway[] = []
  for (const line of ps.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\S+)\s+(.+)$/)
    if (!match) continue
    const [, pid, cpu, elapsed, command] = match as unknown as [string, string, string, string, string]
    if (Number(pid) === self) continue
    if (Number(cpu) > 80 && elapsedSeconds(elapsed) > 600) {
      found.push({ pid: Number(pid), cpu: Number(cpu), elapsed, command })
    }
  }
  return found
}

/** A saved run, as `bun run bench --save` writes it to `bench/results/`. */
export interface SavedRun {
  machine: Record<string, string | number>
  git: { sha: string; dirty: boolean }
  /** Every `BQL_*` variable set for the run. */
  env?: Record<string, string>
  load: { before: number[]; after: number[] }
  runaways: Runaway[]
  args: string[]
  rounds: number
  legs: Record<string, Record<string, LegRounds>>
}

/** Lower is better for a latency; higher for a rate or a count. */
function lowerIsBetter(leg: LegRounds): boolean {
  return leg.unit === undefined || leg.unit === "us"
}

export interface Change {
  bench: string
  leg: string
  before: number
  after: number
  /** `(after - before) / before`. */
  change: number
  /** Inside the larger of the two spreads, so not distinguishable from noise. */
  withinNoise: boolean
  better: boolean
}

/** Every leg present in both runs, in the order the newer run lists them. */
export function compare(before: SavedRun, after: SavedRun): Change[] {
  const changes: Change[] = []
  for (const [bench, legs] of Object.entries(after.legs)) {
    for (const [leg, now] of Object.entries(legs)) {
      const then = before.legs[bench]?.[leg]
      if (!then || then.median === 0) continue
      const change = (now.median - then.median) / then.median
      changes.push({
        bench,
        leg,
        before: then.median,
        after: now.median,
        change,
        withinNoise: Math.abs(change) <= Math.max(then.spread, now.spread),
        better: lowerIsBetter(now) ? change < 0 : change > 0,
      })
    }
  }
  return changes
}
