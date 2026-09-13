# Running AgenticBus

One process owns one SQLite file. Everything below follows from that.

## Metrics

`GET /metrics` renders Prometheus text. **An admin token scrapes the install; a workspace-pinned
`reader` token scrapes only its own workspace.**

The counters carry a `workspace` label, so a tenant scrape is a filter on the way out rather than
a second registry to keep in step. A tenant does *not* get the install-wide numbers — database,
WAL and free-disk bytes belong to the process, not to any tenant — and a `consumer` token gets
nothing at all, because observing is a read.

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
| `agenticbus_messages_published` · `_deduplicated` · `_requeued` | counter | `workspace` |
| `agenticbus_deliveries_claimed` · `_acked` · `_nacked` · `_dead` | counter | `workspace`, `subscription` |
| `agenticbus_deliveries_ack_replayed` | counter | `workspace`, `subscription` |
| `agenticbus_deliveries_acked_with_publish` · `_acked_transactional` | counter | `workspace`, `subscription` |
| `agenticbus_deliveries_reclaimed` · `_cancelled` | counter | `workspace` |
| `agenticbus_keys_blocked` · `agenticbus_subscriptions_quarantined` | counter | `workspace`, `subscription` |
| `agenticbus_effects_claimed` · `_recorded` · `_replayed` · `_retried` | counter | |
| `agenticbus_schema_violations` | counter | `workspace`, `schema`, `mode` |
| `agenticbus_blobs_unreadable` | counter | `workspace`, `subscription` |
| `agenticbus_publish_duration` · `agenticbus_ack_duration` | summary (ms) | `workspace` |
| `agenticbus_claim_duration` | summary (ms) | `workspace`, `subscription` |
| `agenticbus_delivery_age` | summary (ms) | `workspace`, `subscription` |
| `agenticbus_message_age_at_ack` | summary (ms) | `workspace`, `subscription` |
| `agenticbus_subscription_lag` | gauge | `workspace`, `subscription` |
| `agenticbus_subscription_deliveries` | gauge | `workspace`, `subscription`, `status` |
| `agenticbus_subscription_oldest_pending_age_ms` | gauge | `workspace`, `subscription` |
| `agenticbus_subscription_in_flight` · `_dlq_depth` | gauge | `workspace`, `subscription` |
| `agenticbus_subscription_paused` | gauge | `workspace`, `subscription` |
| `agenticbus_messages` · `_last_seq` | gauge | `workspace` |
| `agenticbus_workspace_bytes` · `_quota_bytes` · `_quota_messages` | gauge | `workspace` (only where a quota is set) |
| `agenticbus_consumers` · `_consumers_live` | gauge | `workspace` |
| `agenticbus_db_bytes` · `_wal_bytes` · `_disk_free_bytes` · `_writable` | gauge | — (admin scrape only) |
| `agenticbus_blobs_missing` | gauge | |
| `agenticbus_replication_lag_seq` · `_lag_ms` | gauge | — (on a follower) |

Counters reset when the process restarts, as Prometheus counters are meant to — use `rate()`.

The alerts worth having, in the order you will want them:

1. `agenticbus_subscription_oldest_pending_age_ms` above what the work is allowed to wait. Depth
   tells you how much is queued; **age** tells you how long the front of the queue has been
   there, which is the number a person actually cares about.
2. `agenticbus_subscription_deliveries{status="dead"}` moving at all — something is failing every
   attempt.
3. `agenticbus_writable == 0` or `agenticbus_disk_free_bytes` near the watermark. Publishes are
   already being refused with 507 at that point.
4. `agenticbus_replication_lag_seq` above the RPO you are willing to state. That gauge *is* the
   promise.
5. `agenticbus_subscription_lag` climbing without bound — nothing is consuming.

Summaries carry `_count`, `_sum`, `_min` and `_max` rather than buckets. Bucket boundaries depend
on the workload and a wrong default is worse than an honest summary; a host that wants quantiles
should pass its own `MetricsSink` to `BusStore`.

## Health and readiness

| | |
| --- | --- |
| `GET /health` | the process is answering. `{ok, draining}` |
| `GET /ready` | it is answering **and** a consumer has checked in recently, and it is not draining |

Neither needs a token.

