# C4c — following an upstream with `[server] workers > 1`

Phase-2 milestone 4c (`docs/c4-workers.md` §10, `docs/c4b-replication-workers.md` §6), design §5.5 and
§8. Written 2026-09-12 **before any code**, for the same reason C4 and C4b were: the milestone is a
decision before it is an implementation, and the decision is **which half of `ReplicaClient` is the
router's and which is the owning worker's**, plus the four questions the code cannot answer for
itself.

## 1. The thing that is refused today

`loadConfig` refuses `[server] workers > 1` beside `[replication] primary` with
`WORKERS_UNSUPPORTED` (`src/server/config.ts`, `assertWorkers`):

> the upstream socket, the reconnect and the generation ledger are node-level while the apply is per
> shard, and that half is not built yet

So a replica — a node whose whole job is reads — is stuck on one thread at ~50k reads/s over HTTP
and ~220k over a socket while five or seven cores sit idle. C4b lifted the other half; this is the
last replication refusal.

## 2. The decision: the same seam as C4b, cut the other way

C4b's rule was **the stream crosses the worker channel, not the tenant**. C4c keeps exactly that rule
and reverses the direction of the frames:

**The router owns the *connection* — the upstream socket, the reconnect and its backoff, the HMAC
proof, the `FrameReader`, the generation ledger, the follow/unfollow decision, R7's reconciliation,
R2's forward queue, and the node's `ReplicaStatus`. The worker that owns a database owns that
database's *stream* — `registry.openReplica`/`createReplica`, the snapshot file, `installSnapshot`,
`registry.pin`, `tenant.applyRecord`, the deferred-retry queue, and the `ACK`.**

```
      upstream primary                router (main thread)                     worker k
             │                                                                    │
             │──── HELLO/nonce ─────────►  makeProof, HELLO back                   │
             │◄─── HELLO ok+databases ──   #resolveFollow over the announcement    │
             │                             mint stream id, shardOf(db) = k ──────► follow.start
             │                                                                    │  registry.openReplica
             │                                                                    │  registry.pin
             │◄─── SUBSCRIBE ───────────   follow.out ◄─────────────────────────── │  tenant.txid/epoch/checksum
             │──── SUBSCRIBED ──────────►  stash generation + primaryTxid          │
             │──── SNAPSHOT_* ──────────►  follow.frame ────────────────────────►  │  zstd decompress, fd, hash
             │                                                                    │  registry.installSnapshot
             │                             follow.installed ◄──────────────────── │
             │                             (ledger written here, then:)            │
             │◄─── ACK ─────────────────   follow.out ◄─────────────────────────── │
             │──── TXN ─────────────────►  follow.frame ────────────────────────►  │  tenant.applyRecord
             │◄─── ACK ─────────────────   follow.out ◄─────────────────────────── │
             │──── HEARTBEAT ───────────►  #resolveFollow (R7 sweep)               │
             │◄─── HEARTBEAT ───────────   follow.status, once a tick ───────────► positions
```

**Nothing that touches a tenant crosses the channel.** `openReplica`, `createReplica`,
`installSnapshot`, `applyRecord`, `pin`, `unpin` and `delete` all run on the thread that holds the
writer, exactly as they do on a single-threaded node. The hot path is **one `postMessage` per `TXN`
down and one per `ACK` up** — both irreducible, because the socket is on a thread the tenant is not.

### Why the connection cannot be a virtual socket, again

The same three reasons C4b gave, mirrored: an HMAC proof over a nonce the *primary* minted, a
`FrameReader` over a binary stream where one `message` may carry half a frame or three, and an
announcement that names **every database on the upstream** and drives R7's unfollow. Handing that to
N workers would answer one `HELLO` N times, keep N ledgers, and let N threads each decide
independently to trash a local copy. The connection stays on the router, whole.

### But the *worker's* end of it is a virtual socket, and that is what keeps the seam honest

