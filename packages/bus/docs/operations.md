# Running bql.sh/bus

The bus keeps its tables in one bql.sh database, `bus`, under `--data`. One node writes it: the
only node on a single-node bus, the primary of `bus` on a cluster. Everything below follows from
that.

## Data layout

`--data` (`BUS_DATA`, default `.bql-bus`) is bql.sh's data directory. The bus keeps its own keys
in `bus/` inside it:

```
/data
  _system.db              bql.sh's catalog
  keys.json               bql.sh's own keys
  dbs/…/bus/              database "bus": main.db, its WAL, its log
  bus/keys.json           the bus's signing keyring (0600)
  bus/admin-token         the bus's admin token (0600)
```

`bql bus serve`, `bql bus serve --cluster` and `bql serve --bus` all use it. `--database` (or
`BUS_DATABASE`) names another database than `bus`. `BUS_SIGNING_KEY` and `BUS_ADMIN_TOKEN`
override the two files. `--config bql.toml` hands any other bql.sh setting to the engine, such as
`[s3]`.

A single node (`bql bus serve --data /data --port 4317`) opens no bql.sh listener: the bus is the
only thing serving, at the root of `--port`, and the only thing writing database `bus`.
`--ack` sets what a publish waits for, `fsync` by default.

## Metrics

`GET /metrics` renders Prometheus text. **An admin token scrapes the install; a workspace-pinned
`reader` token scrapes only its own workspace.**

The counters carry a `workspace` label, so a tenant scrape is a filter on the way out rather than
a second registry to keep in step. A tenant does *not* get the install-wide numbers — database,
WAL and free-disk bytes belong to the process, not to any tenant — and a `consumer` token gets
nothing at all, because observing is a read.

```yaml
scrape_configs:
  - job_name: bql-bus
    authorization: { credentials_file: /etc/prometheus/bql-bus.token }
    static_configs: [{ targets: ["bus.internal:4317"] }]
```

Counters accumulate as things happen; gauges are read from the store **at scrape time**, because
a gauge that is only written when something moves is stale exactly when it matters — an idle
subscription with a thousand pending deliveries would otherwise keep reporting whatever it last
reported.

| Metric | Type | Labels |
| --- | --- | --- |
| `bql_bus_messages_published` · `_deduplicated` · `_requeued` | counter | `workspace` |
| `bql_bus_deliveries_claimed` · `_acked` · `_nacked` · `_dead` | counter | `workspace`, `subscription` |
| `bql_bus_deliveries_ack_replayed` | counter | `workspace`, `subscription` |
| `bql_bus_deliveries_acked_with_publish` · `_acked_transactional` | counter | `workspace`, `subscription` |
| `bql_bus_deliveries_reclaimed` · `_cancelled` | counter | `workspace` |
| `bql_bus_keys_blocked` · `bql_bus_subscriptions_quarantined` | counter | `workspace`, `subscription` |
| `bql_bus_effects_claimed` · `_recorded` · `_replayed` · `_retried` | counter | |
| `bql_bus_schema_violations` | counter | `workspace`, `schema`, `mode` |
| `bql_bus_blobs_unreadable` | counter | `workspace`, `subscription` |
| `bql_bus_publish_duration` · `bql_bus_ack_duration` | summary (ms) | `workspace` |
| `bql_bus_claim_duration` | summary (ms) | `workspace`, `subscription` |
| `bql_bus_delivery_age` | summary (ms) | `workspace`, `subscription` |
| `bql_bus_message_age_at_ack` | summary (ms) | `workspace`, `subscription` |
| `bql_bus_subscription_lag` | gauge | `workspace`, `subscription` |
| `bql_bus_subscription_deliveries` | gauge | `workspace`, `subscription`, `status` |
| `bql_bus_subscription_oldest_pending_age_ms` | gauge | `workspace`, `subscription` |
| `bql_bus_subscription_in_flight` · `_dlq_depth` | gauge | `workspace`, `subscription` |
| `bql_bus_subscription_paused` | gauge | `workspace`, `subscription` |
| `bql_bus_messages` · `_last_seq` | gauge | `workspace` |
| `bql_bus_workspace_bytes` · `_quota_bytes` · `_quota_messages` | gauge | `workspace` (only where a quota is set) |
| `bql_bus_consumers` · `_consumers_live` | gauge | `workspace` |
| `bql_bus_db_bytes` · `_wal_bytes` · `_disk_free_bytes` · `_writable` | gauge | — (admin scrape only) |
| `bql_bus_blobs_missing` | gauge | |

Counters reset when the process restarts, as Prometheus counters are meant to — use `rate()`.

The alerts worth having, in the order you will want them:

