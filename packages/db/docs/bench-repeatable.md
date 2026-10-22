# Repeatable benchmarks

`docs/benchmarks.md` has been waiting since 2026-09-12 for "one coherent run on a quiet machine",
and `docs/performance.md` §8 lists why single runs on this machine can't be trusted: background
load, runaway processes, and legs that are only ever measured once. `bun run bench` ran each
benchmark once and printed the result. That makes a number, not a measurement anyone can repeat.

## What changes

- **Rounds, interleaved.** `bun run bench --rounds N` (default 3, `--quick` defaults to 1) runs the
  whole suite N times round-robin: driver, wal, tenant, … then driver again. Drift during the run
  spreads across every benchmark instead of landing on whichever ran last.
- **Median and spread per leg.** A leg's reported value is the median of its per-round p50 (or
  value). Spread is `(max - min) / median` across rounds. A spread above 10% is flagged `noisy`,
  which is the 20%-resolution caveat of §8 made visible per leg instead of stated once.
- **Preflight.** Before measuring: load averages, and any process above 80% CPU that has been
  running for more than ten minutes (the runaway shells of §8). Printed always, recorded in the
  saved file. `--strict` exits 2 if the 1-minute load is above 4 or a runaway is found.
- **Saved runs.** `--save` writes `bench/results/<date>-<sha>.json`: machine, Bun, SQLite, git sha
  and whether the tree was dirty, load before and after, the arguments, and every round's raw
  sample per leg. These files are committed, so a later run has something to compare against.
- **Compare.** `bun run bench:compare <old.json> <new.json>` prints each leg's median in both, the
  change, and `~` when the change is inside the larger of the two spreads. A change inside the
  noise is not a regression or a win.
- **The bus is in the suite.** `packages/bus/scripts/bench.ts` emits a `##BENCH##` line, so
  `bun run bench` covers publish/claim/ack throughput as well. The root `bun run bench` runs it.

## Not changing

Budgets, legs and the per-benchmark arguments stay as they are, so the new numbers are comparable
with the old file. `bench/workers.ts`, `bench/profile.ts`, `bench/router.ts` and `bench/cloud.ts`
stay outside the suite for the reasons `bench/run.ts` gives.