`ReplicaClient.#send` is `this.#socket.send(frame)` and nothing else. So a hosted client is handed a
`VirtualUpstreamSocket` whose `send` posts `follow.out`, and **`SUBSCRIBE`, `ACK`, `UNSUBSCRIBE` and
the diverged-apply `ERROR` cross for free with no new plumbing at all** — the mirror of C4b's
`VirtualReplicationSocket`. `#send`, `#subscribe`, `#snapshotBegin`, `#snapshotChunk`,
`#snapshotEnd`, `#abortBootstrap`, `#txn`, `#apply`, `#scheduleRetry2` and `#ack` are then the same
code a single-threaded node runs, which is the measure of whether the seam was cut in the right
place.

## 3. The four questions

### 3.1 Where the snapshot file is written — **on the worker, from compressed chunks**

Today the router-equivalent writes decompressed chunks to an fd under `bootstrapDir` and hands
`installSnapshot` a path. C4c forwards the **compressed** chunk body verbatim and the worker
decompresses it, writes it, hashes it at `SNAPSHOT_END` and installs it.

This is the exact symmetric answer to C4b putting the primary's *compression* on the worker, and for
the same two reasons: it keeps zstd off the one thread that also holds every socket, and it keeps
`installSnapshot` on the thread that owns the tenant. It is also 4.3x less to copy across the
channel, since the compressed bytes are what the primary measured at that ratio. The router never
opens a file descriptor.

There is no second filesystem to reason about: workers are threads in one process over one
`dataDir`. The temp file name already carries the stream id, and stream ids are minted by the router
and are therefore unique node-wide, so two workers bootstrapping at once cannot collide.

### 3.2 The generation ledger — **on the router, and the worker reports the install**

`generations.json` is one file with one writer and it is node-level. Every reader of it is
node-level too: `#resolveFollow`'s held set, the identity comparison that trashes a re-created
database, the `generation` field of a `SUBSCRIBE`, and `#subscribed`'s check that the primary did not
stream one database onto a copy of another. All of those are the router's half. **A catalog column
is rejected**: it would be a schema change to a shared catalog that a single-threaded node does not
need, to move a ledger whose readers are all already on the thread that would have to read the
column back.

So the ledger stays on the router, whole, and the worker reports exactly one thing. The worker does
not learn the generation id at all — the router stashed it from `SUBSCRIBED`, which it handles
itself — so the report is only *"the copy this stream describes now exists locally"*:

```ts
{ kind: "follow.installed"; stream: number; db: string; txid: string }
```

**The ordering is the safety property, and it is free.** At `SNAPSHOT_END` the worker installs, posts
`follow.installed`, and only then posts the `ACK` through its virtual socket. `postMessage` to one
port is FIFO, so the router writes the ledger (`writeFileSync` + `rename`, once per bootstrap, not
per record) **before** the `ACK` reaches the wire. That is exactly the invariant the file header
already states — *a record is acked only after it is applied and the position is persisted* — with
the ledger entry added to the list of things persisted first. A crash in the window leaves a copy on
disk that the ledger does not know about, which is the one failure R7 cannot recover from: a copy
with no recorded identity is a copy `#resolveFollow` never considers for a drop.

`generationOf` is also read by `runtime.generationOf`, which is what a **chained** replica announces
to its own downstream replicas — and with both refusals lifted, a sharded node can serve replicas and
follow an upstream at once. So the router pushes the ledger down after every save:

```ts
{ kind: "follow.generations"; entries: [string, string][] }
```

Once per bootstrap and once per drop, to every worker. Without it a chained sharded replica would
mint a fresh identity from its own catalog row for every database, and every downstream replica would
trash its copy and bootstrap again for no reason at all — the failure `runtime.generationOf`'s
docstring already warns about, arriving through a thread boundary.

### 3.3 Who builds the `SUBSCRIBE` body — **the worker does, and there is no round trip**

The brief offers a round trip per subscribe or a message per apply. Neither is necessary. The body
needs `tenant.txid`, `epoch` and `checksum`, which are worker state, and `generation`, which is
router state — so the router sends the one field it owns *with the instruction*, and the worker
encodes the whole frame where the other three live:

```ts
{ kind: "follow.start"; stream: number; db: string; generation: string | null; reset: boolean }
```

