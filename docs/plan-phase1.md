# Phase 1 plan — primary/replica in production shape

Companion to `design.md` §5, §8 and `next.md`. Phase 0 is built and green; this is what phase 1
adds, in build order, with the wire protocol decided up front so every milestone agrees.

## Milestones

| id | scope | owns | depends on |
|---|---|---|---|
| R1 | replication transport: frame codec, primary endpoint, replica client, replica-mode tenants, bootstrap by snapshot, resume, epoch fencing | `src/replication/`, replica mode in `src/tenant/`, `/v1/replication` in `src/server/`, CLI flags | — |
| R2 | durability and routing: `ack: replica\|quorum`, write forwarding from replica to primary, read-your-writes across nodes, `BunQL-Role`/`BunQL-Primary`, a server-side transaction queue | `src/replication/ack.ts`, `src/server/exec.ts`, `routes.ts`, `ws.ts` | R1 |
| R3 | S3 shipper and restore over `Bun.S3Client`, retention and compaction, `bunql restore --from s3://…` | `src/storage/`, CLI | R1 (shares the log iterator, not the transport) |
| R4 | Hrana compat: `GET /v2` + `POST /v2/pipeline`, then `/v3/pipeline`, `/v3/cursor`, WS subprotocols | `src/server/hrana/` | — |
| R5 | ORM adapters `@bunql/db/kysely` and `@bunql/db/drizzle` | `src/kysely.ts`, `src/drizzle.ts` | — |

R5 and R4 do not touch replication and can run beside R1. R2 must follow R1.

### Findings that belong to R2

**A new database waits for a heartbeat.** Verified by hand after R1: a database created on the
primary while a wildcard replica is already connected does not start streaming until the next
`HEARTBEAT` carries the new database list, up to `heartbeatMs` (5 s) later. The primary must
announce a database the moment it is created, by pushing the database list on creation rather
than only on the heartbeat tick. A replica must reach a new database in the same millisecond
range as a new record.

**A latent checksum trap in `restore()`.** R1 found that `computeFull` counts the header page
SQLite writes when a file is first opened in WAL mode, while a tenant at txid 0 stands at zero
pages and checksum zero, so seeding an applier from a file's computed checksum fails
`ChecksumMismatch` on the first record. The bootstrap path now sends the tenant's own position;
`restore()` in `src/wal/snapshot.ts` still seeds from `SnapshotRef.checksum` and has the same bug
waiting. Fix it at the source.

**Replica realtime is not wired.** Live queries and the change feed are driven by the writer's
hooks, which a replica does not have. A replica must invalidate live queries and emit change
events from `applyRecord`. Phase 1 may emit `txid`-only change events (`changes: []`) on a
replica, since the record carries pages rather than rows, but live queries must re-run and
converge — that is what makes a replica useful for reads.

### A finding from R5 that belongs to R2

A tenant has one writer, so `limits.maxOpenTx` is 1 and a second interactive transaction is
refused `409 TX_BUSY` at once. R5 found that this breaks any client with two concurrent request
handlers and worked around it with a client-side queue in the Drizzle shim. The fix belongs on
the server: queue a transaction that finds the writer busy for up to `limits.txWaitMs` (default
5000) and answer `TX_BUSY` only when that expires, so every client gets the behaviour without
shipping its own queue. R2 owns it.

## Wire protocol (design §8, made exact)

One WebSocket per node pair, opened by the replica to `wss://primary/v1/replication`, carrying
every database that replica follows. Binary frames only.

```
frame := type u8 | len u32 BE | body[len]
```

`len` is the body length; the 5-byte header is not counted. Max body 16 MiB (Bun's default
`maxPayloadLength`). Control bodies are UTF-8 JSON; data bodies are binary, so the hot path never
parses JSON.

| type | name | dir | body |
|---|---|---|---|
| `0x01` | `HELLO` | both | JSON. Primary first: `{proto:1, node, nonce}`. Replica answers: `{proto:1, node, proof}` where `proof = base64(HMAC-SHA256(clusterSecret, nonce))`, compared in constant time. Wrong or missing proof closes with 1008. |
| `0x02` | `SUBSCRIBE` | R→P | JSON `{stream, db, fromTxid, epoch, checksum}`. `stream` is a replica-chosen u32, unique per connection, and addresses the database on every later binary frame. `checksum` is the replica's rolling database checksum at `fromTxid`, as a decimal string. |
| `0x03` | `SUBSCRIBED` | P→R | JSON `{stream, db, mode:"stream"\|"snapshot", txid, epoch, pageSize}`. `mode` says whether records follow directly or a snapshot comes first. |
| `0x04` | `SNAPSHOT_BEGIN` | P→R | JSON `{stream, txid, epoch, checksum, bytes, pageSize}` |
| `0x05` | `SNAPSHOT_CHUNK` | P→R | binary `stream u32 \| seq u32 \| zstd(chunk)`; chunks are 1 MiB of the plain file, in order |
| `0x06` | `SNAPSHOT_END` | P→R | JSON `{stream, txid, hash}` — `hash` is xxHash3 of the plain file as a decimal string |
| `0x07` | `TXN` | P→R | binary `stream u32 \| TxnRecord bytes` (the encoded record from `src/wal/record.ts`, unchanged) |
| `0x08` | `ACK` | R→P | binary `stream u32 \| txid u64 BE \| flags u8` (bit 0: the record is fsynced on the replica) |
| `0x09` | `HEARTBEAT` | both | JSON `{ts, streams:[{stream, txid}]}`, every 5 s; drives lag metrics and liveness |
| `0x0A` | `FORWARD` | R→P | JSON `{id, db, op, body}` — a write a replica received and is handing to the primary (R2) |
| `0x0B` | `RESULT` | P→R | JSON `{id, ok, result}` or `{id, ok:false, error}` (R2) |
| `0x0C` | `UNSUBSCRIBE` | R→P | JSON `{stream}` |
| `0x0D` | `ERROR` | both | JSON `{stream?, code, message}`; fatal codes close the socket |

