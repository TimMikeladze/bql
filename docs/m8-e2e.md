# M8 — end-to-end suite, benchmark runner, API docs

Companion to `docs/plan-phase0.md` M8. What this milestone builds, why each piece is shaped the way
it is, and what it deliberately does not do. Written before the code, kept accurate after it.

## 1. `test/e2e/` — one scenario, the whole product

A single suite that drives the server the way a user would: over the network surface, through the
client SDK and through raw `fetch`/`WebSocket`, with nothing reaching into `src/` except the two
places where the point *is* to reach in (the WAL applier, and the tenant directory it reads).

One file, `test/e2e/scenario.test.ts`, with ordered tests sharing one server — `bun test` runs a
file's tests in order, and the scenario is a sequence, not a set. `test/e2e/harness.ts` holds the
pieces that are e2e-specific; the server harness of `test/server/harness.ts` is reused for the
listener, the SSE parser and the socket wrapper.

| step | what it proves |
|---|---|
| create `alpha`, `beta`, `gamma`, each with a schema | the admin surface, three independent txid spaces |
| 20 client tasks writing concurrently to all three, while 5 SSE `changes` and 5 WS `live` subscribers watch each | every commit reaches every subscriber exactly once, in txid order; live results converge on the committed state |
| fork `alpha` at a mid txid | `GET /v1/db/{fork}/dump` equals a dump of `alpha` taken at that txid |
| snapshot + PITR restore into a new name | `POST /v1/db/{db}/snapshot` then `/restore` reconstructs the state at a txid |
| token scoping | a `ro` token cannot write through the SDK; a table ACL denies the table it does not name |
| server restart on the same data dir | txids survive, the client reconnects, `Last-Event-ID` resumes the change feed without a gap |
| the `src/wal` applier fed from `alpha`'s log into a fresh directory | phase 1's replication path works on today's bytes: the replica's dump equals the primary's |

**The txid-exactly-once assertion.** Every write in the concurrent phase inserts one row, so every
write advances its tenant's txid by exactly one and produces exactly one change event. Each
subscriber collects the txids it saw; the assertion is that the multiset of txids per subscriber
equals the set of txids the writers were told, with no duplicate and no gap. Subscribers are
opened and confirmed *before* the first write, so "since" never has to reach into the past here —
the resume case is tested separately, at the restart.

**Timing.** Budget is 40 s for the file. The concurrency phase is the only part that can drift, so
it is sized by rows (20 tasks × 6 writes × 3 databases = 360 commits) rather than by a clock, and
every wait is a condition with a deadline, never a sleep.

**What it does not do.** No process spawning (the CLI already has `test/cli/cli.test.ts`), no
crash injection (M4 covers reconcile), no property testing (M3 covers replication).

## 2. `bench/run.ts` — one table against design §10

`bun run bench` runs the four benchmarks as subprocesses and prints one table of the design §10
budgets with PASS / WARN, then the per-benchmark detail. Subprocesses because `bench/driver.ts`
loads `bun:sqlite` and `bench/http.ts` binds a port; one process running all four would measure a
heap and a JIT that four separate runs do not share.

**How a number gets out of a benchmark.** Each benchmark keeps its human table and, when
`BUNQL_BENCH_JSON=1` is set, prints one extra last line:

```
##BENCH## {"bench":"http","legs":{"point read, HTTP keep-alive":{"p50":48.5,"p90":56.2}}}
```

`run.ts` reads that line and ignores everything else, so the human output and the machine output
cannot drift apart — they are the same numbers, printed twice.

**The HTTP/WS load moves to its own process.** `docs/m5-server.md` ends by saying its throughput
figure is capped by the client sharing the server's event loop, and that a real number needs the
client on another core. So `bench/http.ts` now starts the server, seeds the database and
`Bun.spawn`s `bench/http-client.ts` to generate the load; the client prints the JSON line and the
server process prints the table. `--in-process` keeps the old single-process shape for comparison
against M5's numbers. Where `taskset` exists (Linux) the two are pinned to different CPUs; macOS
has no equivalent, and two processes is already what separates the event loops.

**§10 rows and where each number comes from.**

