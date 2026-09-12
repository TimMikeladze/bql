# Phase 2 — the cluster

Written 2026-09-12, after Tim settled design §13 #11 and #9. This is the plan of record for phase
2; `docs/design.md` §5.3 and §11 are the design it implements, `docs/next.md` is the handoff that
points here.

## The two decisions, settled

**§13 #11 — cluster control plane: built-in Raft.** Membership, per-database placement and
per-database leases live in a small Raft group written in TypeScript over Bun WebSockets. It is
control plane only: a few KB of state, and **the data path never waits on it**. A write consults
the lease its node already holds, in memory, against a monotonic clock — never a quorum. External
adapters (etcd, Postgres) are not built and not planned; the interface below would admit one.

**§13 #9 — default `ack`: stays `local`.** A node whose only replica is restarting must not start
failing writes with `NO_REPLICAS`. Durability above `local` stays opt-in per write. Failover with
`ack: "local"` can lose un-replicated transactions bounded by replica lag, and C2 says so in
`docs/api.md` where promotion is documented.

## What does not change

Standalone is still the default and still has no Raft in it: `[cluster] enabled = false`. The
static topology of §5.2 (`--replica-of`) keeps working exactly as it does today, including manual
promotion — the cluster is a layer over the same replication transport, not a replacement for it.
Nothing in `src/wal/`, `src/sqlite/` or `src/storage/` is touched by C1–C3.

## The state machine

The replicated state is one object, snapshotted whole (it is kilobytes, so `InstallSnapshot` is
the whole thing and log compaction is trivial):

```ts
interface ClusterState {
  /** Every node the cluster knows, by id. */
  nodes: Record<NodeId, { advertise: string; zone: string; joinedTerm: number; status: "voter" | "learner" }>
  /** Per-database placement and lease. Absent = the cluster has never heard of it. */
  dbs: Record<string, {
    primary: NodeId | null
    replicas: NodeId[]
    /** Fencing token. Monotonic per database; bumped on every change of primary. */
    epoch: number
    /** Lease the current primary holds. `until` is the Raft leader's clock. */
    lease: { node: NodeId; until: number } | null
    /** Highest txid the control plane has been told each node has durably applied. */
    acked: Record<NodeId, string>
  }>
  /** Raft term the state was last written in, for debugging and `GET /v1/cluster`. */
  term: number
}
```

`epoch` is the fencing token the write path **already carries** — every `TxnRecord` has it, and a
replica already refuses a record whose epoch is behind with `EPOCH_AHEAD` and closes the socket
(`docs/r1-replication.md`). C2 connects the control plane's epoch to that existing mechanism
rather than inventing a second one.

## Leases, and why the data path stays fast

The Raft leader grants a database's primary a lease valid for `leaseTtlMs` (default 3000) from the
leader's clock, as a committed entry. The holder renews every `leaseRenewMs` (default 1000).

The holder treats the lease as valid until `grantedAtLocalMs + leaseTtlMs - leaseGuardMs` (default
guard 500), measured on its own monotonic clock. Local arithmetic on a monotonic clock, never a
round trip, is what keeps a write at 28 µs. The guard covers clock rate skew, not clock offset:
only elapsed time is compared, and only ever the holder's own.

A primary whose lease has lapsed refuses writes with `NOT_PRIMARY` and stops accepting new ones
before the leader can possibly grant the lease elsewhere — `leaseGuardMs` is exactly that margin.
Reads on a lapsed lease are still served (they are snapshot reads of a local file) but carry
`BunQL-Role: replica`.

## Files

New, and owned by phase 2 alone:

| file | holds |
|---|---|
| `src/cluster/raft.ts` | the algorithm as a **pure state machine**: `step(event, nowMs) -> Action[]`. No timers, no sockets, no I/O. Leader election, log replication, commit index, snapshot install |
| `src/cluster/log.ts` | the persistent Raft log and `{currentTerm, votedFor}`, in `<dataDir>/cluster/`. Append-only framed records with a checksum, fsynced on append, truncatable on conflict |
| `src/cluster/state.ts` | `ClusterState`, the command types that mutate it, `apply(state, command)`, and snapshot encode/decode |
| `src/cluster/transport.ts` | one WebSocket per peer pair at `/v1/cluster/raft`, binary frames in the style of `src/replication/protocol.ts`. `RequestVote`, `AppendEntries`, `InstallSnapshot` |
| `src/cluster/node.ts` | the glue: timers, transport, log, and the interface the server sees (`leaseFor(db)`, `propose(command)`, `observe()`) |
| `src/cluster/placement.ts` | consistent hashing with zone awareness (C3) |
| `src/cluster/index.ts` | the public surface |

Touched: `src/server/config.ts` (`[cluster]`), `src/server/routes.ts` (`GET /v1/cluster`, promote),
`src/server/runtime.ts` (hold the node, consult the lease), `src/server/app.ts` (mount the Raft
socket), `src/cli.ts` (`bunql cluster`, `bunql promote`), `src/client/` (handle `moved`).

**The pure state machine is the point.** Phase 0 tested the WAL codec against SQLite's own files
and phase 1 tested replication with a fault-injecting simulator; Raft gets the same treatment. If
`raft.ts` needs a clock or a socket to be tested, it is written wrong.

## Config — the `[cluster]` section

```toml
[cluster]
enabled = false            # BUNQL_CLUSTER_ENABLED
id = ""                    # this node's id; defaults to [server] node
advertise = ""             # ws://host:port this node is reachable at
zone = ""                  # rack/AZ label, used by placement
peers = []                 # ["ws://a:4321", "ws://b:4321"] — the initial voter set
bootstrap = false          # form a new cluster from `peers` instead of joining one
rf = 2                     # replica factor, C3
leaseTtlMs = 3000
leaseRenewMs = 1000
leaseGuardMs = 500
electionTimeoutMs = 1500   # randomised 1x-2x per Raft
heartbeatMs = 300
```

