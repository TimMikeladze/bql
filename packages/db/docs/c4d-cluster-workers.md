# C4d — the Raft lease with `[server] workers > 1`

Phase-2, the last of C4 (`docs/c4-workers.md` §10, `docs/c4b-replication-workers.md` §6,
`docs/c4c-replication-follow.md` §7), design §5.3. Written 2026-09-12 **before any code**, for the
same reason C4, C4b and C4c were: the milestone is a decision before it is an implementation, and
the decision here is **what a lease deadline means on a thread that did not stamp it**, plus the
four questions the code cannot answer for itself.

## 1. The thing that is refused today

`loadConfig` refuses `[server] workers > 1` beside `[cluster] enabled` with `WORKERS_UNSUPPORTED`
(`src/server/config.ts`, `assertWorkers`):

> the Raft lease is consulted on the write path, which is now a worker, and a worker must not block
> on the control plane

It is the last `WORKERS_UNSUPPORTED`. C4b lifted serving replicas, C4c lifted following an upstream;
a clustered node is still stuck on one thread at 28 809 writes/s while five or seven cores sit idle,
and — the part that matters more — C3's placement cannot be built on top of a node that shards its
databases and cannot join a cluster at all.

## 2. The decision: the control plane stays whole on the router, and only the *deadline* crosses

C4b's rule was *the stream crosses the channel, not the tenant*. C4c kept it and reversed the
frames. C4d keeps it again and applies it to the one thing on the write path:

**The router owns the control plane — the `ClusterNode`, its Raft log, its socket, its timers,
`propose`, the lease cache, `#renewOwn`, `#failover` and `GET /v1/cluster`. The worker that owns a
database owns everything about that database the control plane needs told — the claim, the ack, the
promotion request, the demotion and the local flip — because every input to those is a tenant's.
What crosses for the write path is one thing and it crosses *downward only*: the lease deadline,
converted into the worker's own monotonic clock.**

```
                 router (main thread)                         worker k
                          │                                      │
   raft commit ──────────►│  #syncLeases                         │
                          │  cluster.view (dbs of shard k) ─────►│  deadline[db] = until + offset
                          │                                      │
                          │◄──── cluster.propose (claimDb) ──────│  Promoter.claim
                          │  ClusterNode.propose ────► raft      │
                          │  cluster.proposed ──────────────────►│
                          │◄──── cluster.promote (request) ──────│  Promoter.#requestFor: txid, epoch,
                          │  ClusterNode.promote ────► raft      │  generation, streamLive — all tenant
                          │  cluster.promoted ──────────────────►│  facts, all on this thread
                          │◄──── cluster.owned (shard k's dbs) ──│
                          │  setOwned(union of N shards)          │
                          │                                      │
   a write arrives ───────┼─────────── hopped ──────────────────►│  assertWritable:
                          │                                      │    one Map.get, one performance.now()
                          │                                      │    ZERO messages
```

**The hot path gains nothing.** `assertWritable` on a worker is the same `Map.get`, the same
`performance.now()` and the same two comparisons it is on a single-threaded node. A write costs no
`postMessage` at all, which is the whole of design §5.3's rule — *push the state down, never let a
worker block on the control plane* — and the reason this is a push and not a request.

**Everything that is not the write path is a round trip, and every one of them is already async.**
`claim`, `promote`, `ack` and `ensureLease` all `await` a Raft commit today. Adding a `postMessage`
in front of a quorum is not a cost worth designing around.

## 3. The four questions

### 3.1 What a deadline means on another thread — **measured, and it is not the same number**

This is the one thing in the milestone that could have been got quietly wrong, so it was measured
before anything else.

`LeaseHandle.validUntilLocalMs` is a deadline on `performance.now()`, and `src/cluster/node.ts`'s
header rests the whole safety argument on it: *only elapsed time is ever compared, and only ever
the holder's own*. The question is whether the router and a worker share that clock. **They do
not.** Each Bun `Worker` has its own `performance.timeOrigin`:

```
router timeOrigin 1789251013683.7058
worker timeOrigin 1789251013686.1711     → the worker reads 2.465 ms behind the router
```

