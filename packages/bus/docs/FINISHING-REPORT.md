# What was done, what was verified, and what was not

> This is the **0.1** report. What happened after it — durability, exactly-once, schemas,
> tenant safety, observability, continuity and packaging — is recorded in
> [the production spec](superpowers/specs/2026-09-13-production.md), which carries its own
> verification table and a *What the plan got wrong* section.

The work in [`FINISHING.md`](FINISHING.md), item by item. Decisions live in
[the finishing spec](superpowers/specs/2026-09-13-finishing.md); this is the evidence.

## Verified, by running it

| Check | Result |
| --- | --- |
| `bun run typecheck` | clean, under `noUncheckedIndexedAccess` |
| `bun test tests` | 84 pass, 0 fail (was 61) |
| `bun run build` | library bundle + dashboard |
| `bun run test:e2e` | 15 checks, all pass |
| `bun run verify-pack` | packs, installs into an empty directory, runs |
| `bun run soak --repeat 10` | 10/10 |
| `bun run soak --ordered --repeat 10` | 10/10 |
| `bun run soak --kill-bus --repeat 10` | 10/10 |
| `bun run soak --term-bus --repeat 10` | 10/10 |
| dagr `bun run type-check` | clean across all four packages |
| dagr `bun test` | 1014 pass, 0 fail |
| dagr-remote `bun test/e2e.ts` | 10 checks, all pass |

## 1. Concurrency — done

`scripts/soak.ts` plus `scripts/soak-worker.ts`. Eight consumer processes on one subscription,
5000 messages, consumers SIGKILLed and restarted under the same id throughout. Asserts every
message handled at least once (from per-consumer receipt files), acked exactly once, nothing left
pending or leased, nothing dead-lettered. `--ordered` adds per-key FIFO; `--kill-bus` SIGKILLs
the broker mid-flight; `--term-bus` SIGTERMs it and scrapes `/metrics` afterwards.

**No bug was found in `materialize()` or the claim path.** Ten consecutive runs of each of the
four variants pass. Redeliveries appear as expected — typically 15–45 per run, which is the
evidence that the kills actually landed on in-flight work rather than after it.

Two bugs *were* found, both in the harness rather than the bus. The first version paced kills by
message count, which put most of them after the run had drained — it passed while proving
nothing, and the tell was 12 kills producing a single redelivery. Kills are wall-clock paced now.

The second only appeared under `--kill-bus`, once in ten runs: `acked=5001 published=5000`.
SIGKILLing the broker can lose the *response* to a publish that already committed, and the
harness's retry then published a second copy. The publisher uses a `dedupeKey` now, so a retry is
handed back the original message — which is what dedupe keys are for, and makes the assertion
exact instead of approximate. That it was the harness and not the store was worth confirming
rather than assuming: the failure mode of an over-count is indistinguishable from a real
double-ack until you look.

## 2. Schema versioning — done

`schema_version` table, ordered `MIGRATIONS`, and a refusal to open a database newer than the
code. `tests/migrations.test.ts` builds the pre-versioning schema **by hand** — its DDL spelled
out rather than imported, so the test cannot quietly agree with the code it checks — inserts a
message and a subscription, opens it, and asserts the old row is still delivered and new work
still flows.

## 3. Cancellation — done

`POST /api/messages/:seq/cancel` and `/api/deliveries/:id/cancel`, a fourth terminal status,
`extend` answering `{cancelled: true}`, `BusConsumer` aborting and neither acking nor nacking,
`--exec` killing its child.

Verified in `scripts/e2e.ts` on a **pid**, not a row: a consumer runs `exec sleep 120`, the
message is cancelled, and the check is that the process is gone. Then on the dagr side, a step
with `timeout: 3s` wrapping a 60-second remote handler — the abort crosses the bus, the delivery
reaches `cancelled`, the run fails rather than hanging, and no reply is ever recorded.

Both READMEs lost their "cancellation is one-way" sections. dagr-remote's replacement states the
remaining limit honestly: cancellation is bounded by the lease-renewal interval, so a subscription
with a ten-minute `ackWaitMs` is a consumer that can keep working for minutes after the caller
gave up.

## 4. Operability — done

- **Metrics.** `GET /metrics`, Prometheus text, admin-only. Counters in the
  store (so reclaims and sweep-time dead letters are counted, which an HTTP-layer counter would
  miss), gauges computed at scrape time. Scraped clean under load at the end of every
  `--term-bus` soak run, and by hand against the Fly deployment.
- **Graceful shutdown.** `BusServer.shutdown()`. Tested two ways: a unit test parks a
  ten-second long poll, calls `shutdown`, and asserts it returns an ordinary empty claim in under
  three seconds; and `soak --term-bus` SIGTERMs the broker mid-run, restarts it, and loses
  nothing.
