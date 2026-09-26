# C3 — placement, and being told where to go

Phase-2 milestone 3 (`docs/plan-phase2.md`), design §5.3. Written 2026-09-12 **before any code**,
the last structural piece of phase 2. The decision is **what picks a database's home node, when it
is allowed to pick, and what a node does about a database that is not its**.

C4d is the prerequisite and is built: a node that shards its databases across worker threads can
join a cluster, so placement is not being designed on top of a node that cannot be in one.

## 1. What is missing today

C1 replicates membership and per-database state; C2 grants, renews and fails over a lease. Nothing
decides **where a database should live**. `DbState.primary` is whatever node happened to create it
and then claimed it, and three things follow from that:

- **A client that lands on the wrong node gets a `404`, not a direction.** `roleFor(db)` falls back
  to the node's own role for a name it holds no copy of, so a primary-configured node tries to serve
  a database that lives elsewhere and answers `DB_NOT_FOUND` — while the cluster knows exactly which
  node has it.
- **Two nodes can both create `acme`.** `Promoter.assertWritable` says so in its own docstring: a
  database the control plane has never heard of is not gated, because gating it would stop a node
  writing to a database it just created. Both nodes create, both claim, one clobbers the other's
  placement, and two files with the same name and different contents exist.
- **`rf` and `zone` are recorded and unread.** `[cluster] rf` defaults to 2 and nothing consults it;
  `zone` is written into the state machine by `#reconcileMembership` and read by nobody. Which node
  holds a copy of what is whatever the operator's `--replica-of` flags happened to say.

## 2. The decision: rendezvous hashing, decided at create, advisory afterwards

### 2.1 Rendezvous (HRW), not a ring

`place(db, nodes, rf)` scores every node with `hash(db ‖ 0 ‖ node)` and sorts descending. The top
node is the home; the next `rf-1`, subject to §2.2, are the replica set.

A consistent-hash **ring** is the textbook answer and is rejected. A ring needs virtual nodes to be
uniform (so a tuning parameter nobody will tune), a sorted structure rebuilt on every membership
change, and that structure kept identical on every node or two nodes disagree about where a
database lives. Rendezvous needs none of it: it is `argmax` over a loop, it is uniform without
vnodes, it moves only the minimum share of databases when a node joins or leaves, and it is a pure
function of `(db, the node set)` — which is replicated state every node already has. At a node count
in the tens the ring's only advantage, `O(log N)` lookup against `O(N)`, is not a quantity.

**The hash is `Bun.hash.xxHash3`, as `shardOf`'s is.** Unlike `shardOf`'s, this one's answer *is*
persisted — `placeDb` writes the chosen nodes into the log — so a change to the hash would place new
databases differently while leaving existing ones exactly where they are. That is a degradation of
balance, not a correctness problem, and it is the reason placement is recorded rather than
recomputed on every read.

### 2.2 Zone awareness: spread, then degrade

Walking the sorted list, a node whose `zone` is already represented in the chosen set is skipped.
If the walk ends with fewer than `rf` nodes — fewer zones than `rf`, which is every single-zone
cluster and every three-node cluster with `rf` 3 in two racks — it is walked again **without** the
zone constraint, taking the next highest scorers.

**Degrade, never refuse.** A two-node cluster in one zone with `rf = 2` must place both copies, not
answer "cannot satisfy the zone constraint". An operator who wants the refusal wants an alert, and
an alert is not a placement function's job.

### 2.3 Nothing is recorded, and that is the decision

The obvious design records the placement — `placeDb` with the home and the chosen replica set — and
it is **wrong**, for a reason found while writing this and worth stating plainly:

> `pickFailover` picks the candidate with the highest acked txid **from `DbState.replicas`**, and
> `ClusterNode.#failover` then calls `decidePromotion` with `hasCopy: true` for whatever it picked.
> That is sound today because `replicas` only ever gains an entry from `claimDb`, which a node
> sends about a copy it actually holds. Writing an *intended* replica set into that same field
> would make `replicas` mean two different things at once, and the failover path reads it as the
> stronger one — so a lapsed lease could be granted to a node that has never held a byte of the
> database.

