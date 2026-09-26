# Finishing bql.sh/bus: the decisions

Status: implemented. Companion to [the design](2026-09-12-message-bus.md), which stays the
authority on *what the bus is*. This one records the decisions taken while closing the list in
[`docs/FINISHING.md`](../../FINISHING.md) — schema versioning, cancellation, operability, the
operator surface, packaging, deployment — and why each is shaped the way it is.

## 1. Proving the concurrency claims

Every existing test drove a single writer deterministically, so nothing had exercised many
consumers racing on one subscription. `scripts/soak.ts` is the answer: real OS processes, real
HTTP, randomly SIGKILLed.

The assertions are chosen so they can only pass for the right reason:

| Property | How it is checked |
| --- | --- |
| handled **at least** once | each consumer appends `{seq, key, at}` to its own JSONL receipt file; the union must cover every published seq |
| acked **exactly** once | `UNIQUE(subscription_id, message_seq)` makes two acks of one message unrepresentable, so the check is that the count of `acked` deliveries equals the message count |
| nothing stuck | `pending` and `leased` are both zero once the run drains |
| no surprise dead letters | `dead` is zero, with `maxAttempts` set high enough that kills alone cannot exhaust it |
| per-key FIFO (`--ordered`) | receipts grouped by key must be non-decreasing in seq — a redelivery may repeat a seq, but may never go backwards |
| the bus itself can die | `--kill-bus` SIGKILLs the broker mid-flight and restarts it on the same file; the log must still hold every message and the run must still drain |
| a deploy loses nothing | `--term-bus` SIGTERMs it instead, so the drain path is exercised rather than WAL recovery, and `/metrics` is scraped afterwards and must parse |

A killed consumer is restarted under **the same id**, because that is the interesting path: the
dead process's lease has to expire and be reclaimed, rather than the work quietly moving to a
fresh name.

Receipts are files rather than messages on a `receipts.>` subject: a receipt that goes through
the bus is a second thing that can fail, and it would double the load being measured.

Kills are paced by **wall-clock**, not by the message count. The first version derived the
spacing from the workload, which put most kills after the run had already drained — it passed
while proving nothing, and the tell was that 12 kills produced one redelivery.

## 2. Schema versioning

`migrate()` was `CREATE TABLE IF NOT EXISTS` with no version table, so the first schema change to
a deployed bus would have been a silent corruption or a crash.

- `schema_version(version INTEGER PRIMARY KEY, applied_at)` — one row per applied migration, not
  a single mutable row, so the history is legible in the database itself.
- `MIGRATIONS` is an ordered array of `{version, statements}`. Applying is: read `MAX(version)`,
  run everything above it, each migration in its own transaction.
- **Opening a database newer than the code is refused.** A binary rolled back onto a database a
  newer binary wrote cannot know what the extra columns mean, and guessing is how data is lost.
- Version 1 is the schema as it already existed in the wild, so a database written before this
  change adopts version 1 without being rewritten: the marker is "tables exist but no
  `schema_version`". That is the case `tests/migrations.test.ts` covers by building the old
  schema by hand and opening it.

## 3. Cancellation

The gap `dagr-remote` needed most: an abandoned caller left its consumer running to completion.

**A fourth terminal delivery status, `cancelled`.** Not a flag beside `status`: a flag means every
query that filters on status has to remember to also check the flag, and one that forgets
re-delivers cancelled work. As a status it is unrepresentable to lease.

**Cancellation is addressed at the message, and the delivery is the narrow case.**
`POST /api/messages/:seq/cancel` stamps `messages.cancelled_at` and cancels every unfinished
delivery of it; `POST /api/deliveries/:id/cancel` cancels one delivery without touching the
message, which is what you want when one subscription's copy is wrong and the others are fine.
Stamping the message matters because a subscription whose cursor has not reached the message yet
would otherwise materialize a delivery for it *after* the cancel — so `materialize()` skips
messages with `cancelled_at` set, while the cursor still advances over them.

**Authorization is admin or the publisher.** That means the publisher has to be recorded, so
`messages.publisher` now holds the token subject that published it (migration 2). An admin token
publishes as `*`, which nothing else can match.

**The consumer learns on its next `extend`**, which returns `{cancelled: true}` instead of
throwing `stale lease`. `BusConsumer` aborts the handler's signal with a `CancelledError`, and —
this is the part worth stating — then acks and nacks *nothing*. The delivery is already in a
terminal state; a nack would fail as a stale lease and a retry would be wrong anyway. The
`--exec` handler passes that signal to `Bun.spawn`, so the child process actually dies, which is
what the end-to-end check asserts by watching a pid.

`dagr-remote`'s `remoteExecutor` cancels on `ctx.signal`: its response wait now passes the signal
down into `fetch`, and an abort triggers `bus.cancelMessage(seq)` before rethrowing. The
checkpoint therefore carries `{correlation, seq}` rather than just the correlation, so an engine
that restarts and is then cancelled still knows what to cancel.

