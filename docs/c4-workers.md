# C4 — `workers: N`

Phase-2 milestone 4 (`docs/plan-phase2.md`), design §5.5. Written 2026-09-12, **before any code**,
because the milestone is a decision before it is an implementation: the registry, the realtime bus,
the replication socket and the Raft node are per-process singletons today, and where they end up is
the whole design.

## 1. Why

Write throughput is bound by the process, not by the database. `docs/performance.md` §5:

| | writes/s |
|---|---|
| 1 process, 8 databases | 17 214 |
| 4 processes, 2 databases each | 39 734 |

2.31x, with the load client itself likely the next limit. Spreading writes over more databases
*inside* one process changes nothing — 28.8k against 28.1k msg/s — because one thread owns every
writer. Reads are in the same position for a different reason: 219–259k reads/s on a socket against
an engine that does ~1.3M/s in process, so a single thread's framing is the ceiling there too.

`workers: N` is the change that makes one node use its cores.

## 2. What was measured before deciding

Everything below is from this machine (M5 Pro, macOS 26.6.2, Bun 1.4.0), reproduced in
`bench/workers.ts`.

**`reusePort` does not load-balance on macOS.** Four `Bun.serve` listeners bound the same port; all
200 connections went to the first. Design §5.5 said so and it is still true, so a design that puts
a listener in every worker cannot be exercised on the platform this is developed on.

**`node:cluster` does not help.** Bun reports `schedulingPolicy` 2 (`SCHED_NONE`) and ignores an
assignment of `SCHED_RR`: three forked workers bound port 46001 and all 60 connections went to one.
Node's round-robin accept — the thing that makes a single port work on macOS — is not implemented.

**`postMessage` is cheap under load and only slow at idle.** Between the main thread and a Worker,
with a request-shaped object:

| | |
|---|---|
| sequential round trip (one in flight) | 12.05 µs |
| pipelined (20 000 posted, drained) | **0.76 µs/op**, 1.32M ops/s |

**A thread that hops every request keeps most of its ceiling.** A `Bun.serve` that answers from its
own thread against one that posts every request to a Worker and awaits the reply:

| | direct | hopped | BunQL today |
|---|---|---|---|
| HTTP, 64 connections | 147 691 req/s | **127 911 req/s** | ~50 000 req/s |
| WebSocket, 32 sockets × 16 in flight | 463 363 msg/s | **307 413 msg/s** | 130 000 msg/s |

So a single thread that does nothing but frame and forward leaves 2.6x headroom over BunQL's
current HTTP ceiling and 2.4x over its WebSocket one. **The router is not the bottleneck** — which
is the measurement that decides §3, because the objection to a router was that HTTP framing at
35 µs would cap the node below what four processes already do.

**`bun:ffi` SQLite works in a Worker, and the cores are real.** Three Workers each opened a database
through `src/sqlite/` and ran DDL and DML. Then N Workers each inserting 200 000 rows into their own
file, wall-clock:

| workers | total rows/s |
|---|---|
| 1 | 3 045 108 |
| 2 | 4 813 468 |
| 4 | **8 425 842** |
| 8 | 10 240 726 |

2.77x at four. Bun Workers are OS threads with their own heap, and the FFI driver is per-thread, so
nothing about the driver has to change.

## 3. The decision

**A worker owns a shard of databases. The main thread is a router that owns the listener, every
socket, and every per-process singleton. Workers own no listener.**

Stated as the question `docs/next.md` poses it: *a shard of databases, not a shared listener via
`reusePort`.*

### Why not `reusePort`

It is dead on macOS (§2), which alone makes it undevelopable here. But the deciding reason is
structural: a listener in every worker means a WebSocket subscriber, an SSE reader, a replication
socket and a Raft peer can each land on **any** worker, so every singleton has to become an N-way
distributed object — a subscriber on worker 1 seeing commits from worker 2 becomes a
`BroadcastChannel` fan-out, the replication server becomes N partial servers each holding a socket
for databases it does not own, and the Raft node has to be elected among the workers of one process.
`reusePort` distributes *connections*, which is the easy half, and multiplies *singletons*, which is
the hard half.

A single accepting thread does the opposite. The singletons stay singular because they never leave
the thread that owns the sockets, and the only thing that has to be distributed is the one thing
this milestone exists to distribute: the databases.

### The shape