Zero round trips and zero per-record messages. This is the C4b rule applied in the other direction:
the router decides *which* databases to follow (it owns the announcement and the ledger) and mints
the routing key; the worker owns everything about the stream itself. The router records
`stream -> worker` when it posts `follow.start`, which is strictly before the `SUBSCRIBE` it provokes
can be answered, so `SUBSCRIBED`, `SNAPSHOT_*` and `TXN` can never arrive for a stream the router
cannot route.

The one exception is the recovery path. A diverged apply wants a *fresh* stream from zero, and only
the router may mint one, so the worker sends its `ERROR` frame through the socket as it does today
and then asks:

```ts
{ kind: "follow.again"; stream: number; db: string; reason: string }
```

The router sends `UNSUBSCRIBE`, mints the next id and posts `follow.start` with `reset: true`. One
round trip, on the path that only runs when a replica has already diverged.

### 3.4 What `readyz` and `GET /v1/db/{db}/replication` report — **one fact and N facts, and they were always different**

**`readyz` is unchanged, and it is one fact, not N.** It reads `replica.connected`, which is
`#connected && #handshook` — purely connection-level, and the connection is the router's. It never
depended on a stream. So the router answers it from its own state and the meaning does not move.
Widening it to "every database I am supposed to follow is streaming" would be a contract change that
has nothing to do with workers, and this milestone deliberately does not make it.

**`GET /v1/db/{db}/replication` is a `/v1/db/:db/…` route**, so it is already hopped to the worker
that owns the database. It reports one stream's `applied`, `lagTxid` and `bootstrapping`, which are
that worker's, beside `connected`, `primary` and `lastError`, which are the router's. Rather than a
round trip on a read route, the router **pushes** the connection-level facts whenever they change —
on connect, on close, on `retarget`, which is rare and never per record:

```ts
{ kind: "follow.link"; connected: boolean; primary: string; node: string | null; lastError: string | null }
```

That is design §5.3's rule for the Raft lease — push the state down, never let a worker block on the
control plane — applied to the one other node-level fact a worker's handler needs. It is also what
`promote.ts`'s `#requestFor` reads (`replica.connected`, and the stream for `streamLive`) and what
`Forwarder.enabled` needs, both of which run on the worker.

`primary` comes from the pushed state rather than from `config.replication.primary`, because
`retarget` moves it on the router and a worker's copy of the config would go stale at exactly the
moment it matters.

## 4. What crosses the channel

Added to `src/server/workers/protocol.ts`. Router → worker:

```ts
/** Follow `db` on this stream: open the copy, pin it, and send SUBSCRIBE. §3.3 */
{ kind: "follow.start"; stream: number; db: string; generation: string | null; reset: boolean }
/** One frame the router decoded, for this worker's streams: SNAPSHOT_BEGIN/CHUNK/END and TXN. */
{ kind: "follow.frame"; type: number; body: Uint8Array }
/** End a stream. `drop` disposes of the local copy (R7); false is C2's detach, which keeps it. */
{ kind: "follow.stop"; stream: number; db: string; drop: boolean; reason: string }
/** The connection-level facts, pushed so a read route needs no round trip. §3.4 */
{ kind: "follow.link"; connected: boolean; primary: string; node: string | null; lastError: string | null }
/** The ledger, after every save, for a chained replica's own announcement. §3.2 */
{ kind: "follow.generations"; entries: [string, string][] }
/** The heartbeat tick: the primary's positions down, this worker's up. */
{ kind: "follow.status"; id: number; primary: [number, string][] }
/** R2: the primary's answer to one forwarded write. */
{ kind: "follow.result"; id: number; ok: boolean; result?: unknown; error?: ForwardErrorBody }
```

Worker → router:

```ts
/** A finished frame for the upstream socket: SUBSCRIBE, ACK, UNSUBSCRIBE, ERROR. */
{ kind: "follow.out"; bytes: Uint8Array }
/** The snapshot installed. Ordered before the ACK, which is the whole point. §3.2 */
{ kind: "follow.installed"; stream: number; db: string; txid: string }
/** A diverged apply wants a fresh stream from zero; only the router may mint one. §3.3 */
{ kind: "follow.again"; stream: number; db: string; reason: string }
/** The local copy was disposed of; the trash path is `ReplicaStatus.unfollowed`'s. */
{ kind: "follow.stopped"; db: string; trash: string | null }
/** R2: a write this node could not take, on its way to the one upstream socket. */
{ kind: "follow.forward"; id: number; db: string; op: string; body: unknown }
/** C2 on a worker: a promotion detached a database, or a demotion re-attached one. */
{ kind: "follow.detach" | "follow.attach"; db: string }
{ kind: "follow.status.reply"; id: number; streams: { stream: number; db: string; applied: string; bootstrapping: boolean }[] }
```