## 4. Operability

**Metrics.** `src/bus/metrics.ts` is the same `MetricsSink` shape dagr uses — `counter`, `gauge`,
`histogram` — with a Prometheus renderer behind it. Copied rather than imported: the bus must
never depend on dagr, and a 120-line sink is a cheaper price than that dependency.

Counters are incremented as things happen; gauges are computed at scrape time from `stats()` for
every workspace, because a gauge that is only written when something moves is stale exactly when
you need it. `/metrics` is **admin-only**: the gauges span every workspace and the counters carry
no workspace label at all, so a tenant-scoped scrape is not something this metric set can honestly
serve, and giving a workspace-pinned reader token the whole install would have been a quiet
tenancy leak.

**Graceful shutdown.** `createServer` now returns a `BusServer` with `shutdown()`. SIGTERM:
set `draining`, at which point `claim` returns `[]` immediately rather than long-polling, wait
for the in-flight long polls already inside the handler to return, `server.stop(false)` so open
requests finish, then close the store. The previous shutdown stopped the server and closed the
store under live long polls; only the abort guard inside the claim loop made that survivable.

**Structured logging.** `src/bus/log.ts`: levels `debug|info|warn|error`, `json` or `text`
format, `--log-level` / `BUS_LOG_LEVEL`. The bus logs one line per lifecycle event and one per
500; it deliberately does not log a line per request, because at a claim every 100ms per consumer
that is the loudest thing in the system and says the least.

**Backup.** `VACUUM INTO` rather than a filesystem copy: it is SQLite's supported online backup,
it is consistent under WAL without stopping writes, and it needs no `sqlite3` binary. `bql-bus
backup <dir>` writes `bus.db` plus a copy of the blob directory. Restore is documented as
stop → replace → start, because a restore under a running process is the one thing a
single-writer design cannot make safe.

## 5. Operator surface

**The dashboard's injected token stays read-only.** "A page that can be opened is not a page that
can dispatch work" was the right call and survives. Operator actions instead ask for an admin
token, held in `sessionStorage` for that tab only, and the operator controls do not render until
one is present. The alternative — a fourth `operator` scope — adds a permission axis to every
route to save one paste.

**DLQ as an ordinary subject, still.** Listing a DLQ is `GET /api/log?subject=<pattern>`; a
requeue is `POST /api/messages/:seq/requeue`, which republishes the body onto the `dlq-subject`
header with the `dlq-*` headers stripped and `requeued-from` added. No new storage, and a requeued
message is an ordinary new message with its own seq — so if it fails again it dead-letters again,
which is the honest outcome.

## 6. Packaging

`bunup` for the library (matching dagr), `vite` for the dashboard. They collided on `dist/`, so
the dashboard moved to `dist/dashboard/` and the bus's default `--assets` moved with it.
`scripts/prepack.ts` rewrites the source-pointing manifest to `dist/` at publish time, the same
trick dagr uses, so the checked-out repo keeps running straight from TypeScript.

`scripts/verify-pack.ts` is the gate: `bun pm pack`, install the tarball into a temp directory,
import every advertised entry point and run the binary. A bundler can drop a module and still
emit its name in the export list; this is what makes that fail here instead of in someone's
install.

## 7. Deployment

A Dockerfile on the Bun image and a `fly.toml` for one machine on one volume — the same posture
as dagr, for the same reason: one process owns one SQLite file.

The bus stays **loopback-bound by default**. Containers have to bind `0.0.0.0` to receive traffic
at all, so that is an explicit `BUS_HOST=0.0.0.0` in the image's environment rather than a changed
default, and the platform terminates TLS in front of it. `BUS_STATE` is the other half: a
container relocates the signing key, admin token, database and blobs onto its volume without
rewriting the command line.

The platform health check is `/health` alone. `/ready` also requires that a consumer has checked
in recently — a genuine signal, and the wrong one for a check that restarts the machine, because
a freshly deployed bus with no consumers yet is healthy rather than broken.

Deployed and checked: `bql-bus-demo.fly.dev`, with a consumer on a laptop registering over TLS
and a request round-tripping through it.

## What is not done

**Publishing to npm.** Everything up to it is: the build, the manifest rewrite, and
`verify-pack`, which packs the tarball, installs it into an empty directory, imports every
advertised entry point and runs a bus out of the installed copy. The publish itself needs a
credential — the stored npm token is rejected with a 401 — so it is one command away rather than
done. `dagr-remote` keeps its `file:` link to this repo until there is a published version to
point at; swapping it sooner would break every install in the meantime.

## What did not change

Replication, failover, multi-writer. Exactly-once delivery. Message schemas, a registry, priority
classes, hierarchical workspaces. Nothing in the core learned what a workflow or an agent is.