| §10 row | budget | source |
|---|---|---|
| point read over HTTP keep-alive | ≤ 60 µs p50 | `http` |
| point read over WS | ≤ 35 µs p50 | `http` |
| single-row write, `ack: local`, incl. tail+log | ≤ 40 µs p50 | `tenant` (the in-process path the budget names) |
| write visible on LAN replica | ≤ 1 ms p50 | `wal`, end-to-end leg (same host, so this is a floor) |
| live-query invalidation → event on socket | ≤ 200 µs p50 | `http`, new leg: a WS `live` subscription, a write on another connection, time to the `rows`/`diff` frame |
| tenants open per process | 10k | `tenant`, new leg: open N tenants without eviction and report the fd limit alongside |
| throughput, mixed 90/10, one core | ≥ 50k req/s HTTP, ≥ 150k msg/s WS | `http`, new legs run from the client process |

Two additions to the benchmarks are needed for that: the live-query latency leg and the throughput
legs in `bench/http-client.ts`, and the tenant-count leg in `bench/tenant.ts`. The driver's own
≤ 1.2 µs point-read gate (plan M2) is carried in the table too, since it is the floor everything
else sits on.

**PASS / WARN, never FAIL.** A benchmark is a measurement on the machine it ran on. `run.ts` exits
0 whatever the numbers say, prints WARN for a budget missed, and says so in one line at the end.
The one hard gate stays where it already is: `bench/driver.ts` exits non-zero on its own point-read
target.

`docs/benchmarks.md` records a run with `os.cpus()[0].model`, `Bun.version`, the SQLite version and
the library path the driver resolved — the same header `run.ts` prints.

## 3. `docs/api.md` — the API as implemented

The route table is generated from `createApp()`'s own routing table rather than transcribed:
`scripts/routes.ts` imports `createApp`, walks `app.routes`, and prints the method/path pairs. The
descriptions, bodies and examples are hand-written against `src/server/routes.ts`, and every
example is one that was run.

Sections: HTTP routes (method, path, auth, request, response, headers, errors) · the WebSocket
protocol, every op with a frame · SSE event formats · the client SDK · the embedded API · the CLI ·
config keys with their environment overrides · and a closing **Differences from the design**
section collecting every deviation the `m*` notes record, so a reader of `docs/design.md` has one
place to find what actually shipped.

`docs/design.md` is not edited. It is the proposal; `docs/api.md` is the implementation.

## 4. README and packaging

README keeps its verified quickstart and gains a "What exists today, what is phase 1" section
(phase 1 = replica streaming over WS, semi-sync ack, S3 shipper, Hrana compat, Kysely/Drizzle
adapters; phase 2 = cluster) plus links to `docs/api.md`.

`package.json` gains `files` and keeps `engines.bun`, and `bench` points at `bench/run.ts` with the
four individual benchmarks still reachable as `bench:driver`, `bench:wal`, `bench:tenant`,
`bench:http`. The acceptance check is a fresh clone: `bun install`, then `bun test`,
`bun run typecheck`, `bun run bench`, `bun run start` and `bunql serve --port 0`.

## As built

Everything above shipped as described. Three things worth recording that the plan did not
anticipate:

- **A `Last-Event-ID` resume across a restart is answered with `reset`, not a gapless backlog**,
  and the suite asserts that rather than the gapless resume the milestone brief asked for. The
  change ring lives in memory; the ring a restarted server builds is sealed at the txid it finds,
  so a position from before the restart is one it cannot honestly serve. The gapless case — a
  dropped connection while the server stays up, with commits landing in between — is asserted
  separately and does hold, because the engine outlives its last subscriber by `idleRetainMs`.
  This is now written down in `docs/api.md` under the SSE formats and in its differences section.
- **`scripts/` is in `tsconfig.json`'s `include` now.** `scripts/routes.ts` is the generator
  `docs/api.md` depends on, and a generator that is not type-checked is one that breaks silently.
  The pre-existing `scripts/design-page.ts` was already clean.
- **The one budget not met is WebSocket throughput** — 129k msg/s against 150k, on a mixed 90/10
  load where the writes serialise on the tenant's single writer. `docs/benchmarks.md` shows the
  arithmetic. Everything else in design §10 passes, including the 10 000 open tenants, which this
  machine's file-descriptor limit makes reachable.
