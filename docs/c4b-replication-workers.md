# C4b — `/v1/replication` on a node with workers

Phase-2 milestone 4b (`docs/c4-workers.md` §10), design §5.5 and §8. Written 2026-09-12 **before any
code**, because — like C4 — the milestone is a decision before it is an implementation, and the
decision is which of `src/replication/primary.ts`'s dependencies on `Tenant` cross the worker
channel and in what shape.

## 1. The thing that is refused today

`loadConfig` refuses `[server] workers > 1` beside `[replication] secret`, `[replication] primary`
or `[cluster] enabled`, with `WORKERS_UNSUPPORTED` (`src/server/config.ts`, `assertWorkers`). *All
three are lifted as of C4d, and the error code is gone with them.* The reason, from
`docs/c4-workers.md` §5:

> `src/replication/primary.ts` serves a replica from the `Tenant` itself: `tenant.onCommit`,
> `tenant.log.iterate`, `tenant.snapshot()`, `tenant.epoch`, `tenant.checksum`, `registry.pin`. One
> replication socket follows databases across every shard, and the socket is on the router, which
> owns no tenant.

So a node can have six workers *or* replicas, never both. That is the last thing keeping phase 2's
two biggest levers apart.

## 2. The decision: the **stream** crosses, not the tenant

`docs/next.md` names this milestone "a `Tenant` proxy over the worker channel". **This document
rejects that shape**, for the reason the brief itself gives: `onCommit` and `log.iterate` are
*feeds*, and turning a feed into request/response per record is how this gets slow. A proxy would
put every commit event and every log record on the channel twice — once as a reply to the router,
once as a frame back to the socket — and would add a round trip to `tenant.txid` on the lag figure
of every emit.

**Instead: the router owns the replication *connection*, and the worker that owns a database owns
that database's *stream*.**

```
        replica                    router (main thread)                  worker k
           │                                                                │
           │──── HELLO/proof ──────────►  verifyProof, nonce, announce      │
           │◄─── HELLO ok ─────────────   (catalog + generation ledger)     │
           │                                                                │
           │──── SUBSCRIBE db ─────────►  shardOf(db) = k ────────────────► #subscribe
           │                              repl.adopt + repl.frame           │  registry.open
           │                                                                │  registry.pin
           │                                                                │  tenant.snapshot()
           │                                                                │  tenant.onCommit
           │◄─── SUBSCRIBED ───────────   repl.out ◄──────────────────────  │  tenant.log.iterate
           │◄─── SNAPSHOT_* ───────────   repl.out ◄──────────────────────  │
           │◄─── TXN ──────────────────   repl.out ◄──────────────────────  │
           │──── ACK ──────────────────►  stream k ───────────────────────► ackedTxid, onAck
           │◄─── HEARTBEAT ────────────   positions gathered once a tick    │
```

**Nothing that touches a tenant crosses the channel. The only thing that crosses on the hot path is
the finished frame** — one `postMessage` per `TXN`, which is irreducible, because the socket is on
a thread the tenant is not. `onCommit`, `log.iterate`, `snapshot()`, `epoch`, `checksum`,
`position`, `pageSize` and `registry.pin` are all called on the worker, from the same thread that
holds the writer, exactly as they are on a single-threaded node.

### Why the connection cannot be a virtual socket (§4.2)

C4's virtual socket works because a client frame is self-describing — it names one database — and
because the router keeps no state a worker needs. A replication connection is not like that. It has
**connection-level state that is not per-database**:

- an HMAC challenge/response over a nonce the router minted, which must complete before any frame
  is honoured;
- a `FrameReader` over a *binary* stream, where one `message` event may carry half a frame or three;
- a `HEARTBEAT` that announces **every database on the node** with its generation id, and drives
  R7's unfollow on the far side;
- one send queue and one backpressure state over one socket.

Handing that to N workers would mint N nonces, answer one `HELLO` N times, and heartbeat N
announcements down one socket. So the connection stays on the router, whole, and the *stream* — the
one thing that is per-database — is the unit that crosses. A stream id is the routing key, exactly
as a baton and a subscription id are in §4.2.

### What this means for the three questions the brief asks