So `DbState.replicas` keeps its one meaning — **nodes that have told the cluster they hold a copy**
— and the intended set is *computed where it is needed*, from membership every node already has.
There is no new command, no new field, no snapshot change and nothing for the two to drift apart
about.

**A recorded primary is never moved by a recomputation**, for the same family of reason. Moving a
primary means moving a file that is being written to; the only two things allowed to move one are
C2's failover (the lease lapsed, and the new holder already has a copy) and an operator's
`POST /v1/db/{db}/promote`. A membership change that makes some other node the *computed* home of a
live database changes nothing at all — the database is where it is, the cluster knows where from
`claimDb`, and every client is told. Rebalancing live data is not phase 2, and a placement function
that did it by returning a different answer is how a control plane corrupts a database.

## 3. The four questions

### 3.1 What a node does with a database it holds no copy of — **says where it is**

Today `roleFor(db)` answers the node's own role for an unknown name, so the request runs and ends in
`DB_NOT_FOUND`. With placement there is a better answer, and the machinery for it already exists:
`NOT_PRIMARY` carrying `BQL-Primary`, which `wrap()` turns into a **same-origin `307`** and which
the SDK already retries cross-origin (`docs/c2-promotion.md` argues out why it is same-origin only).

So: a request naming a database **this node has no copy of**, when the control plane **does** know
one and names a different node, is refused with `NOT_PRIMARY` and the location, before the route
runs. Not a new status, not a new code, not a new client contract — the one C2 built, reached by a
case that used to fall through it.

Unchanged: a name the cluster has never heard of is still `DB_NOT_FOUND`, because there is nowhere
to send the client. And a node that *does* hold a replica copy still serves reads from it, exactly
as it does today — being told where the primary is has never meant being refused a read.

### 3.2 Who may create a database — **the node the placement function names, and it is not a round trip**

`POST /v1/db` on a clustered node computes `place(name, members, rf)` from the committed membership.
If the home is another node, the create is refused with the same `NOT_PRIMARY` + location as §3.1,
so the client is redirected to the node that should own it rather than told "no".

**This closes the two-`acme` hole, and it closes it without a quorum on the create path.** Both nodes
compute the same home from the same replicated membership, so only one of them proceeds. The check
is a loop over the member list and a hash per member — no `propose`, no `await`, nothing on the
control plane.

Two guards on it, both of which are the difference between a safe gate and an unusable one:

- **A node that is not itself in the committed membership does not gate.** At startup `addNode` has
  not committed yet, and a node that refused every create until it had would make a cold cluster
  unable to create its first database.
- **A database that already exists locally is not re-gated.** The gate is on *creating*, not on
  serving; a database placed here before a node joined and changed the answer keeps working, per
  §2.3.

`[cluster] enabled = false` changes nothing: no members, no placement, every node creates what it
likes, which is the standalone product.

### 3.3 What is proposed — **nothing new, which is §2.3's consequence**

`Promoter.claim` already proposes `claimDb` on create and then takes the lease, and that is what
makes the cluster know where a database is. C3 adds no proposal to it: the gate of §3.2 is a local
function over replicated membership, the redirect of §3.1 reads the `primary` `claimDb` already
recorded, and the intended replica set is computed rather than stored (§2.3).

The consequence is worth naming, because it is what makes C3a small: **`src/cluster/` gains a pure
function and loses nothing.** No new command, no new `DbState` field, no snapshot version, no new
timer, and `test/cluster/state.test.ts` and `test/cluster/node.test.ts` are untouched.

### 3.4 Which node subscribes to which — **the replica set, and it needs more than one upstream**

This is the half of C3 that is not a pure function, and it is the reason C3 is **two commits**.