and the offset is *constant* — 40 probes over 2 s, warm:

```
round trip                        min 0.0279 ms   max 0.2041 ms
offset, midpoint estimate         min −1.3405 ms  max −1.2762 ms   (spread 0.0643 ms over 2 s)
offset, lower bound (t2 − t3)     min −1.4425 ms  max −1.3204 ms
```

(The sign differs between runs — it depends on when each thread started — which is exactly why it
has to be measured rather than assumed.)

So a deadline **cannot cross verbatim**, and there are two ways to fix it. Only one is safe:

- **Push the remaining milliseconds and re-stamp on arrival.** `remaining = validUntilLocalMs −
  routerNow()` at post time, `deadline = workerNow() + remaining` at receipt. The error is the
  transit time, it is **in the unsafe direction** (it extends the lease), and it is unbounded: a
  worker whose event loop is blocked for 300 ms re-stamps 300 ms late and holds a lease the router
  considers expired. **Rejected.**
- **Measure the offset once and convert the absolute deadline.** `deadline = validUntilLocalMs +
  offset`, where `offset` is *the worker's clock minus the router's*. A deadline stays an instant
  rather than a duration, so a delayed message cannot extend it: a `cluster.view` that sat in the
  queue for 300 ms converts to a deadline 300 ms closer, which is correct. **This is what is
  built.**

The offset is measured with one round trip on monotonic clocks only — no wall clock anywhere, so
the module's invariant survives intact:

```
router  t1 = performance.now()  ──── cluster.probe ────►  worker t2 = performance.now()
router  t3 = performance.now()  ◄─── cluster.probe.reply ─────────────────┘
```

`t2` lies between the two instants the router stamped, so `t2 − t3 ≤ offset ≤ t2 − t1`. The worker
keeps **the greatest lower bound it has seen**, `max(t2 − t3)`, which is conservative by
construction: a deadline converted with a low offset is early, never late. The error is bounded by
one round trip — **28 µs to 204 µs measured** — against a `leaseGuardMs` of 500 ms, so it consumes
0.04% of a margin that exists to cover clock *rate* skew over a whole TTL.

Tightening the bound over time is sound because the offset does not drift: both origins are fixed
at thread start and both clocks are the same OS monotonic clock, which is what the 64 µs spread
over 2 s says. It is probed eight times at worker start and once per `leaseRenewMs` after that,
riding a tick that already exists.

**The invariant this preserves, restated for threads:** no node ever reads another node's clock,
and no thread ever reads another thread's clock. A worker reads a *bound on the difference* between
two clocks in its own process, which it measured itself, and rounds it in the direction that can
only shorten its own lease.

### 3.2 Who claims, acks and promotes — **the worker, because every input is a tenant's**

The alternative was to keep the whole `Promoter` on the router, which already has the catalog, and
push nothing but role changes down. It does not work, and `#requestFor` is why:

```ts
applied        = registry.open(db).txid      // the tenant's, on the thread that holds the writer
localEpoch     = registry.open(db).epoch     // likewise
localGeneration= runtime.generationOf(db)    // the replica client's ledger, or the catalog row
streamLive     = replica.connected && the stream for this db exists
```

Every one of those is worker state, and `#flip` — evict, detach, close, rewrite the catalog row,
reopen, announce — touches the tenant, the realtime engine and the replication client on the thread
that owns them. A router-side `Promoter` would need a round trip per field and a second round trip
to flip, which is C4b's rejected `Tenant` proxy wearing a different hat.

So **the `Promoter` runs on the worker**, over its own shard, and the two things it cannot do there
— put a command through Raft, and ask the Raft leader to decide a promotion — cross as round trips.
Neither is on the write path; both `await` a quorum on the far side already.

**A worker claims only the databases that hash to it.** `registry.list()` reads the catalog, which
is node-level and lists every database, so `claimAll` and `#reconcileClaims` on a worker would
otherwise claim all of them from all N threads — N claims per database, each naming this node, each
racing the other seven. `ServerRuntime` gains `owns(db)`, which is `true` everywhere except on a
worker, where it is `shardOf(db, workers) === index`. This is the same `assertOwned` rule
`entry.ts` applies to a hopped request, applied to a loop that iterates rather than to a message
that arrives.