- **Structured logging.** Levels and a JSON format, on stderr. Verified by running the server
  with `BUS_LOG_FORMAT=json` and reading the lifecycle lines.
- **Backup.** `bql-bus backup <dir>` via `VACUUM INTO` plus the blob directory, taken from a
  second connection while the bus serves. A test writes, backs up, writes again, then opens the
  backup and asserts it holds the first write and not the second — and that it is a working
  database, not a file, by claiming from it. Restore is documented in
  [operations.md](operations.md), including what the fleet does afterwards.

## 5. Operator surface — done

`bql-bus dlq <subscription>` and `dlq requeue <seq…>`; dashboard pause/resume, replay, purge,
and a dead-letter view with a requeue button. The injected token stays read-only; operator
actions ask for an admin token kept in `sessionStorage`.

**Verified in a real browser**, not by reading the JSX: paused a subscription and watched the
button become Resume and the API report `paused: true`; resumed it; requeued a poison message and
watched it be redelivered, fail again, and dead-letter again carrying `requeued-from`.

## 6. Packaging — done except the publish

`bunup` builds the library, Vite builds the dashboard into `dist/dashboard`, `prepack` rewrites
the manifest to `dist/` and `postpack` restores it. `bun run verify-pack` packs the tarball,
installs it into an empty temp directory, imports every advertised export, runs the installed
binary, and starts a bus and pushes a message through it from the installed copy.

**Not done: `npm publish`.** The stored npm credential is rejected —

```
$ npm whoami
npm error code E401
npm error 401 Unauthorized - GET https://registry.npmjs.org/-/whoami
```

so this needs a token the session does not have. `bql-bus`, `dagr` and `dagr-remote` are all
unclaimed on the registry. Once logged in:

```sh
cd ~/workspace/bql-bus && npm publish          # runs prepack/postpack
cd ~/workspace/dagr       && bun run prepack && cd packages/dagr-remote && npm publish
```

`dagr-remote` keeps `"bql-bus": "file:../../../bql-bus"` until there is a published version
to point at — swapping it sooner would break every install in between. That is the one-line
change to make after the first publish.

## 7. Deployment — done

`Dockerfile` and `fly.toml`. The image builds, runs as uid 1000, serves the API, the dashboard
and `/metrics`, and drains on SIGTERM — all checked locally with `docker run` before deploying.

Deployed to Fly as **`bql-bus-demo`** (`https://bql-bus-demo.fly.dev`), one machine on one
1 GB volume in `sjc`. A consumer on a laptop registered over TLS and a request round-tripped:

```
$ bql-bus request rpc.upper '"hello from a laptop"' --url https://bql-bus-demo.fly.dev
"HELLO FROM A LAPTOP"
```

It is still running and costs money. `fly apps destroy bql-bus-demo` removes it; `fly scale
count 0 --app bql-bus-demo` just stops the machine.

## Found in review, after the first pass

Two review passes over the diff turned up seven defects. The ones worth naming:

- **SIGTERM could hang forever.** An SSE stream is a response that never completes, and
  `server.stop(false)` waits for in-flight requests — so one open dashboard turned a drain into an
  indefinite wait. The request/reply long polls had the same shape for up to `maxWaitMs`.
- **A filtered log page could come back empty while matches waited behind it.** The SQL glob
  over-matches, and a single bounded read filtered the first `limit * 4` hits. A hundred
  near-misses in front of the real ones looked like "no dead letters".
- **`/metrics` leaked across workspaces.** It required only read access but rendered every
  workspace's subscription names and depths. It is admin-only now, and the reason is structural:
  the counters carry no workspace label, so a tenant-scoped scrape is not something this metric
  set can honestly serve.
- **A consumer token minted with `sub: "*"` could cancel anything an admin published**, because
  `*` is the subject an admin token publishes under.
- **Gauges for deleted subscriptions lingered forever**, because a gauge written once stays in a
  registry. They are rebuilt per scrape now.

Each has a regression test that fails against the code as it was.

## Still trusted least

Honest successors to the list in `FINISHING.md`:

- **`materialize()`** is now exercised by four soak variants under contention and has not
  misbehaved. What still has no coverage is a **very wide log** — thousands of unrelated subjects
  between two matching ones, where the `scanBatch` ceiling arithmetic decides how many rounds a
  claim takes. The correctness argument holds; the performance one is untested.
- **The blob path** is still unit tests only. It now travels the HTTP layer whenever a large body
  is published, but nothing pushes megabyte bodies through the soak, and `collectBlobs` has never
  run against a filesystem under churn.
- **Multi-workspace load.** Tenancy is enforced on every query and tested, but every soak and
  end-to-end run uses one workspace. The metrics scrape iterates all of them, which is the only
  place the count could matter.
- **Retention under a live fleet.** The sweep's guards are unit-tested; no long-running install
  has actually pruned while consumers were working.