1. `bql_bus_subscription_oldest_pending_age_ms` above what the work is allowed to wait. Depth
   tells you how much is queued; **age** tells you how long the front of the queue has been
   there, which is the number a person actually cares about.
2. `bql_bus_subscription_deliveries{status="dead"}` moving at all — something is failing every
   attempt.
3. `bql_bus_writable == 0` or `bql_bus_disk_free_bytes` near the watermark. Publishes are
   already being refused with 507 at that point.
4. On a cluster, bql.sh's own replication metrics on the node holding `bus` (its `/metrics`):
   a replica falling behind is what turns `ack: "replica"` publishes into `ACK_TIMEOUT`.
5. `bql_bus_subscription_lag` climbing without bound — nothing is consuming.

Summaries carry `_count`, `_sum`, `_min` and `_max` rather than buckets. Bucket boundaries depend
on the workload and a wrong default is worse than an honest summary; a host that wants quantiles
should pass its own `MetricsSink` to `BusStore`.

## Health and readiness

| | |
| --- | --- |
| `GET /health` | the process is answering. `{ok, draining, role}`, `role` being `primary` or `replica` |
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

The bus has no backup command of its own. Database `bus` is a bql.sh database, so it is backed up
by bql.sh's S3 shipping and restored by `bql restore`.

**Shipping.** Name a bucket in `--config` (`[s3]`) or in the environment, and the bus ships every
commit to it as it happens, with snapshots on bql.sh's schedule:

```sh
export BQL_S3_URL=s3://backups/bus BQL_S3_ENDPOINT=https://s3.example.com BQL_S3_REGION=auto
export BQL_S3_ACCESS_KEY_ID=… BQL_S3_SECRET_ACCESS_KEY=…   # or Bun's AWS_* / S3_*
bql bus serve --data /data
```

SIGTERM ships whatever is outstanding before the process exits. Large bodies are rows in
`blobs_data`, so they go with everything else; there is no second directory to copy. On a cluster
the primary of `bus` ships; put the same `[s3]` on every node so whichever holds it does.

**Restoring** goes into an empty data directory, through a bql.sh node that reads the bucket and
does not ship to it:

```sh
BQL_S3_ENABLED=false BQL_S3_URL=s3://backups/bus BQL_S3_ENDPOINT=https://s3.example.com \
  bql serve --dir /restored --port 4500 --admin-key "$KEY" &
bql restore bus --from s3://backups/bus --into bus --url http://127.0.0.1:4500 --token "$KEY"
# restored bus from s3://backups/bus into bus at txid 29 (29 record(s) from 2 object(s))
kill %1
bql bus serve --data /restored
```

`--at <txid|time>` on `bql restore` stops short of the end, for when the thing to undo is a batch
somebody published rather than a disk that died. Messages past that point are not in the restored
database, and their deliveries and cursor moves are not either, because every table was restored
to the same transaction.

**Point in time without a bucket.** `bql restore --at` without `--from` reads the local log, so
it reaches back only as far as the log bql.sh still holds. Stop the bus, restore into a second
database beside the first, and serve that one:

```sh
bql serve --dir /data --port 4500 --admin-key "$KEY" &
bql restore bus --at '2026-09-13T09:15:00Z' --into bus-restored --url http://127.0.0.1:4500 --token "$KEY"
kill %1
bql bus serve --data /data --database bus-restored
```

`bql backup status bus` and `bql backup verify bus` need a bql.sh listener, which `bql serve --bus`
has and a single-node `bql bus serve` does not; run them against a `bql serve` on the same
directory while the bus is stopped, or run the bus under `bql serve --bus`.

`bun run drill:restore` is the check: it publishes twenty messages (one with a 200 KB body),
moves a cursor, stops the bus so it ships, restores into an empty directory with the commands
above, starts the bus there and compares the log, the cursor, the acked count and the large body.
It uses an in-process fake bucket unless `BQL_S3_URL` and its credentials are set; it has been run
against RustFS.

**What the fleet does afterwards.** Consumers do not need to be restarted and should not be.

- A consumer holding a lease the restored database has never heard of gets `stale lease` on its
  next ack. The message is redelivered from the restored state and handled again: at-least-once,
  which is the contract, and the reason `idempotencyKey` is on every envelope.
- Work published after the restore point is gone. That is what "restore" means.
- A subscription's cursor goes back to where it was at the restore point, so messages between
  then and now are re-examined. Deliveries already settled at that point stay settled.

A message handled twice is normal here. A consumer whose effects are not idempotent is the thing
to fix before the restore, not during it.

## Deploying

A `Dockerfile` and a `fly.toml` are in the repo. The image bakes the dashboard in, runs as an
unprivileged user, and takes SIGTERM as a drain signal. It also builds the pinned libsqlite3 the
store opens its database through (`bun run db sqlite:build`, in the build stage), so it does not
depend on the base image having one.