### 3.3 What the router's own `Promoter` does about the cluster — **nothing**

The router's runtime has a `Promoter` and always will: `roleFor`, `nodeRole` and `primaryFor` answer
`BQL-Role`, `/healthz` and the `requirePrimary` gate on node-level routes, and none of those
touches a tenant. Its **control-plane half is off** in `"routed"` mode: no ack timer, no `claimAll`,
no `#reconcileClaims`, no `#reportPositions`, and `onClusterChange` returns immediately. A router
that claimed would be an eighth claimant with no copy of anything.

`setOwned` is the one place this cannot be a simple "off". `ClusterNode.#renewOwn` renews a lease
only for a database in `#owned`, and on a sharded node that set is spread across N workers. So each
worker posts `cluster.owned` with *its shard's* primaries and the router holds them **per shard and
unions them**:

```ts
#owned = new Map<number, string[]>()          // shard → its primaries
cluster.setOwned([...this.#owned.values()].flat())
```

Never a replace. A worker's set replacing the node's would drop the other N−1 shards' leases on the
floor at the next renewal tick and fail every database over for nothing. The shards are disjoint, so
a union is exact and not a summing rule that is a lie — unlike the S3 gauges in `docs/next.md`'s
known gaps, which is why those are still omitted and this one is not.

### 3.4 What `GET /v1/cluster` reports — **the router's, and it never moved**

`/v1/cluster` is not a `/v1/db/:db/…` route, so `isSharded` is false and the router answers it from
its own `ClusterNode` — the thread that holds the Raft log, the term, the leader and the transport.
It never touched a tenant, so nothing about it changes and there is no gather.

`POST /v1/db/{db}/promote` **is** a `/v1/db/:db/…` route, so it is already hopped to the worker that
owns the database — which is exactly where the promotion has to be decided locally and applied. Its
one remote step, the Raft leader's decision, is `cluster.promote` and back.

The worker's `ClusterLink.view()` answers `null`, and the route says so rather than inventing a
term and a leader it cannot know. In production nothing reaches it; if a routing bug ever does, it
reads *"the control plane is on the router thread"* instead of a plausible lie.

## 4. What crosses the channel

Added to `src/server/workers/protocol.ts`. Router → worker:

```ts
/** The shard's slice of the replicated state, after every commit that changed it. §3.1, §3.2 */
{ kind: "cluster.view"; id: string; nodes: [string, string][]; proposeTimeoutMs: number
  dbs: { db: string; primary: string | null; replicas: string[]; epoch: number
         lease: { node: string; until: number } | null; acked: Record<string, string>
         generation: string | null }[]
  /** Deadlines on the ROUTER's monotonic clock, for the leases this node holds. */
  hold: [string, number][] }
/** One leg of the clock probe. `t1` comes back untouched. §3.1 */
{ kind: "cluster.probe"; id: number; t1: number }
/** The lower bound the round trip established, which is what the worker converts with. §3.1 */
{ kind: "cluster.offset"; lower: number }
/** The answer to one `cluster.propose`. */
{ kind: "cluster.proposed"; id: number; ok: boolean; reason?: string }
/** The Raft leader's answer to one `cluster.promote`. */
{ kind: "cluster.promoted"; id: number; outcome: PromotionOutcome }
```

Worker → router:

```ts
{ kind: "cluster.probe.reply"; id: number; t1: number; t2: number }
/** A command for the log. Ids are the worker's, as `follow.forward`'s are. */
{ kind: "cluster.propose"; id: number; command: Command }
{ kind: "cluster.promote"; id: number; request: PromotionRequest }
/** This shard's primaries, for the router to union. Never a replace. §3.3 */
{ kind: "cluster.owned"; dbs: string[] }
```

Five down, four up, and **none of the nine is on the write path**. `cluster.view` is the only one
that is not a round trip, and it fires on a Raft commit — a few per second, carrying a few hundred
bytes of this shard's databases — never per record and never per write.