Error codes: `AUTH_FAILED`, `PROTO`, `UNKNOWN_DB`, `EPOCH_AHEAD` (the replica claims a newer
epoch than the primary holds — a fenced old primary), `DIVERGED` (same txid, different checksum),
`RETENTION` (the replica's position has aged out of the log; it must re-subscribe from 0),
`BUSY`, `INTERNAL`.

### Bootstrap and resume

On `SUBSCRIBE`, the primary decides in this order:

1. `fromTxid === 0` → snapshot.
2. `fromTxid` outside the log's retained range → snapshot (the replica may be told `RETENTION`
   first for the metric, then given a snapshot).
3. The record at `fromTxid + 1` exists and its `prevTxid === fromTxid` and its `preChecksum`
   equals the replica's reported `checksum` → stream from `fromTxid + 1`.
4. Otherwise → `DIVERGED`, then snapshot.

A snapshot is the existing `snapshot()` of `src/wal/snapshot.ts`, streamed in chunks. The replica
writes to a temp file, verifies the hash, swaps it into place, seeds its `WalApplier` at
`(txid, epoch, checksum)`, then receives records from `txid + 1`.

### Catch-up without a gap

The primary subscribes its commit listener **first**, buffering records in memory, then reads the
log from `fromTxid + 1` up to the tenant's txid at attach time, then flushes the buffer skipping
anything already sent. Send order per stream is strictly ascending txid with no holes.

### Backpressure

`ws.send()` returning `-1` pauses the log reader for that socket until `drain`. A socket whose
buffered amount stays over the limit for `replication.slowReplicaMs` (default 30 s) is closed with
`BUSY`; the replica reconnects and resumes from its own position.

## Replica-mode tenants

A replica's database is not a `Tenant` in the phase-0 sense: it has no writer, no `TxnRecorder`,
and no local log of its own authorship. Add `role: "primary" | "replica"` to `TenantOptions` and
`TenantRegistry`:

- a replica tenant opens readers only, holds a `WalApplier`, and exposes
  `applyRecord(record): void`, `position`, `txid`, `epoch`, `checksum`;
- `write`, `txBegin`, `checkpoint("TRUNCATE")` on a replica throw `TenantError("NOT_PRIMARY")`;
- `read({minTxid})` and `waitFor(txid)` resolve against the applied position, so read-your-writes
  works unchanged;
- realtime is driven by `applyRecord` instead of the writer's hooks: a replica publishes change
  events built from the record's page set only if the record carries them — it does not, so in
  phase 1 replicas serve `live` queries by re-running them on the applied txid and serve the
  `changes` feed as `txid`-only events (`changes: []`), documented as a phase-1 limitation. Phase 3
  adds WAL-decoded logical CDC.
- the replica keeps its own copy of the received records in a local `TxnLog` so it can serve a
  downstream replica (chained replication) and so `restore --at` works locally.

## Configuration

New `[replication]` section, with the usual `BUNQL_REPLICATION_*` overrides:

```toml
[replication]
role = "primary"          # or "replica"
primary = ""              # wss://host/v1/replication, required when role = "replica"
secret = ""               # cluster secret; empty disables /v1/replication entirely
follow = ["*"]            # which databases a replica tracks
ackTimeoutMs = 2000       # R2
heartbeatMs = 5000
slowReplicaMs = 30000
reconnectMs = 250         # exponential backoff to 10 s
forwardWrites = true      # R2
```

CLI: `bunql serve --replica-of wss://…`, `--cluster-secret <s>`, `--follow a,b`. A node with
`secret` unset answers `/v1/replication` with 403 `REPLICATION_DISABLED`.

## Observability

`GET /v1/db/:db/replication` gains real content on a primary: `replicas: [{node, stream, txid,
lag, ackedAt}]`. On a replica it reports `role:"replica"`, `primary`, `applied`, `lagTxid`,
`connected`. `/metrics` gains `bunql_replication_lag_txid`, `bunql_replication_connected`,
`bunql_replication_bytes_total`, `bunql_replication_records_total`.

## Test bar

Two servers in one process (both on port 0, separate data dirs) is the harness. Prove: a write on
the primary is readable on the replica within a bounded wait; bootstrap from an empty replica by
snapshot; resume after a dropped socket with no gap and no duplicate; retention gap forces a
re-snapshot; a diverged replica is detected by checksum and re-snapshotted; a replica claiming a
higher epoch is refused; writes are refused on a replica with `NOT_PRIMARY` until R2 adds
forwarding; a replica restart resumes from its persisted position; chained replication
(primary → replica → replica) carries records through.