`/ready` is the one a **load balancer** should poll, because it returns 503 while draining, so
traffic stops arriving before the process stops answering. It is the wrong check for a platform
that **restarts** on failure: "no consumer has checked in" is true of a freshly deployed bus that
is working perfectly. Give the platform `/health`, and alert on `/ready` from your own
monitoring, where "nobody is consuming" is the thing you actually want to hear about.

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

The consumer side **hands work back** rather than merely finishing. `BusConsumer.stop()` aborts
in-flight handlers and nacks their deliveries with *no* delay, so another consumer picks them up
at once; letting the leases expire instead costs one `ackWaitMs` of dead time per in-flight
message on every deploy, for nothing. `stop({ abandon: false })` is the other reasonable choice —
finish what is running, claim nothing new — for handlers that are short and not safe to
interrupt.

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
agenticbus restore /backups/2026-09-13 --data /data
systemctl start agenticbus
```

`restore` does the whole thing — copies the snapshot and the blob directory, removes the `-wal`
and `-shm` left over from the *old* database (which SQLite would otherwise try to apply to the
restored one), and then **opens the result** and reports what it found. A snapshot that cannot be
migrated, or a blob directory that did not come along, fails here rather than during an incident.
It refuses to overwrite a database that is already there unless you pass `--force`.

```
$ agenticbus restore /backups/2026-09-13 --data /data
{"data":"/data","lastSeq":48213,"messages":48213,"subscriptions":4,"blobsMissing":0}
```

**Point in time.** A restore can stop short of the end of the snapshot's log, which is what you
want when the thing to undo is a batch somebody published rather than a disk that died:

```sh
agenticbus restore /backups/2026-09-13 --data /data --until-seq 48120
agenticbus restore /backups/2026-09-13 --data /data --until-time '2026-09-13T09:15:00Z'
```

Messages past the cut are removed, their unfinished deliveries go with them, and every
subscription cursor is pulled back to the new head — a cursor past the end of the log would
silently skip everything published after the recovery point.

What this is *not*: replay from an archive of shipped log segments. The log written after a
snapshot lives on whatever was following the leader at the time, which is what
`agenticbus follow` is for.

`bun run drill:restore` is the check, and it is the reason any of this is believable: it
publishes — including a body large enough to go to a blob — backs up, **wipes the data
directory**, restores, and compares the log, the cursors and the blob bytes. A backup nobody has
restored is a file, not a backup.

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

## Deploying

A `Dockerfile` and a `fly.toml` are in the repo. The image bakes the dashboard in, runs as an
unprivileged user, and takes SIGTERM as a drain signal.

```sh
fly apps create my-bus
fly volumes create agenticbus_data --size 1 --region sjc --app my-bus
fly secrets set BUS_SIGNING_KEY=$(openssl rand -base64 32) \
                BUS_ADMIN_TOKEN=$(openssl rand -base64 32) --app my-bus
fly deploy --app my-bus
```

Two things about the posture are deliberate.

**The bus still binds loopback by default.** A container has to bind `0.0.0.0` to receive
anything at all, so the image sets `BUS_HOST=0.0.0.0` explicitly and the platform terminates TLS
in front of it. Running the binary outside a container gets the safe default.

**One machine, one volume, `strategy = "immediate"`.** A rolling deploy would briefly run two
processes against one SQLite file, which is the one thing the design rules out. The cost is a
few seconds of downtime per deploy; consumers reconnect on their own, since a failed claim is
retried a second later.

Secrets, not `[env]`: without them the bus generates a signing key and admin token into
`BUS_STATE` at mode 0600 on first boot, which works and persists on the volume — but then the
only way to read the admin token is to shell into the machine.

A remote consumer needs only the URL and a scoped token:

```sh
BUS_URL=https://my-bus.fly.dev \
BUS_TOKEN=$(agenticbus token --consumer laptop-1 --subscribe rpc) \
  agenticbus consume rpc --exec ./handle.sh