**Ids are minted by the worker for the two round trips it initiates**, and the router keys them by
`(shard, id)`. That is the rule `follow.forward` / `follow.result` already established; the pool's
"ids are the router's" invariant is about correlation, and a per-shard key correlates exactly as
well.

**The view is filtered to the shard.** A worker only ever answers for databases that hash to it —
`entry.ts` refuses anything else — so shipping the whole state N times would be N−1 shards of state
nobody on that thread may read. `primaryFor(db)`'s redirect is for a database the request named,
which is by definition this shard's.

## 5. The split, and where it is *not*

**`ClusterNode` is not split and gains nothing.** It is already the right shape: `propose` and
`promote` are async and `holdsLease` is a `Map.get`. The router runs it exactly as a single-threaded
node does.

**`Promoter` is not split either.** It runs whole on a worker and whole on a single-threaded node,
with its control-plane half switched off on a router. One copy of `#flip`, one copy of the claim
loop, one copy of the demotion — which is C4c's lesson, where a planned 600-line second class became
151 lines of adapter.

What is new is the seam between them:

```ts
/** What the `Promoter` needs from the control plane, wherever it is. */
export interface ClusterLink {
  readonly id: string
  readonly proposeTimeoutMs: number
  holdsLease(db: string): boolean
  knows(db: string): boolean
  epochOf(db: string): number | null
  primaryOf(db: string): string | null
  advertiseOf(node: string): string | null
  readonly state: ClusterState
  observeDbs(): ClusterViewDb[]
  /** The full view for `GET /v1/cluster`, or null on a worker — §3.4. */
  view(): ClusterView | null
  propose(command: Command): Promise<{ ok: boolean; reason?: string }>
  promote(request: PromotionRequest): Promise<PromotionOutcome>
  setOwned(dbs: Iterable<string>): void
  onChange(listener: () => void): () => void
  start(): Promise<void>
  close(): Promise<void>
}
```

`ClusterNode` implements it as it stands. `HostedCluster` (`src/server/workers/cluster.ts`)
implements it over the pushed view and the round trips — the mirror of `WorkerShards`, and short
for the same reason: it holds no decision, only a table it was given and two `postMessage`s.

`ServerRuntime.cluster` becomes `ClusterLink | null`, and `clusterMode` joins `replicationMode`:

- `"own"` — a single-threaded node: a real `ClusterNode`, a `Promoter` doing everything.
- `"routed"` — the router: a real `ClusterNode`, a `Promoter` whose control-plane half is off, and
  the view pushed to every worker on change.
- `"hosted"` — a worker: a `HostedCluster`, and a `Promoter` doing everything over its own shard.

## 6. Files

New:

| file | holds |
|---|---|
| `src/server/workers/cluster.ts` | `HostedCluster` (the worker's `ClusterLink`: the pushed table, the clock offset and its probe, the two round trips) and `clusterShards` (the router's side: the per-shard `owned` map, the view push, `propose`/`promote` relay) |

Touched:

| file | change |
|---|---|
| `src/cluster/node.ts` | `ClusterLink` and `RaftHandlers`; `observeDbs()` beside an `observe()` that now returns `ClusterView \| null`; `socket` returns null rather than throwing before `start()`; `onChange` takes a zero-argument listener |
| `src/cluster/index.ts` | export `ClusterLink` and `RaftHandlers` |
| `src/server/promote.ts` | `clusterMode` gates `onClusterChange` (and `startCluster` no longer calls `start` on a router); the claim loops and `#ownedNames` filter by `runtime.owns(db)`; `#flip` reports the role change |
| `src/server/runtime.ts` | `clusterMode`, `cluster: ClusterLink \| null`, `owns(db)`, `setRoleHandler`/`roleChanged`, `startCluster` per mode |
| `src/server/workers/protocol.ts` | the nine envelopes of §4 |
| `src/server/workers/pool.ts` | `ClusterHost`, `clusterView`/`clusterProbe`/`clusterOffset`/`clusterProposed`/`clusterPromoted`, `setClusterHost`, `RouterHost.roleChanged`, and the five inbound cases |
| `src/server/workers/entry.ts` | the `HostedCluster` wiring, `runtime.startCluster()`, `setRoleHandler`, and the five inbound cases |
| `src/server/app.ts` | `createRuntime` takes `clusterMode`/`clusterLink`/`shard`; the router's runtime is `"routed"`; build `ClusterShards` over the pool, probe and push after `startCluster`, and re-probe on the renewal tick; `RouterHost.roleChanged` refreshes the router's `Promoter` |
| `src/server/routes.ts` | `GET /v1/cluster` reads `view()` and refuses a null with the reason |
| `src/server/config.ts` | `[cluster] enabled` is no longer refused beside `workers > 1`; `assertWorkers` keeps only its range check |
| `src/server/errors.ts` | `WORKERS_UNSUPPORTED` removed: nothing can raise it any more |
| `bench/workers.ts` | `--cluster`, which makes each rung a one-node raft cluster |
| `docs/c4-workers.md` §10 · `docs/c4b-…` §6 · `docs/c4c-…` §7 · `docs/design.md` §5.3 · `docs/api.md` · `docs/next.md` · `docs/plan-phase2.md` | say what is now true |

## 7. What C4d does **not** do

**It does not place anything.** Which node a database lives on is C3, and the hole C2's
`assertWritable` leaves open — a database the control plane has never heard of is not gated, so two
nodes can both create `acme` — is still open and still C3's. C4d makes a sharded node able to *join*
a cluster; it does not change what the cluster decides.

**It does not widen the lease.** One lease per database, held by a node, renewed by the node that
holds it. A worker is not a lease holder and never appears in the state machine: `NodeId` is still
a node, and a node's shards are an implementation detail the cluster cannot see. This is deliberate
— a per-worker lease would put the shard function into the replicated state and make re-sharding a
Raft change.

**It does not move renewal.** `#renewOwn` stays on the router, because a renewal needs the lease
cache and `propose`, and neither is a tenant fact. A worker that is busy for 300 ms therefore does
not lose its lease — which is the second reason §3.1 converts an instant rather than re-stamping a
duration.

## 8. The oracle, and the tests

**The oracle is `assertWritable` itself: at no instant may two threads, on two nodes, both believe
they hold the same database's lease.** The single-threaded proof (`docs/c2-promotion.md`) rests on
the holder's deadline being at least `leaseGuardMs` earlier than the leader's `until`. C4d adds one
term to that inequality — the offset error, bounded above by one round trip — and the test that
matters is the one that measures it:

`test/server/workers-cluster.test.ts`:

- a three-worker node with `[cluster] enabled` starts (the refusal is gone), forms a one-node
  cluster, and writes to databases on **different shards**;
- `POST /v1/db` on a clustered sharded node returns only once the lease is held, and the very next
  statement is not a `503` (`ensureLease` across the channel — the race `routes.ts` line 669 exists
  to close);
- the clock probe's bound is a *lower* bound: with an injected offset, a converted deadline is never
  later than `routerDeadline + trueOffset`;
- a lease the router lets lapse stops writes **on the worker** with `NOT_PRIMARY`, and does so
  before the router would grant it elsewhere;
- `cluster.owned` unions: with three workers each holding databases, `ClusterNode`'s owned set is
  every primary on the node and a renewal keeps all of them;
- `GET /v1/cluster` on the router reports every database from every shard;
- `POST /v1/db/{db}/promote` hopped to a worker promotes, flips the catalog row on that worker, and
  is visible in `/v1/cluster` on the router;
- a two-node cluster, one sharded and one not, fails a database over between them.

`test/server/config.test.ts` — `[cluster] enabled` with `workers: 3` no longer throws, and a
`workers` that is not a count still does.

`test/cluster/*` and `test/server/promote*.test.ts` **must pass unchanged**: they exercise a
single-threaded node, whose `clusterMode` is `"own"` and whose `owns(db)` is always true. If they
need editing, the contract moved and that is the thing to report, not to edit.