`[replication] primary` is one URL and `ServerRuntime.replica` is one `ReplicaClient` — one socket
to one upstream, following `["*"]` or a configured list. Placement makes that shape wrong: with
`rf = 2` over four nodes, a node is in the replica set of databases whose primaries are *different
nodes*, so it must hold a connection to each.

So `runtime.replica` becomes `runtime.replicas: Map<NodeId, ReplicaClient>` — **one client per
upstream node, not per database** — each with the follow list placement gives it, and the static
`[replication] primary` is the degenerate single entry with follow `["*"]`. `ReplicaClient` itself
does not change: it is already three modes and already takes a follow list, and one connection per
peer is exactly what it was built for. What changes is who owns the set, and every caller that says
`runtime.replica` today.

**C3a** is §2, §3.1, §3.2 and §3.3: the placement function, the redirect, the create gate, and
`rf`/`zone` finally read. It is complete and useful on its own — it is what closes the two-`acme`
hole and what stops a client being told `404` for a database the cluster can locate.

**C3b** is §3.4: the client map, and placement driving who follows whom. **Built — §7.**

## 4. Files

New:

| file | holds |
|---|---|
| `src/cluster/placement.ts` | `place(db, nodes, rf)` and nothing else: pure, no clock, no state, exhaustively testable — the same rule `raft.ts` and `promotion.ts` are held to, and for the same reason |

Touched, C3a:

| file | change |
|---|---|
| `src/cluster/index.ts` | export `place`, `PlacementNode`, `Placement` |
| `src/server/promote.ts` | `placementFor(db)`, `assertMayCreate(db)` (the create gate) and `assertPlacedHere(db)` (the redirect) |
| `src/server/routes.ts` | `createDb` asks the gate before it creates |
| `src/server/runtime.ts` | `tenant()` turns a `DB_NOT_FOUND` for a database the cluster places elsewhere into that direction — on the miss path only, so the happy path is untouched |
| `docs/api.md` · `docs/design.md` §5.3 · `docs/next.md` · `docs/plan-phase2.md` | say what is now true |

## 5. The oracle, and the tests

**The oracle for §2 is that every node computes the same answer**, which is what makes the create
gate safe without a quorum. `place()` is pure, so this is a property test rather than a cluster:
the same `(db, members, rf)` in any input order gives the same result; every node appears as home
for roughly `1/N` of names; removing a node moves only the databases that named it; adding one moves
only `1/N`.

`test/cluster/placement.test.ts` — uniformity within a few percent over 10 000 names, order
independence, zone spread when there are enough zones and graceful degradation when there are not,
`rf` larger than the cluster, `rf` of 1, an empty cluster.

`test/cluster/place-e2e.test.ts` — three real nodes: a database created on the node the function
names is created; the same name attempted on another node is refused with `BQL-Primary` naming the
home; a request for it on a third node is refused the same way rather than `404`; `GET /v1/cluster`
shows the replica set placement chose; a node joining does **not** move a live primary.

`test/cluster/*` and `test/server/promote*.test.ts` must pass unchanged except where the create gate
is the point.

## 6. As built — C3a

Built 2026-09-12. `bun test` → **1424 pass, 2 skip, 0 fail** across 117 files (1412 before).
`bun run typecheck`, `bun run bytes` and `bun run routes:check` clean.

**The plan changed once, while it was being written, and the change is the interesting part.** §2.3
originally said the leader would recompute replica sets and record them with `placeDb`. Reading
`ClusterNode.#failover` to find where that tick would go showed why it must not:

```ts
const pick = pickFailover({ ..., replicas: entry.replicas, ... })
const decision = decidePromotion({ ..., hasCopy: true, ... })
```

`hasCopy: true`, unconditionally, for whatever `pickFailover` returned out of `DbState.replicas`.
Sound today, because `replicas` only ever gains an entry from a `claimDb` a node sends about a copy
it holds. Recording an *intended* replica set in the same field would make it mean two things and
let a lapsed lease be granted to a node that has never held a byte. So **nothing is recorded**: the
intended set is computed where it is needed, from membership every node already has, and
`src/cluster/` gained a pure function and lost nothing — no command, no `DbState` field, no
snapshot version, no timer.