Seven envelopes down, seven up, and only two of the fourteen are per record.

**`follow.frame` carries only `SNAPSHOT_*` and `TXN`.** `HELLO`, `SUBSCRIBED`, `HEARTBEAT`, `ERROR`
and `RESULT` are handled on the router and never forwarded: every one of them touches connection
state, the ledger or the forward queue, and none of them touches a tenant. `SUBSCRIBED` in
particular is entirely the router's — it stashes the generation and the primary's txid, and the
worker never needs to know either.

**It carries no stream id of its own**, because every one of those four frames already names its
stream in its body, and the router has to decode that much to route it anyway.

**The body is `slice()`d, not forwarded.** `FrameReader` hands back a view into the whole WebSocket
message, and structured clone would move that entire buffer rather than this frame. Same rule, same
reason, as C4b.

**The forward queue and its cap live in exactly one place**: the router. `maxForwards` is a
node-level ceiling on writes in flight to one upstream socket, and a second queue per worker would be
a second place to reason about it for no gain — the mirror of C4b putting backpressure only on the
router.

## 5. The split in `src/replication/replica.ts`

`ReplicaClient` gains a **hosted** mode, the way `ReplicationServer` gained one. It is not split into
two classes: the stream half and the connection half are tangled through 1302 lines *as written*, but
they are cleanly separable *as behaviour*, and duplicating either is how the two drift.

```ts
interface ReplicaClientOptions {
  /**
   * C4c: this client's connection is owned by a router on another thread. It opens no socket,
   * makes no proof, runs no reconnect and no heartbeat timer, keeps no ledger and reconciles no
   * announcement — the router does all of it, once for the node — and this client only holds the
   * streams for the databases this shard owns.
   */
  hosted?: boolean
}

/** The router adopting this worker's end of the one upstream connection. */
adopt(socket: ClientSocket, host: ReplicaHost): void
/** Follow `db` on `stream`: open the copy, pin it, and send `SUBSCRIBE`. */
follow(stream: number, db: string, generation: string | null, reset: boolean): void
/** One frame the router decoded — `SNAPSHOT_*` or `TXN` — for `#handle`. */
deliver(type: number, body: Uint8Array): void
/** End a stream. `drop` takes the local copy through the registry's delete path (R7). */
unfollow(stream: number, db: string, drop: boolean, reason: string): void
/** Every local stream's position, for the router's `HEARTBEAT` and its `status()`. */
positions(primary: Map<number, bigint>): StreamPosition[]
/** The connection-level facts the router owns (§3.4), and the ledger (§3.2). */
link(state: LinkState): void
generations(entries: [string, string][]): void
```

`ReplicaHost` is the five callbacks that are not frames: `installed`, `again`, `stopped`, `forward`,
`detach`/`attach`. One seam rather than five setters, because unlike C4b's single `announce` they are
a set that is only ever installed together.

In `hosted` mode: `#connect`, `#scheduleRetry`, `#reportDisconnected`, `#explainOnce`,
`#startHeartbeat` and `#loadGenerations` return immediately; `#hello`, `#subscribed`, `#heartbeatIn`,
`#errorIn`, `#result` and `#resolveFollow` are unreachable (the router never forwards the frames that
reach them); `#recordGeneration` becomes `host.installed`; `#resubscribe` sends its `ERROR` and then
calls `host.again` instead of minting an id; `forward` posts to `host.forward` and the router owns the
cap and the timeout; `detach`/`attach` report to the router, which owns `#detached`. Everything else —
`#subscribe`, `#snapshotBegin`, `#snapshotChunk`, `#snapshotEnd`, `#abortBootstrap`, `#txn`,
`#apply`, `#scheduleRetry2`, `#ack`, `#send`, `#unfollow`'s local half — runs **unchanged**.

