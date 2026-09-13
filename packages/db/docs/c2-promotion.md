# C2 — promotion and failover

Companion to `docs/plan-phase2.md` §C2. This file is the design, then the record of what was
built, every deviation, and the things it deliberately does not do.

The one sentence: **a replica becomes a primary for one database, the old primary is fenced by an
epoch it no longer holds, and no two nodes ever believe they are the primary for that database at
the same instant.**

## The shape of it

| piece | where | what it guarantees |
|---|---|---|
| `decidePromotion` | `src/cluster/promotion.ts` | pure. Given the lease, the epoch, the applied txid and the generation, says yes with an epoch or no with a reason. No clock, no socket, no I/O |
| `pickFailover` | `src/cluster/promotion.ts` | pure. The replica the leader hands a lapsed lease to: highest acked txid among the reachable placement, ties broken by node id |
| `ClusterNode` lease renewal | `src/cluster/node.ts` | the **holder** asks for its own renewal, so a holder that has died stops renewing and its lease lapses |
| `ClusterNode` failover | `src/cluster/node.ts` | the leader, on its own wall clock, grants a lapsed lease to `pickFailover`'s answer |
| `Promoter` | `src/server/promote.ts` | the local flip: detach the stream, fold the WAL, rewrite the catalog row, reopen as a primary |
| `assertWritable` | `src/server/runtime.ts` | one synchronous, allocation-free check on the write path |

## The safety argument, in full

Two nodes must never both accept a write for one database. The argument has three legs.

**Leg 1 — the lease is the only licence to write.** A clustered node that is primary for `db`
refuses every write unless `leaseFor(db)` names it and `performance.now() < validUntilLocalMs`.
That check is a `Map.get`, a `performance.now()` and two comparisons; it is on the write path and
nothing else about the control plane is.

**Leg 2 — the holder's deadline is strictly earlier than the leader's.** The holder stamps
`validUntilLocalMs` from **the moment it asked for the renewal**, not from the moment the grant
came back:

```
holder:  t_ask (its own monotonic clock)      deadline = t_ask + ttl - guard
leader:  t_grant >= t_ask (real time)         until    = leaderWall(t_grant) + ttl
```

Because `t_grant` is after `t_ask` in real time, the holder's deadline is earlier than the
leader's `until` by at least `guard`, whatever the offset between the two wall clocks — no node
ever reads another node's clock, only elapsed time on its own. The guard therefore has to cover
only **clock rate skew over one TTL**, and 500 ms of 3000 ms is a factor of six more than any
machine drifts.

> C1's header in `src/cluster/node.ts` claimed the holder's deadline was already earlier "because
> the grant had to commit and reach it". That is backwards: stamping *later* makes the deadline
> *later*. With `t_grant` as the stamp the margin is `guard - (t_grant - t_ask)`, which a slow
> commit can eat. C2 stamps at `t_ask` and the header now says so.

**Leg 3 — the leader does not grant elsewhere before `until`.** `pickFailover` returns `null`
while `nowMs < lease.until` on the leader's own wall clock. So the earliest another node can hold
the lease is `until`, and the old holder stopped at `until - guard` at the latest. The window in
which both could write is negative by `guard`.

Everything else — the epoch, `EPOCH_AHEAD`, the demotion — is **recovery**, not safety. It is what
makes a fenced node notice and stop being wrong; the lease is what makes it harmless in the
meantime.

For a **static topology** (`--replica-of`, no `[cluster]`) there is no lease and no leader, and
promotion is exactly as safe as the operator: `POST /v1/db/{db}/promote` is an assertion that the
old primary is gone. The epoch still fences it if it comes back and tries to stream.

## The promotion decision

```ts
decidePromotion({
  db, node, hasCopy, isPrimaryLocally, localGeneration, placedGeneration,
  applied, localEpoch, streamLive, cluster, force,
}): { ok: true; epoch; why } | { ok: false; code; why }
```

Refusals, in the order they are checked:

| code | when | why it is not just a warning |
|---|---|---|
| `NO_COPY` | this node holds no copy of the database | there is nothing to promote |
| `GENERATION_MISMATCH` | the copy's generation id is not the one the cluster placed | R7 (`082f651`): the name is not the identity. Promoting a copy of the *previous* `beta` would resurrect exactly the bug R7 fixed, and the txids would agree while doing it |
| `STREAM_LIVE` | static topology only: this node is still streaming the database from its primary | the stream is proof the primary is up, and there is no lease to consult in a static topology. Promoting against a live primary is the two-writers case |
| `LEASE_HELD` | another node's lease is still live on the leader's clock | this is the guard, and the reason the decision is taken on the leader |
| `ALREADY_PRIMARY` | this node already authors transactions for it and (in a cluster) holds a live lease | a no-op that would otherwise bump the epoch and re-snapshot every replica |
| `BEHIND` | another node has acked a higher txid | promoting here throws away transactions the cluster knows exist |

`force: true` overrides `STREAM_LIVE`, `LEASE_HELD` and `BEHIND`, and nothing else — the other two
are not about whether promotion is safe but about whether it is possible at all.

`ok` carries the epoch the `grantLease` command must name: `max(cluster.epoch, localEpoch) + 1`
when the holder changes, `max(cluster.epoch, localEpoch)` when it does not (a lapsed holder
re-taking its own lease fences nobody, so it must not burn an epoch). In a static topology it is
`localEpoch + 1`.

The function is exhaustively tested without a cluster, a socket or a clock, the way `raft.ts` and
`logRetentionFloor` are.

## The local flip

`Promoter`'s `#flip(db, "primary", epoch)` — the order matters and each step is there for a reason:

1. `runtime.evict(db)` — roll back open transactions, close the realtime engine. The engine
   captured `replicaMode` at construction and drives itself off `afterApply`; a promoted database
   needs the `afterCommit` engine instead, so it has to be rebuilt rather than reconfigured.
2. `replica.detach(db)` — `UNSUBSCRIBE`, drop the stream, release the `"replication"` pin, **keep
   the local copy and its generation**. This is deliberately *not* `#unfollow`, which deletes the
   copy to trash — the copy is the thing being promoted.
3. `registry.release(db)` — closes the tenant. `Tenant.close()` on a replica runs the applier's
   `TRUNCATE` checkpoint and saves a zeroed WAL marker, which is what makes step 5 clean: the
   database file *is* the state, so the reopened recorder starts on an empty WAL instead of
   re-reading the applier's frames as if they were new transactions.
4. `catalog.setRole(db, "primary")` and `catalog.setEpoch(db, epoch)`.
5. `registry.open(db)` — reopens as a primary. `openRecorder` sees the zeroed WAL marker
   (`fileIsState`), finds nothing to tail, and the recorder starts at the applied txid with the
   new epoch.
6. `replication.announce()` — downstream replicas learn this node now holds the database.

A promotion that the control plane refuses never reaches step 1: the decision is taken first and
nothing local is touched.

## Demotion — the old primary

`EPOCH_AHEAD` already exists: a primary answers it when a subscribing replica claims an epoch
higher than the one this node holds. Today it writes an error frame and the stream stalls. C2
makes the outcome a **demotion**, because an epoch ahead is proof that somebody else was granted
this database after this node was:

1. the database is put into replica mode locally (the mirror of the flip above), so every write
   path answers `NOT_PRIMARY` from that instant,
2. the subscribing node is recorded as where the database went, so `BunQL-Primary` points at it,
3. if this node knows an HTTP base for the new primary it also re-follows it, so the demoted node
   converges without an operator.

The same demotion fires from the control plane: a clustered node that sees a committed
`grantLease` naming another node for a database it is primary for demotes at once.

A demoted node does **not** die. Its copy is a valid replica copy at some txid; the new primary
will either stream onto it or, if the two diverged over the lost tail, send a snapshot — the
existing `DIVERGED` path, unchanged.

## Clients