Then, by hand: a real three-node cluster with one sharded member, `kill -9` the sharded primary and
watch the failover, `GET /v1/cluster` on each, and `bun run bench/workers.ts` against a clustered
sharded node to measure what the lease costs a write on a worker (it should cost what it costs on
one thread: one `Map.get`).

## 9. As built — what changed from this plan, and what it measured

Built 2026-09-12. `bun test` → **1410 pass, 2 skip, 0 fail** across 115 files (1400 before), and
**1408 / 4 / 0** with `BQL_WAL_NATIVE=0`. `bun run typecheck`, `bun run bytes` and
`bun run routes:check` clean.

**The decision held, and §3.1's measurement is the reason the milestone was cheap.** The clock was
probed before a line of the seam was written, and it answered the only question that could have
been quietly wrong. Everything after it was mechanical: `ClusterNode` gained an interface it already
satisfied, `Promoter` gained three guards, and `src/server/workers/cluster.ts` is **two small
classes and no decision** — a table the router pushed, an offset the worker measured, and two round
trips — which is C4c's `WorkerShards` lesson applied a second time.

**The write path is unchanged, and the bench says so rather than the prose.** `bench/workers.ts
--cluster` makes each rung a one-node Raft cluster, so every write consults a real lease on the
worker that took it:

| workers | plain | clustered |
|---|---|---|
| 1 | 34 782 writes/s | 34 126 |
| 2 | 56 756 | 56 292 |
| 4 | 86 659 | 86 919 |
| 6 | 86 754 | 86 573 |

Within noise at every rung, in both directions. That is what "one `Map.get` and one
`performance.now()`" is worth as a number.

**Four things came out differently from the plan:**

- **`cluster.offset` is its own envelope**, not a field on `cluster.view`. A probe answers on its
  own schedule, and an offset has to be able to arrive without a view — nine envelopes rather than
  eight.
- **`leaseDeadline` became `leaseFor`.** The plan had a new member returning only the deadline of a
  lease this node holds; `ClusterNode.leaseFor` already returns the cached handle, and the router
  reads `node === id` off it in the one place that pushes. One member on the interface instead of
  two, and the existing one.
- **`observe()` returns `ClusterView | null` rather than gaining an `observeDbs()` beside a
  non-null `observe()`.** Both exist, but the split is the other way round from §5: `observeDbs()`
  is the honest half both implementations have, and `observe()` is the half only a thread holding
  the Raft log can answer. `ClusterNode.socket` became null-returning for the same reason, so an
  upgrade arriving before `start()` reads a 503 with a sentence rather than a 500 with a stack.
- **A `role` envelope was needed, which the plan did not foresee.** `Promoter.#flip` rewrites a
  catalog row, and the *router* derives `BQL-Role` and the `requirePrimary` gate on `POST /v1/db`
  from its own read of that catalog — a read that hears no `onChange` for a row another thread
  wrote. Without it a sharded node promoted by failover keeps calling itself a replica for ever.
  It is C4d's to fix because C4d is what makes an automatic worker-side promotion reachable.

**The tests are split in two, and the split is the finding.** The integration cases start a real
clustered three-worker node and, in the last one, three of them and kill the primary — the lease
lapses, the raft leader grants it elsewhere, and the promotion happens on the worker that owns the
database there, with `['before'], ['after']` read back off the winner. But the two decisions
underneath fail *intermittently* through HTTP: a deliberately broken `setOwned` that replaces
instead of unioning **passed the three-second integration test**, because each shard takes its turn
inside a renewal window wide enough to forgive it. A test that a broken implementation passes is not
a test of it. So the union and the deadline conversion are asserted where they are decided, against
a fake pool and an injected clock — and both were then verified by breaking the implementation and
watching them fail.

**One thing this milestone deliberately did not do, and C3 should know it.** `assertWritable` still
does not gate a database the control plane has never heard of, so two nodes can still both create
`acme`. That is C3's hole to close and C4d changes nothing about it — except that the node closing
it may now shard its databases, which was the point of doing this first.