Every key gets the env override its neighbours already have, following the naming in
`src/server/config.ts`.

## Milestones

Delegate one per Opus subagent with a precise brief, verify with `bun test`, `bun run typecheck`
and a hand exercise before the next starts. C1 gates C2 and C3; C4, C5 and C6 are independent of
all three and of each other.

### C1 — the control plane

`src/cluster/*`, the `[cluster]` config section, `GET /v1/cluster`, `bunql cluster`. A cluster of
three nodes elects a leader, survives losing one, rejoins a partitioned node, and reports
membership and term through the route. No database is placed yet and no lease is consulted by the
write path — C1 is the machinery and its observable surface, nothing more.

Tests: a deterministic simulator driving `step()` with injected time over N nodes, with dropped,
duplicated, delayed and reordered messages, asserting the Raft safety properties (election safety,
leader append-only, log matching, state machine safety). Plus one real three-node integration test
over actual sockets on free ports.

### C2 — promotion and failover

Leases wired to the write path; `POST /v1/db/{db}/promote` and `bunql promote`; automatic failover
when a lease expires; `moved` on the client and `BunQL-Primary` following the new primary.

A replica that is promoted has applied everything it can reach, gets a new epoch from the control
plane, and takes the lease. The old primary is fenced by the epoch it no longer holds — the
mechanism already in `src/replication/` — and demotes itself to replica on reconnect rather than
dying. Clients learn through `307` + `BunQL-Primary` on HTTP and a `moved` frame on WS; the client
SDK retries the request against the new primary once, transparently.

Failover picks the replica with the highest acked txid, which the state machine already tracks.
With `ack: "local"` that can still lose the tail; `docs/api.md` says so plainly.

### C3 — placement and redirect

Consistent hashing with zone awareness picks a database's home node and its `rf-1` replicas. A
client that lands on the wrong node is told where to go (`307` + `BunQL-Primary`) instead of being
served slowly through a forward. Replica set membership drives which node subscribes to which.

### C4 — `workers: N` ✅ **Built.** `docs/c4-workers.md`

The `reusePort` sketch above was **rejected**, and the measurements are in `docs/c4-workers.md` §2:
it does not load-balance on macOS, and a listener in every worker turns every per-process singleton
into an N-way distributed object. What was built instead: the main thread keeps the listener, every
socket, the catalog and the authenticator and owns no database; N worker threads each hold a whole
`ServerRuntime` over the shard of databases their names hash to. Realtime crosses workers through
the router's own `server.publish` — there is no subscriber on a worker, so there is nothing to
`BroadcastChannel` to. A WebSocket is relayed through a *virtual* socket on the worker, so
`src/server/ws.ts` is unchanged.

**28 809 writes/s → 72 817 at six workers, 2.67x, on one port.**

### C4b — `/v1/replication` on a sharded node — **done (`docs/c4b-replication-workers.md`)**

The **stream** crosses the worker channel, not the tenant: the router owns the replication
connection (socket, handshake, frame reader, send queue, heartbeat, announcement) and the worker
that owns a database owns that database's stream, so `tenant.onCommit`, `tenant.log.iterate`,
`tenant.snapshot()` and `registry.pin` are still called on the thread that holds the writer. One
`postMessage` per `TXN` is the whole hot path. `[replication] secret` beside `workers > 1` starts.

Serving a replica costs 15% of write throughput on a single-threaded node and 19% on a sharded one;
six workers with a replica attached do **65 845 writes/s against one worker's 28 236**.

Both of the combinations this left refused have since been built. `[replication] primary` is
**C4c** (`docs/c4c-replication-follow.md`), C4b mirrored: the router owns the one upstream
connection and the worker owns each database's stream, as one class in three modes. `[cluster]
enabled` is **C4d** (`docs/c4d-cluster-workers.md`), the last of them: the `ClusterNode` stays whole
on the router and only the lease *deadline* is pushed down, converted onto the worker's own
monotonic clock because each Bun worker has its own `performance.timeOrigin`. The write path costs
no message — **86 573 writes/s at six workers clustered against 86 754 plain** — and
`WORKERS_UNSUPPORTED` is gone from the error vocabulary with the last refusal it named.

### C5 — replica apply mechanism A — **done (`docs/c5-apply-pages.md`)**

Write pages into the DB file and rewrite the shm header under the WAL locks, LiteFS-style (§4.5).
Mechanism B works but rescans the WAL per apply, which is the 48 µs "replica read" leg in
`bench/wal.ts`. Keep B behind a config switch so a bad apply can be backed out in production.

**As built.** `[replication] apply` chooses: `"pages"` (A) is the default, `"wal"` (B) is the
back-out and the automatic fallback where `xShmLock` is unreachable. The read leg went **47.2 µs to
6.4** and the apply leg 196 to 162, because A computes no WAL frame checksums either. The locks are
all eight wal-index slots taken in one `xShmLock` call through the connection's own
`sqlite3_file`, so an in-process reader mid-transaction makes the apply wait and then answer
`ApplyBusy` — retryable, nothing written — rather than writing underneath it.

### C6 — Linux packaging and CI

Prebuilt `@bunql/sqlite-{linux-x64,linux-arm64,darwin-arm64}` or the loadable-extension shim in
`experiments/bunql_native.c`, then a GitHub Actions workflow running `bun install`, `bun test`,
`bun run typecheck` on macOS and Linux. Nothing else in phase 2 can be trusted on Linux until this
lands, so it is independent but not optional.

## Out of scope

Alternative coordination adapters. Cross-database transactions. Raft on the data path, in any
form, for any reason.