| transport | what a client sees |
|---|---|
| HTTP, the node knows an HTTP base for the new primary | `307` with `Location` and `BunQL-Primary` |
| HTTP, the node knows only a `ws://…/v1/replication` (static topology) | `503 NOT_PRIMARY` with `BunQL-Primary`, exactly as phase 1 |
| WebSocket | a `{"event":"moved","db":…,"primary":…}` frame to every socket subscribed to that database |

### Retrying a write — the sharp edge

The SDK retries **once**, against the node the answer names, and **only** on:

- `307` — the node did not run the statement; it refused before executing.
- `503 NOT_PRIMARY` carrying a `primary` that is not the node just addressed.

It never retries:

- `504 FORWARD_TIMEOUT` or a socket that dropped mid-forward. `docs/next.md` records what these
  mean: **may or may not have committed**. A blind retry double-applies an `insert`.
- `503 ACK_TIMEOUT`. The transaction committed; only the durability promise failed.
- anything inside an interactive transaction. A baton is node-local, so a statement retried
  elsewhere would run outside the transaction it belongs to.

The reason `NOT_PRIMARY` is safe and `FORWARD_TIMEOUT` is not is worth stating plainly: every
producer of `NOT_PRIMARY` refuses **before** a statement runs — `requirePrimary` before the body
is read, `assertWritable` before `tenant.write`, `Tenant.#assertPrimary` before the writer is
taken, and the `Forwarder` before a frame goes out. There is no path on which a write executes and
then answers `NOT_PRIMARY`. `FORWARD_TIMEOUT` is the opposite: it is raised precisely because this
node does not know what happened.

## Durability: what failover with `ack: "local"` costs

