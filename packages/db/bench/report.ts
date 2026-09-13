// Shared between the four benchmarks and `bench/run.ts`. A benchmark keeps printing its human
// table; when `BUNQL_BENCH_JSON=1` is set it prints one extra line at the end, which the runner
// reads and nothing else does. The two are the same numbers printed twice, so they cannot drift.

/** The marker `bench/run.ts` scans stdout for. Nothing else may print a line starting with it. */
export const MARKER = "##BENCH##"

export interface Sample {
  p50: number
  p90?: number
  p99?: number
  /** For legs that are one number rather than a distribution. */
  value?: number
  unit?: "us" | "count" | "rps" | "mps"
}

export interface BenchReport {
  bench: string
  /** Anything the runner should print in the table header, such as the SQLite build. */
  info?: Record<string, string | number>
  legs: Record<string, Sample>
}

export function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[at] as number
}

export function distribution(samples: readonly number[]): Sample {
  return {
    p50: percentile(samples, 50),
    p90: percentile(samples, 90),
    p99: percentile(samples, 99),
    unit: "us",
  }
}

export function wantsJson(env: Record<string, string | undefined> = Bun.env): boolean {
  return env.BUNQL_BENCH_JSON === "1"
}

/** Prints the machine-readable line, if anyone asked for it. */
export function emit(report: BenchReport, env: Record<string, string | undefined> = Bun.env): void {
  if (!wantsJson(env)) return
  console.log(`${MARKER} ${JSON.stringify(report)}`)
}

/** The first `##BENCH##` line in a benchmark's output, or null when it printed none. */
export function parseReport(output: string): BenchReport | null {
  for (const line of output.split("\n")) {
    if (!line.startsWith(MARKER)) continue
    try {
      return JSON.parse(line.slice(MARKER.length)) as BenchReport
    } catch {
      return null
    }
  }
  return null
}
