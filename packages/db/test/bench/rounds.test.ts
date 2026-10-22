import { describe, expect, test } from "bun:test"
import { aggregate, compare, elapsedSeconds, findRunaways, median, type SavedRun } from "../../bench/rounds.ts"

describe("aggregate", () => {
  test("a leg is the median across rounds, with its spread", () => {
    const { report, legs } = aggregate([
      { bench: "x", legs: { read: { p50: 10, p99: 30, unit: "us" }, rps: { p50: 900, value: 900, unit: "rps" } } },
      { bench: "x", legs: { read: { p50: 12, p99: 50, unit: "us" }, rps: { p50: 1100, value: 1100, unit: "rps" } } },
      { bench: "x", legs: { read: { p50: 11, p99: 40, unit: "us" }, rps: { p50: 1000, value: 1000, unit: "rps" } } },
    ])
    expect(legs.read).toEqual({ median: 11, spread: 2 / 11, samples: [10, 12, 11], unit: "us" })
    expect(legs.rps?.median).toBe(1000)
    expect(report.legs.read).toEqual({ p50: 11, p99: 40, unit: "us" })
    expect(report.legs.rps?.value).toBe(1000)
  })

  test("one round has no spread, and a leg missing from a round uses the rest", () => {
    expect(aggregate([{ bench: "x", legs: { a: { p50: 5 } } }]).legs.a?.spread).toBe(0)
    const { legs } = aggregate([
      { bench: "x", legs: { a: { p50: 4 } } },
      { bench: "x", legs: {} },
      { bench: "x", legs: { a: { p50: 6 } } },
    ])
    expect(legs.a?.samples).toEqual([4, 6])
    expect(legs.a?.median).toBe(5)
  })
})

test("median of an even count averages the middle two", () => {
  expect(median([4, 1, 3, 2])).toBe(2.5)
})

describe("runaways", () => {
  test("ps elapsed times", () => {
    expect(elapsedSeconds("05:03")).toBe(303)
    expect(elapsedSeconds("01:00:00")).toBe(3600)
    expect(elapsedSeconds("1-18:00:00")).toBe(151_200)
  })

  test("only a process over 80% for more than ten minutes counts", () => {
    const ps = [
      "  101  99.0 18:00:00 /bin/zsh",
      "  102  99.0    05:00 /bin/zsh",
      "  103  12.0 02-01:00:00 WindowServer",
      "  104 150.0    10:01 bun",
    ].join("\n")
    expect(findRunaways(ps, 0).map((r) => r.pid)).toEqual([101, 104])
    expect(findRunaways(ps, 101).map((r) => r.pid)).toEqual([104])
  })
})

describe("compare", () => {
  const run = (legs: SavedRun["legs"]): SavedRun => ({
    machine: { cpu: "m", cores: 1 },
    git: { sha: "a", dirty: false },
    load: { before: [0, 0, 0], after: [0, 0, 0] },
    runaways: [],
    args: [],
    rounds: 3,
    legs,
  })

  test("a change inside the spread is noise; direction follows the unit", () => {
    const before = run({
      b: {
        read: { median: 10, spread: 0.05, samples: [], unit: "us" },
        rps: { median: 1000, spread: 0.02, samples: [], unit: "rps" },
        write: { median: 20, spread: 0.02, samples: [], unit: "us" },
      },
    })
    const after = run({
      b: {
        read: { median: 10.4, spread: 0.03, samples: [], unit: "us" },
        rps: { median: 1200, spread: 0.02, samples: [], unit: "rps" },
        write: { median: 25, spread: 0.02, samples: [], unit: "us" },
        added: { median: 1, spread: 0, samples: [], unit: "us" },
      },
    })
    const byLeg = Object.fromEntries(compare(before, after).map((c) => [c.leg, c]))
    expect(Object.keys(byLeg)).toEqual(["read", "rps", "write"])
    expect(byLeg.read?.withinNoise).toBe(true)
    expect(byLeg.rps).toMatchObject({ withinNoise: false, better: true })
    expect(byLeg.write).toMatchObject({ withinNoise: false, better: false, change: 0.25 })
  })
})
