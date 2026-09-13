# Running AgenticBus

One process owns one SQLite file. Everything below follows from that.

## Metrics

`GET /metrics` renders Prometheus text. It needs a **read-capable token** — `admin` or `reader` —
because subject and subscription names are tenant information, so give Prometheus a long-lived
reader token rather than the admin one:

```sh
agenticbus token --consumer prometheus --reader --ttl 31536000
```

```yaml
scrape_configs:
  - job_name: agenticbus
    authorization: { credentials_file: /etc/prometheus/agenticbus.token }
    static_configs: [{ targets: ["bus.internal:4317"] }]
```

Counters accumulate as things happen; gauges are read from the store **at scrape time**, because
a gauge that is only written when something moves is stale exactly when it matters — an idle
subscription with a thousand pending deliveries would otherwise keep reporting whatever it last
reported.

| Metric | Type | Labels |
| --- | --- | --- |
| `agenticbus_messages_published` | counter | |
| `agenticbus_messages_deduplicated` | counter | |
| `agenticbus_deliveries_claimed` | counter | `subscription` |
| `agenticbus_deliveries_acked` · `_nacked` · `_dead` | counter | `subscription` |
| `agenticbus_deliveries_reclaimed` | counter | |
| `agenticbus_deliveries_cancelled` | counter | |
| `agenticbus_claim_duration` | summary (ms) | `subscription` |
| `agenticbus_subscription_lag` | gauge | `workspace`, `subscription` |
| `agenticbus_subscription_deliveries` | gauge | `workspace`, `subscription`, `status` |
| `agenticbus_subscription_paused` | gauge | `workspace`, `subscription` |
| `agenticbus_messages` · `_last_seq` | gauge | `workspace` |
| `agenticbus_consumers` · `_consumers_live` | gauge | `workspace` |

Counters reset when the process restarts, as Prometheus counters are meant to — use `rate()`.

The two alerts worth having first: `agenticbus_subscription_lag` climbing without bound (nothing
is consuming), and `agenticbus_subscription_deliveries{status="dead"}` moving at all (something is
failing every attempt).

Summaries carry `_count`, `_sum`, `_min` and `_max` rather than buckets. Bucket boundaries depend
on the workload and a wrong default is worse than an honest summary; a host that wants quantiles
should pass its own `MetricsSink` to `BusStore`.

## Health and readiness

| | |
| --- | --- |
| `GET /health` | the process is answering. `{ok, draining}` |
| `GET /ready` | it is answering **and** a consumer has checked in recently, and it is not draining |

Neither needs a token. `/ready` is what a load balancer should poll: it returns 503 while
draining, so traffic stops arriving before the process stops answering.

## Logging

`--log-level debug|info|warn|error|silent` (`BUS_LOG_LEVEL`), `--log-format text|json`
(`BUS_LOG_FORMAT`). Lines go to **stderr**, so stdout stays a data channel for the CLI.

There is deliberately no line per request. At a claim every 100ms per consumer that is the
loudest thing in the system and says the least; request detail is `debug`.

## Shutting down

SIGTERM drains:

1. The bus stops handing out work — a claim answers `[]` immediately instead of holding the
   consumer for the rest of its long poll. An empty claim is an ordinary answer, so consumers
   simply ask again.
2. Long polls already parked inside the handler return.
3. Requests still in flight finish, and only then is the database closed.

The consumer side is symmetrical: `BusConsumer.stop()` finishes its running handlers before
`start()` resolves, so a SIGTERM to a consumer does not abandon a leased message.

`bun run soak --term-bus` is the check: SIGTERM the bus in the middle of five thousand messages,
restart it, and assert nothing was lost. Messages leased when the process went down are
redelivered once their lease expires — at-least-once, working as designed.

## Backup and restore

```sh
agenticbus backup /backups/agenticbus-$(date +%F)
```

`VACUUM INTO` plus a copy of the blob directory, taken from a second connection **while the bus
keeps serving**. Copying `bus.db` on its own is the classic way to restore a database missing its
last few minutes, because the WAL holds them; `VACUUM INTO` is SQLite's supported online backup
and needs no `sqlite3` binary on the host.

Restoring is stop → replace → start, and that ordering is not negotiable: a single-writer design
cannot make a restore under a running process safe.

```sh
systemctl stop agenticbus                 # or: fly machine stop
rm -f /data/bus.db /data/bus.db-wal /data/bus.db-shm
cp /backups/2026-09-13/bus.db /data/bus.db
rm -rf /data/blobs && cp -r /backups/2026-09-13/blobs /data/blobs
systemctl start agenticbus
```

Deleting `-wal` and `-shm` matters: left behind, they belong to the *old* database and SQLite
will try to apply them to the restored one.

**What the fleet does afterwards.** Consumers do not need to be restarted and should not be.

- A consumer holding a lease the restored database has never heard of gets `stale lease` on its
  next ack. The message is redelivered from the restored state and handled again — at-least-once,
  which is the contract, and the reason `idempotencyKey` is on every envelope.
- Work published after the backup is gone. That is what "restore" means; the window is the
  backup interval, so pick it to match what you are willing to redo.
- A subscription's cursor goes back to where it was at backup time, so messages between then and
  now are re-examined. Deliveries already settled at backup time stay settled.

A message handled twice is normal here. A consumer whose effects are not idempotent is the thing
to fix before the restore, not during it.

## Capacity, honestly

One process, one file, no replication. Right for a fleet; wrong for infrastructure a dozen
services depend on. The store sits behind a seam so replacing it is a swap rather than a rewrite,
but nothing here pretends to be a replicated log.

Two settings are worth knowing:

- `--retention-ms` prunes messages older than it, but only where every subscription has moved
  past them and none has an unfinished delivery. **An install with no subscriptions prunes
  nothing**, deliberately: a message nobody has subscribed to yet has not been examined, only
  ignored.
- `ttlMs` on a publish deletes the message when it expires, even if nobody consumed it — but
  never while a handler holds it, which would leave a consumer acking a delivery that no longer
  exists.