**What a snapshot means when the file is on another thread.** Nothing changes, because there is no
other filesystem. Workers are threads in one process over one `dataDir`. `tenant.snapshot()` runs on
the worker (it needs the writer), `fs.readFileSync(ref.path)` runs on the worker, the zstd
compression of each 1 MiB chunk runs on the worker — so the *compressed* bytes are what cross, 4.3x
smaller than the plain ones, and the compression is spread across the workers instead of landing on
the router's single thread. The `#snapshots` in-flight map stays per worker, which is correct: it
deduplicates concurrent bootstraps per database, and a database lives on exactly one worker.

**What pinning an LRU entry across threads means.** It never crosses. `registry.pin(db,
"replication")` is called on the worker's own registry — the LRU that actually holds the tenant —
so the pinning thread *is* the owning thread and there is no distributed pin to reason about. The
lifetime rule is the one C4 already has for `ws.close`: when the real socket closes, the router
posts `repl.gone` to every worker that adopted the connection, and each unpins its own streams.
A worker that was never introduced to a connection holds nothing for it. If the router dies the
process dies; there is no state to orphan.

**What the replica sees when a worker is restarting under it.** A worker never restarts: `pool.start`
fails the whole `startServer` if any worker does not come up, and nothing respawns one. So the
honest answer is that this cannot happen, and the failure that *can* — a worker thread that dies —
is reported by `worker.onerror` and leaves that shard broken for every surface, not just for
replication. What C4b must add is that this is not *silent*: `WorkerPool.post` to a missing worker
throws, and the router turns that into an `ERROR` frame on the stream (`INTERNAL`), so a replica
sees a refusal it re-subscribes from rather than a stream that goes quiet for ever.

### Backpressure lives in exactly one place

The router. The worker's virtual socket returns 1 unconditionally (as C4's does), and the router
keeps the one `Conn.queue` and the one `slowReplicaMs` cut-off it keeps today. A second buffer on
the worker would be a second place to reason about a slow replica for no gain: the invariant
"a slow replica costs the primary memory, not correctness" is unchanged and is still enforced in one
function.

## 3. What crosses the channel

Added to `src/server/workers/protocol.ts`. Router → worker:

```ts
/** A replica socket the router has authenticated, adopted on this worker. */
{ kind: "repl.adopt"; conn: string; node: string }
/** One decoded frame for this worker's streams. `body` is the frame body, not the framing. */
{ kind: "repl.frame"; conn: string; type: number; body: Uint8Array }
/** The socket is gone: end its streams here, unpin, roll back its transactions. */
{ kind: "repl.gone"; conn: string; node: string }
/** The heartbeat tick, which is also R7's sweep: the announcement down, the positions back. */
{ kind: "repl.positions"; id: number; generations: [string, string][] }
```

Worker → router:

```ts
/** A finished frame for the real socket. The only thing on the hot path. */
{ kind: "repl.out"; conn: string; bytes: Uint8Array }
/** The worker refused the connection (`#fail`); the router closes the real socket. */
{ kind: "repl.shut"; conn: string; code?: number; reason?: string }
{ kind: "repl.positions.reply"; id: number; streams: { conn: string; stream: number; txid: string }[] }
/** Something here moved the node's database set or a database's identity; re-announce. */
{ kind: "repl.announce" }
```

Four envelopes down, four up, and only one of the eight is per record.

**`repl.frame` carries the decoded body rather than the framed bytes** so the router does not have
to re-encode what it just decoded, and the worker does not have to run a second `FrameReader`. It is
`body.slice()`d rather than forwarded: `FrameReader` hands back a view into the whole WebSocket
message, and structured clone would move that entire buffer rather than this frame.

**The announcement and the position gather are one message, not two.** They happen on the same tick
and each needs the other's thread, so folding them halves the traffic and removes the question of
what a sweep with a stale announcement would mean.

**`repl.announce` has no payload**, because the router assembles the announcement from its own
catalog and only needs to be told that *something* moved. It is `ReplicationServer.announce()`
itself, redirected in hosted mode through `setAnnounceHandler` — so every existing caller, the
registry's `onChange` and C2's promotion among them, reaches the router without growing its own
hook.

**There is no `repl.fenced`.** `onEpochAhead` fires where the tenant is, and `Promoter.demote` flips
that tenant's role by closing and reopening it — worker work, on the worker's own runtime, crossing
nothing. See §6 for the one thing `demote` cannot finish on a worker.

## 4. The split in `src/replication/primary.ts`

`ReplicationServer` gains a **hosted** mode and three methods. It is not split into two classes: the
stream half is 90% of the file and is identical in both modes, and duplicating it is how the two
halves drift.

```ts
interface ReplicationServerOptions {
  /**
   * C4b: this server's connections are adopted from a router that owns the real socket. It does no
   * handshake, mints no nonce, runs no heartbeat timer and builds no announcement — the router does
   * all four, once for the node, and this server only holds streams.
   */
  hosted?: boolean
}