Both build from the **repository root**, not from `packages/bus`, because the SQLite driver and
its build script live in `packages/db`. `packages/bus/Dockerfile.dockerignore` keeps the context
to what the image needs.

```sh
docker build -f packages/bus/Dockerfile -t bql-bus .
docker run -p 4317:4317 -v bql-bus-data:/data bql-bus
```

```sh
fly apps create my-bus
fly volumes create bql_bus_data --size 1 --region sjc --app my-bus
fly secrets set BUS_SIGNING_KEY=$(openssl rand -base64 32) \
                BUS_ADMIN_TOKEN=$(openssl rand -base64 32) --app my-bus
fly deploy . --config packages/bus/fly.toml --app my-bus   # from the repository root
```

Two things about the posture are deliberate.

**The bus still binds loopback by default.** A container has to bind `0.0.0.0` to receive
anything at all, so the image sets `BUS_HOST=0.0.0.0` explicitly and the platform terminates TLS
in front of it. Running the binary outside a container gets the safe default.

**One machine, one volume, `strategy = "immediate"`.** A rolling deploy would briefly run two
processes against one data directory, which is the one thing the design rules out. The cost is a
few seconds of downtime per deploy; consumers reconnect on their own, since a failed claim is
retried a second later.

Secrets, not `[env]`: without them the bus generates a signing key and admin token into
`/data/bus` at mode 0600 on first boot, which works and persists on the volume, but then the only
way to read the admin token is to shell into the machine. The `BQL_S3_*` settings above go in as
secrets too.

A remote consumer needs only the URL and a scoped token:

```sh
BUS_URL=https://my-bus.fly.dev \
BUS_TOKEN=$(bql bus token --consumer laptop-1 --subscribe rpc) \
  bql bus consume rpc --exec ./handle.sh
```

## A three-node bus

Every node runs the same command with its own `--node`, `--port`, `--data` and the other two as
`--peers`. The keys **must** be identical on every node, or a token minted on one is a 401 on the
next; a clustered node generates none and refuses to start without them.

```sh
export BUS_CLUSTER_SECRET=$(openssl rand -base64 32)   # bql.sh node-to-node: Raft and WAL shipping
export BUS_SIGNING_KEY=$(openssl rand -base64 32)      # bus tokens
export BUS_ADMIN_TOKEN=$(openssl rand -base64 32)

# on 10.0.0.1
bql bus serve --cluster --node n1 --host 0.0.0.0 --port 4321 --data /data \
  --advertise ws://10.0.0.1:4321 --ack replica \
  --peers n2=ws://10.0.0.2:4321,n3=ws://10.0.0.3:4321
# on 10.0.0.2 and 10.0.0.3: --node n2 / n3, their own --advertise, the other two as --peers
```

Instead of the environment, `keys.json` and `admin-token` can be copied into every node's
`<data>/bus/`. `--config bql.toml` passes any other bql.sh setting through: lease timings
under `[cluster]`, S3 shipping under `[s3]`. `--rf` is how many nodes hold a copy, every node by
default; a node with no copy answers `NOT_PRIMARY` and points at the primary. Bodies over 64 KiB
live in `blobs_data`, so they replicate with everything else.

The same node from bql.sh's side, with the bus keys in `<data>/bus/` unless `[bus] data` says
otherwise:

```toml
# bql.toml
[server]
port = 4321
node = "n1"

[replication]
secret = "${BQL_CLUSTER_SECRET}"

[cluster]
enabled = true
id = "n1"
advertise = "ws://10.0.0.1:4321"
peers = ["n2=ws://10.0.0.2:4321", "n3=ws://10.0.0.3:4321"]
bootstrap = true
rf = 3

[bus]
enabled = true
ack = "replica"
```

```sh
bql serve --config bql.toml          # or --bus without the [bus] table
```

### Startup

Nodes can start in any order. Each waits until all three have joined the Raft group, then the node
placement names creates `bus`, claims its lease and runs the migrations; the others wait for their
copy to arrive and open it read-only. Until a node's bus is open it answers `NOT_PRIMARY`. A
publish at `ack: "replica"` in the first second or two can answer `NO_REPLICAS`: the database
exists before a replica is streaming it.

### Which node is primary

```sh
curl -s http://10.0.0.2:4321/bus/health
# {"ok":true,"draining":false,"role":"replica"}
bql cluster --url http://10.0.0.2:4321      # bql.sh's view: primary, replicas, acked txids, lease
```

A replica answers every write with `503 {"code":"NOT_PRIMARY","primary":"http://10.0.0.1:4321/bus"}`
and the same URL in `BQL-Primary`. Point clients at all three (`BusClient({ url: [...] })`,
`--url a,b,c`); they follow the header. A load balancer in front should send everything to any
healthy node: reads are answered locally, writes are redirected.