```
                       ┌──────────────────────────────────────────────┐
   clients ──────────► │  main thread — the router                    │
                       │  Bun.serve (the only listener)               │
                       │  WebSocket / SSE / replication / raft sockets│
                       │  catalog (_system.db), auth, revocations     │
                       │  node-level routes, realtime fan-out         │
                       │  owns no tenant writer                       │
                       └───┬───────────┬───────────┬──────────────────┘
                           │           │           │   postMessage
                    ┌──────▼───┐ ┌─────▼────┐ ┌────▼─────┐
                    │ worker 0 │ │ worker 1 │ │ worker 2 │   each a ServerRuntime
                    │ shard 0  │ │ shard 1  │ │ shard 2  │   minus the listener
                    └──────────┘ └──────────┘ └──────────┘
```

`shard(db) = xxHash3(db) % workers`. Stable, cheap, and computed the same way on both sides of the
channel, so the router and a worker never disagree about who owns a name.

**`workers = 1` is exactly today's process.** No Worker is spawned, no channel exists, and every
request is served in place. That is a property of the implementation, not an optimisation: the
default configuration must not pay a microsecond for a feature it is not using.

### What the router keeps, and why each one

| singleton | where | why |
|---|---|---|
| the listener | router | the only way to get one port on macOS (§2) |
| WebSocket and SSE sockets | router | `server.upgrade` can only happen on the thread that owns the listener, and Bun's pub/sub fan-out is per `Server` |
| realtime fan-out | router | a worker's `RealtimeBus` already takes a `Publisher` (`setPublisher`) — the worker's publisher posts to the router, the router calls `server.publish`. **This is the answer to "a subscriber on worker 1 must see commits from worker 2": there is no subscriber on a worker.** |
| the catalog `_system.db` | router **and** every worker | one file, WAL mode (`Database.open` sets it), `busy_timeout` 5000. Writes are rare and throttled — `#savePosition` is rate-limited by `positionIntervalMs`, not per commit — and readers never block writers in WAL |
| token minting and revocation | router | `POST /v1/tokens` and `DELETE /v1/tokens/{jti}` write the catalog and touch no tenant. Verification happens wherever the request lands, through the cache every thread has |
| the Raft node, `GET /v1/cluster`, promotion | router | control plane, no tenant needed |
| the replication server and client | router | **and this is the constraint that shapes §5** |

### What a worker owns

Everything that touches a database: the `Tenant`, its writer, its readers, its WAL recorder, its
log, its snapshots, its S3 shipper, its retention sweep, its realtime capture and its live queries.
A worker is a `ServerRuntime` built the ordinary way, with `createApp` over it, so **every existing
route handler runs in the worker unchanged**. It is never asked for a database it does not own —
the router routes by the same hash — and it asserts that again on arrival (`assertOwned`), because
the one failure this design must make impossible is two threads opening one file for writing.

## 4. What crosses the channel

Two envelopes, because the two callers are genuinely different and forcing one into the other's
shape would be a hack in both directions.

### 4.1 `http` — the whole request, serialised

```ts
interface HttpHop {
  kind: "http"
  id: number
  method: string
  url: string
  headers: [string, string][]
  body: Uint8Array | null
  /** Resolved once on the router; the worker trusts it and re-verifies nothing. */
  principal: Principal | null
}
type HttpReply =
  | { kind: "http.reply"; id: number; status: number; headers: [string, string][]; body: Uint8Array | null }
  | { kind: "http.open";  id: number; status: number; headers: [string, string][] }   // streamed
  | { kind: "http.chunk"; id: number; bytes: Uint8Array }
  | { kind: "http.end";   id: number }
```

The worker reconstructs a `Request`, runs it through its own route table, and serialises the
`Response` back. A streaming response — the SSE change feed, `GET /v1/db/{db}/dump` — comes back as
`open` + `chunk`\* + `end` and the router pipes it into a `ReadableStream`. Nothing about the
handlers changes, which is the point: the hop is below `wrap()` and above the socket.

The router hops **every `/v1/db/{db}/…` request**, plus `POST /v1/db` (by the name in the body) and
`DELETE /v1/db/{db}`. It serves `GET /v1/db` (a catalog read), the token routes, `GET /v1/cluster`,
`healthz`, `readyz`, `metrics` and `GET /v1/openapi.json` itself.

A hopped HTTP request carries its `Authorization` header and the worker authenticates it, through
the same cache every node has. A token is therefore verified once per shard rather than once per
node — the cost of not inventing a second trust path, and 28 µs once per token per worker.