/** A connection the router has already authenticated. */
adopt(ws: ReplicationSocket, node: string): void
/** One frame the router has already decoded, for `#handle`. */
deliver(ws: ReplicationSocket, type: number, body: Uint8Array): void
/** Every stream's position, for the router's HEARTBEAT. */
positions(): { ws: ReplicationSocket; stream: number; txid: bigint }[]
/** R7's sweep, driven by the router's announcement rather than by this server's own tick. */
sweep(announcement: Map<string, string>): void
```

In `hosted` mode: `#startTimer` returns immediately, `announce()` is a no-op, `#hello` is
unreachable (the router never forwards `HELLO`), and `#send` never pauses because the virtual socket
never refuses. Everything else — `#subscribe`, `#decide`, `#bootstrap`, `#snapshotFor`, `#catchUp`,
`#emit`, `#endStream`, `#unpin`, `#teardown`, `#forward`, the ack listeners — runs **unchanged**.
That is the measure of whether this seam was cut in the right place, and it is the same measure C4
used on `ws.ts`.

## 5. Files

New:

| file | holds |
|---|---|
| `src/server/workers/replication.ts` | `ReplicationRouter`: the connection, the handshake, the frame reader, the routing of a frame to a shard, the queue and the cut-off, the heartbeat and the announcement |

Touched:

| file | change |
|---|---|
| `src/replication/primary.ts` | `hosted`, `adopt`, `deliver`, `positions`, `sweep` |
| `src/server/workers/protocol.ts` | the eight envelopes of §3 |
| `src/server/workers/pool.ts` | `replAdopt`/`replFrame`/`replGone`/`replPositions`, `setReplicationHost`, and the four inbound cases |
| `src/server/workers/entry.ts` | `VirtualReplicationSocket` and the four inbound cases |
| `src/server/runtime.ts` | `replicationMode: "own" \| "none" \| "hosted"`, so the router builds no `ReplicationServer` and a worker builds a hosted one; `followPrimary` reports rather than starts on a worker (§6) |
| `src/server/app.ts` | the `/v1/replication` upgrade and its four socket handlers reach the `ReplicationRouter` when there is a pool |
| `src/server/config.ts` | `[replication] secret` is no longer refused beside `workers > 1` |
| `src/server/metrics.ts` | the router's replication gauges, summed by the rule in §7 |
| `docs/c4-workers.md` §5, §10 · `docs/design.md` §5.5 · `docs/api.md` · `docs/next.md` | say what is now true |

## 6. What C4b does **not** lift, and why

**`[replication] primary` with `workers > 1` stays refused** — *until C4c, which built it;
see `docs/c4c-replication-follow.md`.* Following an upstream is the mirror of
this document — the router would own the socket, the reconnect, the generation ledger
(`generations.json`, one file, one writer) and R7's unfollow, and the worker would own
`installSnapshot`, `applyRecord` and the deferred-retry queue. It is the same shape and it is its
own milestone (**C4c**), because `ReplicaClient` is 1302 lines with bootstrap file descriptors,
forwarding and the unfollow ledger tangled through it, and because a node that *serves* replicas is
what makes the six-worker lever and replication usable together. A replica node is a read node, and
its reads already scale on one thread better than its applies do.

**`[cluster] enabled` with `workers > 1` stays refused** — *until C4d, which built it, and it was
the last refusal; see `docs/c4d-cluster-workers.md`.* `docs/c4-workers.md` §10 lists it separately
and it is a different problem: the Raft lease is consulted on the write path, which is now a worker,
and a worker must not block on the control plane (design §5.3). It wants the lease state *pushed*
down the channel, not asked for — which is exactly what C4d does, with the twist that a deadline
has to be *converted* on the way: each Bun worker has its own `performance.timeOrigin`.