### When the primary dies

Nothing to do. Its bql.sh lease lapses after `[cluster] leaseTtlMs` (3 s by default), the Raft
leader grants it to the replica with the most applied (judged among every node but the lapsed
primary, whose last commit may never have left it), and that node's bus migrates,
starts the sweep and the scheduler and reloads its caches. Leases taken on the old primary keep
their generation: a consumer's renew or ack lands on the new primary. Expired ones are reclaimed
by the sweep. A long poll parked on the old primary answers `NOT_PRIMARY` and the client asks
again. The other replicas keep their copies and follow the new primary from their own position;
nothing re-snapshots `bus`.

What a client sees during it: requests to the dead node are refused and move on; a `replica`
publish in the few milliseconds before the other survivor follows the new primary is
`NO_REPLICAS`, which the client waits out for up to `failoverMs` (15 s), with one URL or several; a request that was
in flight when it died fails (`ECONNRESET`) and is not resent unless it is a read or a publish with
a `dedupeKey`. With `--ack replica` every publish answered 2xx is on a replica, so the RPO is 0.
`ACK_TIMEOUT` means the message committed on the primary but no replica confirmed it in
`[replication] ackTimeoutMs`; it is in the log unless that primary dies before shipping it.

`bun run drill:failover` does this with three processes and a SIGKILL and prints the numbers:
2 to 3.4 s from the kill to the first acknowledged publish, and zero acknowledged publishes lost
in every run so far.

### Bringing the old node back

Start it with the same command. It rejoins Raft, finds another node holding `bus`, and follows it:
bql.sh fences the old copy by epoch and re-snapshots it if it diverged. It does not take the
primary back.

### Limits

One writer: publish throughput is one node's. A node that loses its disk is a node to re-add, not
to restore; S3 shipping (`[s3]` in `--config`) is the backup. `bql bus keys rotate` writes the
local `keys.json` only, so rotate on every node, or manage keys through `BUS_SIGNING_KEY`.

## Running out of disk

`SQLITE_FULL` used to arrive as a 500 from whichever statement happened to need a page, while the
bus went on accepting publishes it could not keep. Now there is a watermark, default 64 MiB,
settable with `--min-free-bytes`:

- `POST /api/publish` answers **507** with the numbers in the message.
- `/ready` answers 503 with `reason: disk-full`, so a load balancer stops sending producers here.
- **Claims, acks and nacks keep working**, because a full disk is exactly when consumers need to
  be able to drain.

Losing writes loudly beats a crash loop. `bql_bus_writable` is the gauge.

The WAL is bql.sh's: the tenant checkpoints its own, and `bql_bus_db_bytes` / `_wal_bytes` report
database `bus`'s `main.db` and `main.db-wal` under `<data>/dbs/`. The log beside them is trimmed
by bql.sh once a snapshot (and, with `[s3]`, the bucket) covers it.

## Rate limits and quotas

All off by default. A limit set without knowing the workload is how a healthy fleet gets
throttled at 3am.

```sh
bql bus serve --publish-rate 500 --claim-rate 200 --max-polls 8
bql bus quota set --messages 1000000 --bytes 10000000000 --subscriptions 50 --workspace acme
```

Limits are per **token subject**, in memory, per process. They answer 429 with `Retry-After`.
Quotas are checked against usage read fresh rather than a counter, because a counter and a
retention sweep disagree the moment anything is deleted, and a quota that drifts upward is not a
quota.

## Keys, revocation and the audit trail

```sh
bql bus keys rotate                 # a new active key; the old one still verifies
bql bus keys retire k1              # once tokens signed by k1 have expired
bql bus revoke <jti>                # withdraw one token
bql bus audit --limit 100           # who did what
```

Rotation has an overlap window on purpose: it used to be the only revocation mechanism, so it had
to be possible without invalidating every token in the fleet at one instant. Revocation is a
local index probe on the hot path — no network — and an entry is dropped by the sweep once the
token it names would have expired anyway.

## Capacity, honestly

One writer. A cluster adds copies, automatic failover and reads on every node, not write
throughput: every publish, claim and ack is a commit on the node holding `bus`. Each commit is
also captured into bql.sh's log, so a single-row write costs more than it would on a plain SQLite
file; `publishBatch` is one commit for the whole batch.

Two settings are worth knowing:

- `--retention-ms` prunes messages older than it, but only where every subscription has moved
  past them and none has an unfinished delivery. **An install with no subscriptions prunes
  nothing**, deliberately: a message nobody has subscribed to yet has not been examined, only
  ignored.
- `ttlMs` on a publish deletes the message when it expires, even if nobody consumed it — but
  never while a handler holds it, which would leave a consumer acking a delivery that no longer
  exists.