```

## Continuity

```sh
# on the replica
agenticbus follow https://bus.internal:4317 --data /replica --port 4317
```

A follower pulls `/api/log?after=N` and the subscription cursors and applies them, keeping the
original sequence numbers. It serves **reads** and refuses writes — being a follower is recorded
in the database, not in a flag that can disagree with it, so it survives a restart.

What is replicated is the **bus log**, not the SQLite WAL. The bus already is a log with a
monotonic `seq`, so this survives a schema change on either side, needs no frame parsing, and is
a file rather than a project. Delivery and lease rows are deliberately *not* replicated: leases
are ephemeral and meaningless on another machine, and a promoted follower re-materializes
deliveries from the cursors through the same code path a cold start uses.

**Failover is fenced.** Both nodes must be able to see one lease object:

```sh
agenticbus serve  --data /data     --lease /shared/agenticbus.lease   # the leader
agenticbus promote --data /replica --lease /shared/agenticbus.lease   # the new one
```

`promote` acquires the lease, and the epoch it grants is stamped into the replica's database. The
old leader — running with the same `--lease` — polls it, sees the epoch has moved past its own,
and **stops accepting writes**, saying so loudly. It does not exit: a process that vanishes takes
its in-flight acks with it. Split brain is prevented by the fence, not by hoping the old node is
dead.

The file lease is compare-and-set over read-then-write, which is correct on a filesystem both
machines genuinely share. For object storage, implement the `Lease` interface with a conditional
put — the seam is the point.

**The RPO is a number.** Replication is asynchronous, so a failover loses up to the current lag:

| | |
| --- | --- |
| `agenticbus_replication_lag_seq` | messages the replica has not applied |
| `agenticbus_replication_lag_ms` | how old the newest applied message is |

`bun run drill:failover` promotes under continuous publish and prints the RPO it measured; on a
laptop that is **tens of messages**. Alert on the gauges. Whatever number you tolerate is the
promise you are making to whoever publishes.

This buys continuity and read scale-out. It does **not** buy write scale-out — there is still one
writer — and it is not consensus.

## Running out of disk

`SQLITE_FULL` used to arrive as a 500 from whichever statement happened to need a page, while the
bus went on accepting publishes it could not keep. Now there is a watermark, default 64 MiB,
settable with `--min-free-bytes`:

- `POST /api/publish` answers **507** with the numbers in the message.
- `/ready` answers 503 with `reason: disk-full`, so a load balancer stops sending producers here.
- **Claims, acks and nacks keep working**, because a full disk is exactly when consumers need to
  be able to drain.

Losing writes loudly beats a crash loop. `agenticbus_writable` is the gauge.

The WAL has a ceiling too: `wal_autocheckpoint`, plus a `wal_checkpoint(TRUNCATE)` on the sweep
once `-wal` passes `--wal-checkpoint-bytes` (8 MiB by default). The truncate is best-effort — a
long-lived reader will block it, and that reader is the reason the file grew; blocking *it* would
trade a disk problem for a correctness-shaped one.

## Rate limits and quotas

All off by default. A limit set without knowing the workload is how a healthy fleet gets
throttled at 3am.

```sh
agenticbus serve --publish-rate 500 --claim-rate 200 --max-polls 8
agenticbus quota set --messages 1000000 --bytes 10000000000 --subscriptions 50 --workspace acme
```

Limits are per **token subject**, in memory, per process. They answer 429 with `Retry-After`.
Quotas are checked against usage read fresh rather than a counter, because a counter and a
retention sweep disagree the moment anything is deleted, and a quota that drifts upward is not a
quota.

## Keys, revocation and the audit trail

```sh
agenticbus keys rotate                 # a new active key; the old one still verifies
agenticbus keys retire k1              # once tokens signed by k1 have expired
agenticbus revoke <jti>                # withdraw one token
agenticbus audit --limit 100           # who did what
```

Rotation has an overlap window on purpose: it used to be the only revocation mechanism, so it had
to be possible without invalidating every token in the fleet at one instant. Revocation is a
local index probe on the hot path — no network — and an entry is dropped by the sweep once the
token it names would have expired anyway.

## Capacity, honestly

One writer, one file. Right for a fleet; for infrastructure a dozen services depend on it is a
deliberate trade — asynchronous replication, an RPO you have to state, and a failover that needs
a fence. The store sits behind a seam so replacing it is a swap rather than a rewrite.

Two settings are worth knowing:

- `--retention-ms` prunes messages older than it, but only where every subscription has moved
  past them and none has an unfinished delivery. **An install with no subscriptions prunes
  nothing**, deliberately: a message nobody has subscribed to yet has not been examined, only
  ignored.
- `ttlMs` on a publish deletes the message when it expires, even if nobody consumed it — but
  never while a handler holds it, which would leave a consumer acking a delivery that no longer
  exists.