`[durability] defaultAck` is `local` (design §13 #9, settled). A write answered `local` is durable
on **one** node. Failover picks the replica with the highest acked txid, which is the best any
replica has — but the primary may have committed and answered transactions past that point which
no replica ever received. Those transactions are lost when the primary is.

The bound is replica lag, typically under a millisecond on a LAN. It is not zero, and the loss is
silent: the new primary starts at its own txid and nothing reports a gap. `ack: "replica"` or
`"quorum"` makes it impossible, at the cost of a round trip per write. `docs/api.md` says this
where promotion is documented.

## What was found on the way

Four things this milestone had to fix that were not in its brief.

**1. C1's transport dialled a peer's root path.** `[cluster] advertise` is documented as
`ws://host:port` — it is also the HTTP base clients are redirected to — while a peer entry names
the raft socket. `ClusterNode.#syncPeers` fed the state machine's `advertise` addresses straight
into `RaftTransport`, which dialled `ws://host:port`, got a failed upgrade, closed, redialled, and
never delivered a heartbeat. A three-node cluster re-elected every two seconds and no proposal
ever committed. C1's own test never saw it because it passed `advertise` *with* the path.
`raftUrl()` in `src/cluster/transport.ts` normalises either form, at the one place that dials.

**2. A promoted node re-minted its database's identity.** `generationId` is derived from the
catalog row — name, `created_at`, page size — and a replica's row was created *here*, not on the
primary. So a promoted node announced a different generation for the same database, and every
other replica saw a generation change, ran R7's unfollow, and trashed a perfectly good copy. The
fix is that a copy this node *received* keeps the id it was bootstrapped under:
`ReplicaClient.generationOf` is the source, `ServerRuntime.generationOf` is the one precedence, and
both the replication announcement and the control-plane claim read it. This also fixes chained
replication, where the same re-minting made every hop a fresh bootstrap — and it is why
`GET /v1/cluster` shows the same `generation` before and after a failover.

**3. C1's lease arithmetic was off by the commit latency.** The header claimed the holder's
deadline was already earlier than the leader's "because the grant had to commit and reach it",
which is backwards. Stamping at the *ask* rather than at the grant is what makes the margin
unconditional; see the safety argument above.

**4. A tenant swapped between roles was reported as a fault.** `#flip` closes a tenant and reopens
it in the other role; the primary's stream sweep saw a closed tenant under a live stream and logged
it, which is right for a database that has gone and wrong for one that was deliberately swapped.
The sweep now tells the two apart by asking whether the registry holds an open tenant of that name.

**5. A claim that could not reach the leader was lost for good.** The raft transport drops rather
than queues, by design, so a proposal a follower makes across a dead socket — at start, or over an
election — simply vanishes. Nothing noticed: the node never appeared in its own database's
placement and a failover had no candidate to pick. Claims are now a convergence loop on the same
one-second timer that reports positions, with conditions that all read "the cluster does not yet
agree with what this node is".

## A note for anyone writing a test that promotes

`await primary.close()` resolves when the **primary** has stopped listening. It says nothing about
when the **replica** has noticed: the socket's `close` event reaches the client asynchronously, and
measured on Linux the replica still reports `connected` in *every* round at the instant `close()`
returns. One HTTP round trip is usually enough of a yield for it to land, which is why a test that
promotes over HTTP normally passes — and why it fails on a loaded CI runner, where it sometimes is
not.

A promotion asked for inside that window is refused `STREAM_LIVE`, correctly: the replica can still
see its primary, and promoting against a live primary is the two-writers case this milestone
exists to prevent. So a test must establish the precondition — `untilPrimaryLost(replica)` in
`test/replication/harness.ts` — rather than assume `close()` implies it.

Nothing promotes a node on its own without `[cluster]`. `#flip(db, "primary", …)` has three callers
and two of them return early when `runtime.cluster` is null; the third is the route.
`Promoter.start()` installs no timer without a cluster, and `src/tenant/registry.ts` only ever
writes the role `"replica"`. `test/replication/promote.test.ts` asserts the role is still `replica`
after the primary has gone and before the operator promotes.

## Deviations from the brief

- **`307` is same-origin only.** The brief and design §5.3 ask for `307` + `BunQL-Primary`.
  Answering `307` across nodes is actively worse than `503`: following a cross-origin redirect
  strips `Authorization` (Fetch standard), so `fetch` follows it, the new primary answers `401`,
  and the client cannot tell why. So the redirect is answered when the target shares the request's
  origin — one load balancer in front of the cluster, which is the deployment §5.3 describes — and
  `503 NOT_PRIMARY` with `BunQL-Primary` and `Location` otherwise. The SDK replays either.

- **C1 left its server wiring undone.** `docs/plan-phase2.md` puts the `[cluster]` section,
  `GET /v1/cluster`, `bunql cluster` and the raft socket in C1; the commit message says they are
  "a separate milestone". C2 cannot be exercised without them, so they are here.

- **The write path gate is in `src/server/exec.ts`.** That file is not in C2's owned list, but it
  is the one choke point every write reaches — the native routes, the socket, Hrana, the data API
  and a forwarded write. Three one-line calls next to `assertAckAvailable`, which is the existing
  refuse-before-writing check. Gating only the routes C2 owns would have left the socket and Hrana
  writing without a lease.

## What this milestone does not do

- **Placement.** A database enters the control plane when a node claims it, not because a hash
  says it belongs there. `rf`, zones and consistent hashing are C3.
- **Cross-database promotion.** `POST /v1/db/{db}/promote` promotes one database. Promoting a
  whole node is a loop in the CLI, not a route.
- **Automatic re-follow in a static topology.** A fenced node with no `[replication] primary` and
  no cluster is left serving reads and saying where the database went. It has no way to learn a
  URL, and inventing one from a `SUBSCRIBE` frame would let any peer redirect a node's writes.

- **Gate a database the control plane has never heard of.** `assertWritable` refuses only for a
  database the cluster knows, so a node that has just created one can write to it before the claim
  commits. Two nodes that both create `acme` locally would both write to their own. Closing that
  properly is placement, which is C3; until then a database is claimed by whoever holds it.

- **Batch lease renewals.** Each database's holder proposes one `grantLease` per `leaseRenewMs`,
  so a node holding a thousand databases writes a thousand Raft entries a second. Fine at the scale
  C2 is built for and wrong at the scale phase 2 is aiming at; one command carrying many databases
  is the obvious fix and belongs with placement.