**A fenced database on a worker demotes but does not auto-follow** — *closed by C4c, which gave the
router the one client a worker now reports to.* `Promoter.demote` ends with
`runtime.followPrimary(url)`, which starts a `ReplicaClient` — a node-level socket that has no
business being opened inside a worker thread, and which C4c is what makes possible. On a worker,
`followPrimary` reports rather than starts. The safety half of the demotion — the database stops
taking writes and answers `NOT_PRIMARY` — happens in full; the convergence half waits for C4c. This
is only reachable with `[cluster] enabled`, which was refused anyway until C4d, or with an operator
promoting by hand.

## 7. The reporting gaps C4 left, and which of them this closes

`GET /metrics` on a router omitted the replication gauges because "replication is refused with
`workers > 1` anyway". It is not any more, so C4b owes a summing rule that is not a lie:

| gauge | rule | why it is honest |
|---|---|---|
| `bunql_replication_connected` | **the router's** connection count | the router owns every socket; a worker's adopted count is a different quantity |
| `bunql_replication_lag_txid` | **max** over workers | it is already a max over streams |
| `bunql_replication_bytes_total` | the router's `bytesSent` | the router is what writes to the socket, so it counts every byte once |
| `bunql_replication_records_total` | **sum** over workers | a `TXN` is emitted by exactly one worker |

The storage gauges stay omitted: that gap is unchanged and is not this milestone's.

`GET /v1/db/{db}/replication` needs nothing new — it is a `/v1/db/:db/…` route, so it is already
hopped to the worker that owns the database, and `replicasOf(db)` there is exact.

## 8. The oracle, and the tests

**The checksum chain is the oracle, exactly as it was for C5.** A replica fed through the router
must land byte-for-byte on the primary's rolling checksum. If it does not, `#decide` refuses the
next subscribe with `DIVERGED` and the replica re-bootstraps — so a C4b bug cannot corrupt a
replica, it can only make one that never converges.

`test/wal/replication.test.ts` and the two e2e replication scenarios **must pass unchanged**. They
exercise a single-threaded node, which C4b does not touch: `workers = 1` spawns no Worker and
`ReplicationRouter` is never constructed. If they need editing, the contract moved and that is the
thing to report, not to edit.

New:

- `test/server/workers-replication.test.ts` — a three-worker primary with `[replication] secret`
  starts (the refusal is gone); a real `ReplicaClient` over a real socket follows two databases that
  hash to **different shards**, both converge, and both land on the primary's checksum; a database
  created on worker 2 reaches a `follow: ["*"]` replica without waiting for a heartbeat (finding 1,
  through `repl.changed`); a replica killed mid-stream reconnects and catches up from its own
  position; a replica whose local file was corrupted is refused with `DIVERGED` and re-snapshots;
  `UNSUBSCRIBE` on one shard leaves the other streaming; the socket closing unpins on every worker
  (`registry.stats().open` falls back).
- `test/server/workers-config.test.ts` — `[replication] secret` with `workers: 3` no longer throws;
  `[replication] primary` and `[cluster] enabled` still do, each by code.
- `test/replication/hosted.test.ts` — `adopt` + `deliver` against a fake socket, with no handshake,
  produce the same frames `open` + `message` do on a single-threaded server.

Then, by hand: a real three-worker primary, a real replica, a database on worker 0 and one on worker
2 streaming down one socket; `bun run bench/workers.ts` with replication on, against the 33 854 /
86 006 baseline P3 left.

## 9. As built — what changed from this plan, and what it measured

Built 2026-09-12. `bun test` → **1381 pass, 2 skip, 0 fail** across 112 files (1369 before);
`bun run typecheck`, `bun run bytes` and `bun run routes:check` clean.

**The decision held.** `src/replication/primary.ts` gained a `hosted` flag and four methods —
`adopt`, `deliver`, `positions`, `sweep`, plus `setAnnounceHandler` — and **nothing below the
connection changed at all**: `#subscribe`, `#decide`, `#bootstrap`, `#snapshotFor`, `#catchUp`,
`#emit`, `#endStream`, `#unpin`, `#teardown`, `#forward` and the ack listeners are the same code a
single-threaded node runs. `test/replication/hosted.test.ts` asserts that directly: a hosted server
handed a pre-authenticated connection and pre-decoded frames emits **byte-for-byte the same frames**
the ordinary one emits after its own handshake, once the two `HELLO`s are taken off the front.

**Four things came out differently from the plan, and each is smaller than it:**