### 4.2 The virtual socket — the WebSocket relay

A WebSocket cannot be hopped as a request/response pair: it has a baton-shaped transaction bound to
the socket's lifetime and a subscription whose results are pushed. **It does not need to be.**
`src/server/ws.ts` already declares everything it wants from a socket as an interface — `data`,
`readyState`, `send`, `subscribe`, `unsubscribe`, `close` — and so does `src/server/hrana/ws.ts`.
So the worker holds a *virtual* socket implementing exactly that, and `handleMessage`, `closeSocket`
and `drain` run against it **unchanged**:

```ts
class VirtualSocket {
  send(text)            { post({ kind: "ws.send", socket: this.id, text, bind: bindingsOf(text) }) }
  subscribe(topic)      { post({ kind: "ws.subscribe", socket: this.id, topic }) }
  unsubscribe(topic)    { post({ kind: "ws.unsubscribe", socket: this.id, topic }) }
  close(code, reason)   { post({ kind: "ws.shut", socket: this.id, code, reason }) }
}
```

The router parses each client frame only as far as routing needs — `db`, else the `tx` baton, else
the `sub` id — and answers `hello` and `ping` itself, since it owns the authenticator and a `hello`
that reached a worker would be answered N times. A baton and a subscription id are learned from the
two frames that mint them (`bind`), and forgotten when the frame that ends them goes past, so a
socket that opens a million transactions accumulates nothing.

`ws.data.owner` stays an object identity — it never leaves the worker that minted it — and a socket
that closes sends `ws.close`, so `rollbackOwned` runs on the thread that actually holds the writer.

The credential crosses as the **bearer token**, not a `Principal`: a `Principal` carries `scopeFor`,
a function, and structured clone cannot move one. Re-authenticating on the worker is the same code
path, revocation check included, rather than a second one to keep in step.

A libsql/Hrana socket is simpler still: `hranaUpgrade` fixes its database at the handshake, so the
whole socket is pinned to one worker and no frame of it is ever looked at.

### 4.3 Worker → router events

```ts
type WorkerEvent =
  | { kind: "publish"; topic: string; data: string }        // → server.publish, Bun's own pub/sub
  | { kind: "live"; socket: string; sub: string; data: string }  // per-subscription, one socket
  | { kind: "moved"; db: string; primary: string }
  | { kind: "metrics"; ... }                                 // drained by GET /v1/metrics
  | { kind: "error"; message: string }
```

`publish` is the whole cross-worker realtime story and it is three lines, because `RealtimeBus`
already has the seam and `ws.ts` already spells its topics exactly as Bun's pub/sub spells them
(`src/realtime/bus.ts`, first invariant — written in phase 0 for a reason that only pays off here).

## 5. The limitation this milestone does not lift — **lifted for replicas by C4b**

> **Update, 2026-09-12.** The refusal below was two-thirds right and one-third wrong. C4b
> (`docs/c4b-replication-workers.md`) lifted the replication half of it without the `Tenant` proxy
> this section proposed: **the *stream* crosses the channel, not the tenant**, so `tenant.onCommit`,
> `tenant.log.iterate`, `tenant.snapshot()` and `registry.pin` are still called on the thread that
> holds the writer, and the only thing on the channel is the finished frame. A three-worker node
> now serves replicas. `[replication] primary` and `[cluster] enabled` are still refused, each for
> its own reason — see C4b §6. The section as written stands as the analysis that led there.

**`workers > 1` refuses to start alongside replication or the cluster, and says why.**

`src/replication/primary.ts` serves a replica from the `Tenant` itself: `tenant.onCommit`,
`tenant.log.iterate`, `tenant.snapshot()`, `tenant.epoch`, `tenant.checksum`, `registry.pin`. One
replication socket follows databases across every shard, and the socket is on the router, which owns
no tenant. Serving it would mean a `Tenant` proxy with a dozen more methods on the channel —
including one that takes a snapshot and one that pins an LRU entry — and the checksum chain is the
oracle for all of it. That is its own milestone, not a corner of this one.

The same is true of the Raft lease on the write path (C2 consults it where the write happens, which
is now a worker) and of the replica applier (`ReplicaClient` writes pages into tenants).

So `loadConfig` refused, at startup, with `WORKERS_UNSUPPORTED`:

- `[server] workers > 1` with `[cluster] enabled = true`
- `[server] workers > 1` with `[replication] secret` set (this node serves `/v1/replication`)
- `[server] workers > 1` with `[replication] primary` set (this node follows one)

The error named the reason and pointed here. A standalone node — which is what the 17 214 → 39 734
measurement was taken on, and what the product's "many small databases" shape mostly is — got the
whole lever.

**All three are lifted, and `WORKERS_UNSUPPORTED` is gone from the vocabulary.** C4b serves
replicas, C4c follows an upstream and C4d joins a cluster; each is a document beside this one, and
each kept the same rule — what crosses the channel is the stream, or the lease deadline, never the
tenant. §10 says what each one decided.

S3 shipping, retention, snapshots and PITR are **not** on that list: they are per tenant and run in
the worker that owns it, unchanged.

## 6. Files

New:

| file | holds |
|---|---|
| `src/server/workers/shard.ts` | `shardOf(name, workers)` and nothing else, so both sides agree by construction |
| `src/server/workers/protocol.ts` | the envelopes of §4, and the encode/decode for them |
| `src/server/workers/pool.ts` | the router side: spawn, correlate, hop, drain events, shut down |
| `src/server/workers/entry.ts` | the worker side: build the runtime, serve envelopes, publish events |
| `src/server/workers/router.ts` | which paths are sharded, the routing name, and the socket relay |
| `bench/workers.ts` | the measurements of §2 and the throughput claim of §8 |

Touched: `src/server/config.ts` (`[server] workers`, and the refusals, which C4b, C4c and C4d have
since all lifted), `src/server/app.ts` (router mode), `src/server/metrics.ts` (`state`/`absorb`, so
counters can be added across threads), `src/server/hrana/index.ts` (`hranaTarget`, so an
upgrade can be routed before it happens), `src/cli.ts` (`--workers`), `docs/api.md`,
`docs/design.md` §5.5, `docs/performance.md` §5, `docs/next.md`.

**`src/server/ws.ts`, `src/server/routes.ts`, `src/server/runtime.ts` and `src/tenant/` are not
touched at all.** That is the measure of whether the seam was cut in the right place.

## 7. Config

```toml
[server]
workers = 1            # BUNQL_SERVER_WORKERS. 1 = today's single-threaded node.
                       # 0 = one per core, capped at 8.
```

## 8. Tests and verification

- `test/server/shard.test.ts` — the hash is stable, uniform enough, and total over a name set.
- `test/server/workers-protocol.test.ts` — every envelope round-trips, including a streamed body and
  a zero-length body.
- `test/server/workers.test.ts` — a node started with `workers: 3`: create databases that land on
  different shards, write to each, read them back, an SSE change feed crossing a shard boundary, a
  WebSocket subscription that sees a commit made by a different worker, a transaction over a socket
  that rolls back when the socket closes, and `GET /v1/db` listing every shard's databases.
- `test/server/workers-config.test.ts` — the three refusals of §5, each by code.
- Everything else must pass unchanged, because `workers: 1` is the default.

Then, by hand: a real three-worker node, exercised with `curl` and a WebSocket, and
`bun run bench/workers.ts` reporting writes/s at 1 against N workers.

## 9. As built — what changed from this plan, and what it measured

Built 2026-09-12. `bun test` → **1346 pass, 2 skip, 0 fail** across 107 files (1319 before);
`bun run typecheck`, `bun run bytes` and `bun run routes:check` clean.

**The result.** `bun run bench/workers.ts`, eight databases, 64 sockets, five seconds, server and
load client in separate processes:

| workers | writes/s | speedup |
|---|---|---|
| 1 | 27 272 – 28 809 | 1.00x |
| 2 | 46 964 | 1.63x |
| 4 | 67 867 – 68 572 | **2.38x – 2.49x** |
| 6 | **72 817** | **2.67x** |
| 8 | 66 502 | 2.44x |

The one-worker baseline reproduces `docs/performance.md` §5's own in-process figure — 28.8k msg/s
over eight databases — so the ladder is measured against the number this milestone exists to move.
It peaks at six workers on 18 cores and falls off at eight: the router is one thread, and eight
databases over eight shards is a lumpy split. **A single node on one port now does 72 817 writes/s
where it did 28 809, and more than the 39 734 four separate processes did in §5.**

**Four things came out differently from §4, and each is smaller than the plan:**