## 6. Files

New:

| file | holds |
|---|---|
| `src/server/workers/replica.ts` | `ReplicaRouter`: the upstream socket, the reconnect and backoff, the handshake proof, the frame reader, `#resolveFollow` and R7's sweep, the generation ledger, the stream table, `ReplicaStatus`, the heartbeat, and R2's forward queue |

Touched:

| file | change |
|---|---|
| `src/replication/replica.ts` | `hosted`, `adopt`, `follow`, `deliver`, `unfollow`, `positions`, `link`, `generations` |
| `src/server/workers/protocol.ts` | the fourteen envelopes of §4 |
| `src/server/workers/pool.ts` | `followStart`/`followFrame`/`followStop`/`followLink`/`followGenerations`/`followStatus`/`followResult`, `setFollowHost`, and the seven inbound cases |
| `src/server/workers/entry.ts` | `VirtualUpstreamSocket`, the `ReplicaHost` implementation, the seven inbound cases, and `assertOwned` for a `follow.start` |
| `src/server/runtime.ts` | `replicationMode: "hosted"` builds a hosted `ReplicaClient` too; `followPrimary` on a worker reports to the router rather than refusing (closes C4b §6's gap) |
| `src/server/app.ts` | build and start a `ReplicaRouter` when there is a pool and a `[replication] primary`; stop it in `close()` |
| `src/server/workers/router.ts` | `routerMetrics` prefers the replica router over the replication router, matching `replicationMetrics`'s own rule |
| `src/server/config.ts` | `[replication] primary` is no longer refused beside `workers > 1` |
| `docs/c4-workers.md` §10 · `docs/c4b-replication-workers.md` §6 · `docs/design.md` §5.5 · `docs/api.md` · `docs/next.md` | say what is now true |

## 7. What C4c does **not** lift

**`[cluster] enabled` with `workers > 1` stays refused**, unchanged and for its own reason: the Raft
lease is consulted on the write path, which is now a worker, and a worker must not block on the
control plane (design §5.3). It wants the lease state *pushed* down the channel, which is the shape
§3.4 uses for `follow.link` but over a different and much hotter fact. Its own milestone.

**C4b §6's `followPrimary` gap closes.** A fenced database on a worker demoted but could not
auto-follow, because starting a `ReplicaClient` inside a worker thread was the thing C4c had to make
possible. It now posts to the router, which retargets or starts the one node-level client. This is
only reachable with `[cluster] enabled` (still refused) or an operator promoting by hand, so it is a
correctness tidy-up rather than a new path.

## 8. The oracle, and the tests

**The checksum chain is the oracle, exactly as it was for C4b and C5.** A replica whose streams are
spread over N workers must land byte-for-byte on the primary's rolling checksum for every database.
If it does not, `applyRecord` raises and `#resubscribe` asks for a snapshot — so a C4c bug cannot
corrupt a replica, it can only make one that never converges.

`test/wal/replication.test.ts`, `test/replication/*` and the e2e replication scenarios **must pass
unchanged**. They exercise a single-threaded node, which C4c does not touch: `workers = 1` builds no
`ReplicaRouter` and constructs no hosted client. If they need editing, the contract moved and that is
the thing to report, not to edit.

New:

- `test/server/workers-follow.test.ts` — a three-worker replica with `[replication] primary` starts
  (the refusal is gone); it follows two databases that hash to **different shards** from a real
  single-threaded primary, both converge, and both land on the primary's checksum; a database created
  on the primary after the replica attached is picked up without waiting for a restart; a replica
  restarted mid-stream resumes from its own positions on both shards; `GET /v1/db/{db}/replication`
  on each reports that shard's stream beside the shared connection state; `readyz` is 503 while the
  upstream is down and 200 when it is up; R2 forwards a write from a worker over the one socket and
  gets the primary's result back; R7 drops a database deleted upstream **and trashes the copy on the
  worker that owned it**, and re-bootstraps one re-created under the same name.
- `test/server/workers-config.test.ts` — `[replication] primary` with `workers: 3` no longer throws;
  `[cluster] enabled` still does, by code.
- `test/replication/hosted-follow.test.ts` — `adopt` + `follow` + `deliver` against a fake socket,
  with no handshake, produce byte-for-byte the frames an ordinary client produces after its own
  handshake, once the `HELLO` is taken off the front. The mirror of `test/replication/hosted.test.ts`,
  and the same measure of whether the seam was cut in the right place.

Then, by hand: a real single-threaded primary and a real three-worker replica, two databases on
different shards, `GET /metrics` on both, a kill and a resume, and `bun run bench/workers.ts` in read
mode against the replica to measure what the second lever was worth.

## 9. As built — what changed from this plan, and what it measured

Built 2026-09-12. `bun test` → **1398 pass, 2 skip, 0 fail** across 114 files (1381 before), and
**1396 / 4 / 0** with `BUNQL_WAL_NATIVE=0`. `bun run typecheck`, `bun run bytes` and
`bun run routes:check` clean.

**The decision held, and one thing about it came out better than the plan.** §5 said `ReplicaClient`
would gain a hosted mode. It gained **three modes and one copy of every decision** —
`"own"`, `"routed"` and `"hosted"` — rather than a hosted mode beside a new router class. §6's
planned `src/server/workers/replica.ts` was going to hold "the upstream socket, the reconnect and
backoff, the handshake proof, the frame reader, `#resolveFollow` and R7's sweep, the generation
ledger, the stream table, `ReplicaStatus`, the heartbeat, and R2's forward queue". Every one of
those is *the same logic* a single-threaded node runs, so writing it a second time would have been
about 600 duplicated lines and exactly the drift C4b's §4 warned about. Instead `"routed"` is
`ReplicaClient` with the registry calls replaced by an injected `ShardHost`, and
`src/server/workers/replica.ts` is **151 lines of adapter** — `ShardHost` over `WorkerPool` one way,
`FollowHost` back the other — with no protocol knowledge in it at all.

`test/replication/hosted-follow.test.ts` asserts the seam directly, as `hosted.test.ts` does for
C4b: a hosted client handed a pre-authenticated socket and pre-decoded frames sends **byte-for-byte
the same frames** an ordinary client sends after its own handshake and its own announcement, once
the `HELLO` proof is taken off the front — the `SUBSCRIBE`, the bootstrap's `ACK` and the `ACK` for
a later commit.

**Four things came out differently from the plan, and each is smaller than it:**

- **`SUBSCRIBED` is never forwarded, so the worker never learns a generation id.** The plan had the
  worker report `installed` and the router record "the generation it stashed"; in the code the
  router handles `SUBSCRIBED` whole — the generation, the primary's txid, the identity check — and
  the worker's `follow.installed` carries only *"the copy this stream describes now exists"*. The
  ledger is that much more completely the router's.
- **`follow.again` needed a "the shard already let go" flag.** A diverged apply is decided on the
  worker, which drops its own stream before reporting; a generation mismatch is decided on the
  router, where the shard still holds one. `#resubscribe(stream, tellShard)` is the one-bit
  difference, and getting it wrong would have left a pinned tenant on the worker with no stream.
- **`follow.primary` was needed**, which the plan mentioned only in §7. C4b §6's gap does not close
  by itself: a worker's `followPrimary` has to reach the router's one client, so it is a seventh
  envelope rather than a consequence.
- **`adopt` starts *disconnected*.** A worker is built before the node's upstream socket exists, and
  `Forwarder` asks this client whether there is a socket to forward over. Saying yes before the
  first `follow.link` would have turned a `NOT_PRIMARY` into a write that vanishes.

**One thing this milestone had to fix that the plan did not anticipate:** the ledger has a second
reader nobody listed — `runtime.generationOf`, which is what a **chained** replica announces to its
*own* downstream replicas. With both refusals now lifted, a sharded node can serve replicas and
follow an upstream at once, and a hosted client with no ledger would have minted a fresh identity
from its own catalog row for every database. `follow.generations` pushes the ledger to every worker
after every save; §3.2 argues it, and the hand verification below proves it on a real three-node
chain.

### What it measured, and it is not what the brief assumed

`bun run bench/workers.ts --follow [--transport http]` turns the C4 ladder round: each rung is a
*replica* of one single-threaded primary, seeded and settled before the load starts, and the load is
**point reads**, because a node that follows an upstream takes no writes. Eight databases, server,
primary and load client all in separate processes, on the machine `docs/performance.md` was measured
on. Two alternating rounds of each, the ablation discipline `docs/p3-wal-checksum.md` §2 settled on.

| workers | HTTP reads/s | socket reads/s |
|---|---|---|
| 1 | 34 320 – 34 879 | 257 887 – 261 533 |
| 2 | 56 653 | — |
| 4 | 55 890 | — |
| 6 | 54 386 – 54 552 | 232 004 – 232 582 |
| | **1.56 – 1.60x** | **0.89 – 0.90x** |

**Sharding a replica helps its HTTP reads by about 1.6x and *costs* its socket reads about 10%, and
both numbers have the same explanation: the router.** An HTTP request is parsed, authenticated and
answered on the worker, so moving it off the main thread buys real work — until two workers, after
which the ladder is flat because the *router's* accept-and-hop loop is the ceiling, not the thread
running the query. A socket frame is different: the router parses it far enough to route, posts it,
and writes the answer back, and a point read is 0.79 µs of work against a hop that costs more than
that. So the relay is pure overhead on the leg the brief assumed would benefit most.

That is worth saying plainly because the brief's premise — "a replica is stuck on one thread at ~50k
reads/s over HTTP and ~220k over a socket while six threads are idle" — is only half right. The
threads were idle, but the socket number was never thread-bound. The operator rule that falls out:
**shard a replica when its readers speak HTTP; leave it on one thread when they speak the socket
protocol.** C4c's value is that the choice now exists, and that a replica's *applies* are spread
across workers regardless of which surface its readers use.

### Verified by hand

A real single-threaded primary and a real three-worker replica, on real ports, exercised across a
shard boundary — and then a third node chained behind the replica:

- `hand0` on worker 1 and `hand2` on worker 0, both written on the primary, both streaming down
  **one** socket. Both landed on the primary's rolling checksum exactly —
  `2889329178172848414` and `15689029995943845998` — and both applied through C5's page mechanism,
  `"apply": "pages"` with a **zero-byte `-wal`**, so C4c did not cost the replica the read speed C5
  bought it.
- `GET /v1/db/{db}/replication` on the replica reported each shard's stream (`applied`, `lagTxid: 0`,
  `bootstrapping: false`) beside the connection state pushed down to it (`connected: true`, the
  primary's URL). `readyz` was one fact and it was `true`.
- A database created *after* the replica attached, on a third shard, was picked up and converged.
- **R2 across the channel:** `insert` sent to the *replica* was forwarded by the worker that owns
  the database, over the router's one socket, and came back with the primary's `txid`; the row was
  then readable on the replica.
- The replica killed mid-stream, four more writes on *each* shard, then brought back: it resumed
  from its own positions and both checksums matched again (`16201177646506151290` /
  `3105374262990630546`), with nothing in its log.
- **R7 across the channel:** `hand0` deleted on the primary was dropped on the replica (`404`) and
  the copy was trashed by the worker that owned it (`trash/hand0-1789249414767`), while `hand2` kept
  streaming on its own shard. `hand0` then re-created under the same name was bootstrapped again
  under a **new** generation id in the router's ledger, and served the new generation's rows.
- **Chained through a sharded node:** a third single-threaded replica following the three-worker
  replica converged on the primary's checksum (`10549037411101662930`) — and its `generations.json`
  holds *the same three identities* the middle node holds, not fresh ones. That is the push of §3.2
  doing its job; without it every node downstream of a sharded replica would re-bootstrap for
  nothing.

### The contract that moved, and it is the only one

`test/server/config.test.ts` asserted that `[server] workers = 4` beside `[replication] primary`
refuses to start. That refusal is what this milestone exists to lift, so the test now asserts the
opposite. **Nothing else was edited**: `test/wal/replication.test.ts`, every file under
`test/replication/` and both e2e replication scenarios pass unchanged, which is the signal that the
wire contract did not move.