- **`repl.sweep` and `repl.positions` merged.** They happen on the same tick and each needs the
  other's thread, so the announcement goes down and the positions come back in one round trip.
- **`repl.changed` became `repl.announce`, with no payload.** The router assembles the announcement
  from its own catalog, so it only has to be told that *something* moved. It is
  `ReplicationServer.announce()` redirected in hosted mode, which means C2's promotion is carried
  across for free rather than needing a hook of its own.
- **`repl.shut` was needed.** The plan had nothing for it; a worker's `#fail` closes the connection
  (`AUTH_FAILED`, `PROTO`, a frame it could not handle), and that has to reach the real socket.
- **A third `replicationMode` was needed**, not two. `"none"` on the router, `"hosted"` in a worker,
  `"own"` on a single-threaded node — and `startServer` had to resolve `workers` *before* it builds
  the runtime, because whether this thread holds a `ReplicationServer` at all depends on it.

**One thing this milestone had to fix that the plan did not anticipate:** `runtime.generationOf`
scans `registry.list()` for the row it is asked about, so building an announcement through it is
quadratic in the number of databases. The router's `#announcement` spells the rule out instead and
is linear, which matters because it runs on the one thread that also holds every socket.

### What it measured

`bun run bench/workers.ts --replication` attaches a real replica to every node on the ladder before
the load starts. Eight databases, 64 sockets, five seconds, server, replica and load client all in
separate processes, on the machine `docs/performance.md` was measured on. The 1- and 4-worker rows
are **three alternating rounds** of (no replication, replication) — the ablation discipline
`docs/p3-wal-checksum.md` §2 settled on, because a single run of each measures the machine as much
as the change. The 6-worker row is one run of each.

| workers | no replication | one replica attached | cost |
|---|---|---|---|
| 1 | 33 096 – 33 323 | 27 958 – 28 236 | **−15%** |
| 4 | 74 045 – 78 869 | 60 538 – 61 946 | **−19%** |
| 6 | 81 183 | 65 845 | **−19%** |

The one-worker row is the ablation that matters, and it is built into the benchmark rather than
bolted on: **`workers = 1` spawns no Worker and constructs no `ReplicationRouter`**, so that row is
replication's own cost with no channel in it at all. Serving a replica costs 15% of a node's write
throughput before C4b exists, and a sharded node pays 19% — so **the worker channel is about four
points of it**, and the other fifteen are what shipping every commit down a socket costs on any
node. A sharded node with replicas still does **65 845 writes/s against a single thread's 28 236**,
which is 2.33x, against the 2.44x the same ladder reaches with no replica attached.

### Verified by hand

A real three-worker primary (`--workers 3 --cluster-secret …`) and a real replica, on real ports,
exercised across a shard boundary:

- `hand2` on worker 0 and `hand4` on worker 2, both written to, both streaming down **one** socket.
  Both landed on the primary's rolling checksum exactly — `2581726592724965459` and
  `18141699947257828937` — and both applied through C5's page mechanism, `"apply": "pages"` with a
  **zero-byte `-wal`**, so C4b did not cost the replica the read speed C5 bought it.
- `GET /v1/db/{db}/replication` on the primary reported the replica on each database separately,
  stream 1 on one worker and stream 2 on another, both at lag 0.
- A database created *after* the replica attached, on a third shard, reached it without waiting for
  a heartbeat — `repl.announce`, which is `plan-phase1.md` finding 1 across threads.
- The replica killed mid-stream, four more writes on *each* shard, then brought back: it resumed
  from its own position and both checksums matched again
  (`14311203852411804109` / `12048853740000930017`), with nothing in either node's log.
- `GET /metrics` on the router: `connected 1`, `bytes_total 5784`, `records_total 8` — the router's
  own count of sockets and bytes, and the workers' summed count of records.

A replica whose file was corrupted, and a socket close unpinning on every worker it touched, are in
`test/server/workers-replication.test.ts` rather than by hand.

### The contract that moved, and it is the only one

`test/server/config.test.ts` asserted that `[server] workers = 2` beside `[replication] secret`
refuses to start. That refusal is what this milestone exists to lift, so the test now asserts the
opposite. **Nothing else was edited**: `test/wal/replication.test.ts` and both e2e replication
scenarios pass unchanged, which is the signal that the wire contract did not move.