**`src/cluster/placement.ts` is 105 lines and the rest of C3a is two guards.** `assertMayCreate` on
`POST /v1/db` and `assertPlacedHere` reached from `ServerRuntime.tenant` — and only on the
`DB_NOT_FOUND` path, so the happy path pays nothing at all for it.

**What the tests found.** Four existing cluster tests created `acme` on `servers[0]` and the gate
refused them, which is the contract moving on purpose: only the node the function names may create.
They now ask the same function the cluster asks (`nameOn` / `homeServer` in the harness) instead of
assuming the first node, which is a better test of a failover than one that was quietly relying on
placement not existing.

`test/cluster/placement.test.ts` asserts the property that matters — order independence, uniformity
within a few percent over 10 000 names, and that removing a node moves **exactly** the databases
that named it and no others, which is the whole reason rendezvous was chosen over a ring.

## 7. As built — C3b

Built 2026-09-12. `bun test` → **1454 pass, 2 skip, 0 fail**. `bun run typecheck`, `bun run bytes`
and `bun run routes:check` clean.

`ServerRuntime.replica` became `#clients: Map<url, ReplicaClient>` with `replicaFor(db)`,
`replicaClients`, `ensureUpstream(url, follow)` and `dropUpstream(url)`; `replica` stays as the
statically configured one (or the first), so every caller that asks about the *node* rather than a
database is unchanged. `src/server/follow.ts` is the planner: it reads the placement, groups the
databases this node should follow by the node that holds each, and reconciles the client map. It
**plans, it does not place** — it proposes nothing, reads `claimDb`'s record first and falls back to
`place()` only for a database nobody has claimed a copy of yet.

`ReplicaClient` did not change shape, as §3.4 predicted: it is already three modes and already takes
a follow list. It gained `setFollow`, because placement moves a database between upstreams without
the connection changing.

**A sharded node follows several upstreams too.** Every `follow.*` envelope carries `up`, the
upstream it belongs to, and a worker keeps one hosted client per upstream — the mirror of the
router, which keeps one `WorkerShards` per upstream. Verified on three sharded nodes at `rf = 3`:
each holds exactly two upstreams, each connected, each carrying the right stream.

### 7.1 Three bugs this milestone found, all of them from one thread's view being taken for the node's

- **R7 trashed a copy another upstream was feeding.** `#resolveFollow` builds its held set from
  `#byDb` *and the generation ledger*, and the ledger is **node-level** while an announcement is one
  upstream's — so the client for A saw a database B was feeding, missed it in A's announcement, and
  took the copy to the trash underneath a live stream. Measured, not imagined: a three-node cluster
  at `rf = 2` did it on the first run. A client may now only unfollow a database it is responsible
  for, which is its own follow list when that list is explicit; `["*"]` keeps today's behaviour
  exactly and is every statically configured replica.
- **Workers planned.** The guard was in `start()`, but the cluster's `onChange` reaches `plan()`
  directly, so each worker opened its own socket to every upstream. The guard belongs where the
  decision is.
- **The router's `roleFor` is stale for a replica row a worker created.** C4d's `role` envelope
  covers a *flip*; a bootstrap **creates** the row instead, and that reaches no `onChange` on the
  router — so `roleFor` still answered "primary" for a database this node holds a replica copy of.
  The planner now reads the catalog row, which is true on every thread, and the router refreshes its
  `Promoter` when a worker's database set moves (`repl.announce`), which also fixes `BQL-Role`.

### 7.2 What C3b changed about C3a's tests, and why that is right

Two `place-e2e` cases asserted a `503` from a node that now **holds a replica copy** — because C3b
gives it one. A node with a copy answers a create with `409` (it exists) and serves a read locally,
which is what a replica is for. The cases now target the node that holds nothing, and with `rf = 2`
over three nodes there is exactly one.