- **The `WsExecutor` of §4.2 was not needed.** `ws.ts` already declares what it wants from a socket
  as an interface, so a virtual socket satisfies it and `handleMessage`, `closeSocket` and `drain`
  run unchanged. `src/server/ws.ts`, `src/server/routes.ts`, `src/server/runtime.ts` and
  `src/tenant/` have no worker-aware line in them.
- **A `Principal` cannot cross a thread** — it carries `scopeFor`, a function — so the bearer token
  crosses instead and the worker authenticates it. §4.1 said the opposite; the code says this.
- **`server.fetch()` does not dispatch through Bun's `routes` table** (verified: it goes straight to
  the `fetch` fallback), so the worker compiles its own matcher from `app.routes` — `:param` and one
  trailing `*`, most-static-first. It is 40 lines and it matches the table it was built from.
- **Streaming is decided by the response**: `text/event-stream`, or a declared `content-length`
  above 1 MiB, streams as `open` + `chunk`\* + `end`; everything else crosses whole. That is what
  keeps `GET /v1/db/{db}/dump` from existing twice in memory and what makes the SSE change feed work
  through the router at all.

**Three fidelity losses worth knowing about, all in reporting rather than in data:**

- `GET /v1/db` reports `"open": false` for every database, because "open" is a fact about one
  worker's LRU and the router holds none. The rest of the row is the catalog's and is exact.
- `GET /metrics` on a router sums every worker's counters (`Metrics.state`/`absorb`) and the router's
  own. It omitted the replication and storage gauges; **C4b closed the replication half** with a
  summing rule per gauge (C4b §7) now that replication is no longer refused. The S3 shipper's
  gauges are still omitted: they are per worker with no summing rule that is not a lie.
- A hopped request body crosses as one `Uint8Array`, so `POST /v1/db/{db}/import` of a very large
  SQLite file is copied once more than it would be on a single-threaded node. `[limits]
  maxImportBytes` still bounds it.

## 10. C4b — what is left after this

- ~~A `Tenant` proxy over the channel, so `/v1/replication` can be served from the router for a
  database a worker owns.~~ **Done, and not as a `Tenant` proxy** —
  `docs/c4b-replication-workers.md`. The router owns the replication *connection* (the socket, the
  handshake, the frame reader, the queue, the heartbeat, the announcement) and the worker that owns
  a database owns that database's *stream*. Nothing that touches a tenant is on the channel; the
  hot path is one `postMessage` per `TXN`, which is what a socket on another thread costs and no
  more. A proxy would have made `onCommit` and `log.iterate` request/response per record, which is
  exactly how it would have got slow.
- ~~**C4c: following an upstream** (`[replication] primary`) with `workers > 1` is still refused.~~
  **Done** — `docs/c4c-replication-follow.md`. It is C4b mirrored: the router owns the one upstream
  connection (the socket, the reconnect, the proof, the frame reader, the generation ledger, R7's
  reconciliation, R2's forward queue) and the worker that owns a database owns that database's
  stream. It is **one class in three modes** rather than two classes — `ReplicaClient` runs `"own"`,
  `"routed"` and `"hosted"` — because `#resolveFollow`, the backoff and the ledger are the same
  logic in each and duplicating them is how the halves drift. The hot path is one `postMessage` per
  `TXN` down and one per `ACK` up, both irreducible. What it is worth is narrower than the premise:
  a replica's HTTP reads scale 1.60x and its socket reads *lose* 10%, because the router relays
  every frame and a point read is cheaper than the hop.
- ~~The Raft lease consulted from a worker (a push of the lease state down the channel, since the
  worker must not block on the control plane — design §5.3's whole premise).~~ **Done —
  `docs/c4d-cluster-workers.md`, and it was the last refusal.** The `ClusterNode` stays whole on the
  router and only the lease *deadline* crosses, downward, converted into the worker's own monotonic
  clock. The conversion is the milestone: each Bun worker has its own `performance.timeOrigin`
  (measured), so a deadline cannot cross verbatim, and it is converted with an offset the worker
  measures itself over a round trip and rounds in the direction that can only shorten a lease.
  Re-stamping a remaining duration on arrival was rejected — its error is unbounded transit time,
  in the unsafe direction. The write path costs **no message at all**: a clustered six-worker node
  does 86 573 writes/s against a plain one's 86 754.
- `maxOpenTx` is still 1 per database, which is SQLite and does not change here.
