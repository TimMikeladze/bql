# R2 — durability, routing and replica realtime (as built)

Companion to `docs/plan-phase1.md` (the spec) and `docs/r1-replication.md` (the transport R2 is
built on). This file records what R2 actually built, every place the code deviates from the plan
and why, and the seams R3 and a phase-2 cluster will need.

## What ships

| module | invariant |
|---|---|
| `src/replication/ack.ts` | an ack waiter counts distinct replica *nodes*, and nothing it does can un-commit a transaction. |
| `src/server/forward.ts` | a write a replica cannot take is executed exactly once, on the primary, under the caller's own principal. |
| `src/server/runtime.ts` | one interactive transaction per database at a time; the next one waits its turn instead of failing on arrival. |
| `src/realtime/index.ts` | a replica's realtime is driven by `applyRecord`, because it has no hooks to drain. |
| `src/wal/snapshot.ts` | a snapshot records the *tenant's* position, so an applier seeded from it can verify the next record. |
| `src/replication/primary.ts` | a database that exists is a database the replicas have been told about. |

## 1. `ack: "replica" | "quorum"`

`AckLevel` is now `"local" | "fsync" | "replica" | "quorum"`. `AckTracker` subscribes to
`ReplicationServer.onAck` and keeps the highest acked txid per `(db, node)`; `wait(db, txid,
level)` resolves once enough distinct nodes are at or past that txid, bounded by
`replication.ackTimeoutMs`.

- On expiry: `503 ACK_TIMEOUT`, carrying the txid that committed plus `acks` and `needed`. The
  transaction is not rolled back — it is committed and fsynced locally, and the only honest thing
  to report is that the *promise* was not kept.
- With no replica attached: `503 NO_REPLICAS` by default (`replication.ackWithoutReplicas`), or
  answered locally with `"allow"`. The check runs before the statement executes wherever the
  caller knows the level in advance, so the usual misconfiguration costs no write.
- The level comes from the body, then `BunQL-Ack`, then `durability.defaultAck`, over HTTP, the
  WebSocket and batches; an interactive transaction takes the node default at commit.

### Deviations

1. **Quorum is a majority, not the plan's formula.** `plan-phase1.md` writes the quorum size as
   `ceil((replicas + 1) / 2)` *counting the primary*. At one replica that is `ceil(2/2) = 1`,
   i.e. the primary alone — which makes `quorum` strictly weaker than `replica` and means
   "quorum" promises nothing at the most common cluster size. The code needs
   `floor((replicas + 1) / 2)` replica acks, which is a real majority of primary + replicas
   (2 of 2, 2 of 3, 3 of 4, 3 of 5) and is never weaker than `replica`. `test/replication/ack.test.ts`
   pins the table.

2. **`replica` and `quorum` fsync locally too.** The plan does not say. A primary that counts
   itself as one member of a quorum has to hold the record on disk, or the quorum it claims is one
   node smaller than it says. `Tenant.write` treats all three non-`local` levels the same way; the
   extra wait is one `fdatasync`.

3. **The waiting happens in the server, not in the tenant.** `Tenant.write` is the 27 µs path and
   is synchronous; making it `async` for a level that only sometimes applies would cost every
   write a microtask. So `exec.ts` refuses an impossible level before the write
   (`runtime.assertAckAvailable`) and the routes await `runtime.awaitDurable` after it. The
   consequence to know: a caller of `Tenant.write` directly — the embedded API — gets `fsync`
   durability from `ack: "replica"` and no remote wait at all.

4. **An ack from a node that has since disconnected still counts.** It fsynced the record; that
   promise does not expire when its socket does. `replicaCount` only counts attached nodes, so the
   *required* count can fall while a wait is in flight, which resolves it rather than failing it.

## 2. Write forwarding

`replication.forwardWrites` (default true) turns R1's `503 NOT_PRIMARY` into a round trip over the
socket the replica already holds: `FORWARD` out, `RESULT` back, `src/server/forward.ts` on both
ends. The replica classifies with `sqlite3_stmt_readonly` on a pooled reader — the same call the
local path makes — so reads never leave the node.

### Deviations and decisions

5. **Interactive transactions forward, whole.** The plan allowed refusing them with a documented
   `NOT_PRIMARY`. Reading the code, the lifecycle is four ops over one baton and the baton already
   identifies the database on its own, so forwarding it is a table of remote batons on the replica
   and nothing else: `tx.begin` returns the *primary's* baton, which is handed to the client
   unchanged, and `tx.exec`, `tx.commit` and `tx.rollback` forward to it. It is the difference
   between "a replica serves everything" and "a replica serves everything except the one API an
   ORM reaches for", so it was worth the ~80 lines.

6. **The principal crosses the wire as its claims, not its token.** Two nodes share a cluster
   secret, not JWT key material — the test harness's two nodes generate independent keys, and so
   does any real pair unless an operator copies `keys.json` — so re-authenticating the token on the
   primary would fail for reasons that have nothing to do with the client. The forward carries
   `{kind:"admin"}` or `{kind:"token", claims}` and the primary rebuilds it with `tokenPrincipal`,
   applying the same scope and table ACLs it would locally. The trust boundary is the `HELLO`
   handshake; a peer that completes it can already read every database on the node.

7. **Errors are mapped on the primary, not on the replica.** `RESULT.error` carries
   `{code, message, status, txid?, failedIndex?}` — the HTTP shape, already decided — so the client
   sees `SQLITE_CONSTRAINT_PRIMARYKEY` with its 409 rather than a transport wrapper.
   `ResultBody.error` in `protocol.ts` gained the three extra fields; a reader that ignores them
   behaves as before.

8. **A forwarded write is at-most-once, and is never retried.** `FORWARD_TIMEOUT` (504) and a
   socket that drops mid-flight both mean "this may or may not have committed". Retrying would
   risk writing twice; the answer names the failure and the client reads the txid back. Exactly-once
   would need an idempotency key on the `FORWARD` frame and a dedupe window on the primary — a
   protocol change, left for phase 2.

9. **A replica's forwarded transactions die with its socket.** `ReplicationServer` gained
   `onDisconnect(node)`, and `TxSession` an `origin`, so the primary rolls back what a departed
   replica was holding instead of leaving its only writer taken until the idle timer notices.

10. **After a successful forward the replica waits for its own applier**, bounded by
    `replication.ackTimeoutMs` (reused rather than adding a knob), so the caller's next read on
    that node sees its own write. A wait that expires does **not** fail the write: it committed,
    and the answer carries its txid.

## 3. Read-your-writes across nodes

`BunQL-Min-Txid` on a replica waits on the applier and answers `425 TXID_NOT_AVAILABLE` on expiry —
this worked from R1 and is now proved end to end across two nodes
(`test/replication/forward.test.ts`). Every response on every node carries `BunQL-Txid`,
`BunQL-Node` and `BunQL-Role`, and a replica carries `BunQL-Primary` on all of them.

11. **The WebSocket greeting lied.** `greet()` hard-coded `role: "primary"` on every node. It now
    reports the runtime's real role and adds `primary` on a replica, which is the socket
    equivalent of the `BunQL-Primary` header.

## 4. A new database is announced at once (plan finding 1)

`TenantRegistry` gained an `onChange` hook, fired on create, fork, import, delete and on a replica
creating a followed database (so a chain propagates). `ServerRuntime` wires it to
`ReplicationServer.announce()`.

12. **The announcement is a `HEARTBEAT` frame, not a new frame type.** `HEARTBEAT` already carries
    `databases` (r1 deviation 2) and the replica already resolves `follow: ["*"]` against it, so
    announcing early needed no new code on the replica and no new protocol version.

13. **Two pristine databases now stream instead of snapshotting.** Announcing a database the moment
    it is created made a race visible that was always there: the replica subscribes immediately,
    the primary takes a bootstrap snapshot, and the snapshot holds the tenant exclusively — so the
    client's very next write (the schema, usually) is told `503 BUSY`. A primary at txid 0 has
    nothing to copy and the replica's own new database is already what a snapshot of it would
    produce, so `#decide` streams from record 1 when both sides are at txid 0 with checksum 0.
    `SubscribeBody` gained an optional `reset: true`, set only by `#resubscribe` after an apply
    that did not verify, meaning "my file cannot be trusted at txid 0 either" — the one case where
    `fromTxid: 0` does not mean "pristine".

## 5. The checksum trap in `restore()` (plan finding 2)

`snapshot()` takes an optional `position` — the tenant's own `(checksum, pages)` — and records it
on the `SnapshotRef` instead of deriving it from the file with `computeFull`. `Tenant.snapshot()`
passes it. The two agree everywhere except a database nothing has ever written to, where the file
holds the header page SQLite creates on first opening it in WAL mode and the tenant stands at
"0 pages, checksum 0".

14. **`restore()` also guards txid 0 directly.** A snapshot index written before R2 holds the old,
    file-derived numbers, so a restore from one would still diverge. A snapshot at txid 0 is a
    database no transaction has touched, whatever its file says, so `restore` seeds `(0, 0)` there
    regardless of the ref. `test/wal/snapshot.test.ts` covers both the new refs and a hand-degraded
    old index.

## 6. Replica realtime (plan finding 3)

`TenantRealtime.afterApply(txid)` is the replica's counterpart to `afterCommit`:
`ServerRuntime.realtimeFor` picks one or the other from `tenant.isReplica`.

- Live queries **converge**: every applied transaction re-runs every live query on that database.
- The change feed carries `{txid, changes: []}`. Documented in `docs/api.md` as a phase-1
  limitation; phase 3's logical decoding is what fills the array.

15. **Invalidation on a replica is total, not read-set-scoped.** A record carries pages, not rows,
    so the replica cannot say which tables moved and `LiveQueryRegistry.invalidateAll` treats every
    subscription as dirty. A live query whose result did not change still emits nothing — the
    result hash is what decides that — so the cost is one query execution per live subscription per
    applied transaction, not one event.

## 7. Server-side transaction queue (R5's finding)

`limits.txWaitMs` (default 5000) and `ServerRuntime.beginTxQueued`: a second interactive
transaction waits in a FIFO queue for the writer and is answered `409 TX_BUSY` only when the wait
expires. The deadline is the total wait, not one per attempt, so a database that keeps being taken
still answers inside `txWaitMs`.

16. **`beginTx` stays as the immediate form.** Only the routes changed; a caller that wants the
    old fail-fast answer still has it, and no in-flight caller's signature changed.

17. **A plain write is still refused at once.** `409 TX_BUSY` while a transaction holds the writer.
    A single statement has nothing to hold a place in a queue for, and queueing it would turn a
    fast refusal into a 5 s stall for something the client can retry itself.

18. **A nested transaction on one database now fails slowly.** It waits out `txWaitMs` before
    `TX_BUSY`, because the server cannot tell "two honest handlers" from "one handler that nested".
    That is the trade R5 asked for; the test in `test/client/tx.test.ts` was renamed to say so.

## Tests

New: `test/replication/ack.test.ts`, `test/replication/forward.test.ts`,
`test/replication/realtime.test.ts`, the pristine-restore block in `test/wal/snapshot.test.ts`, the
announcement-timing and concurrent-transaction tests in `test/replication/stream.test.ts` and
`test/server/tx.test.ts`. `test/replication/harness.ts` gained `silentReplica`, a hand-rolled
replica that subscribes and never acks — the only way to get an `ACK_TIMEOUT` rather than a
`NO_REPLICAS` without sleeping and hoping.

Three existing tests changed because R2 changed what they assert: the two `refusals` tests now
start their replica with `forwardWrites: false` (the only configuration in which a replica still
refuses a write), and the `TX_BUSY` tests now expect the queue.

## Seams R3 and phase 2 need

- **Promotion.** `AckTracker` already knows the highest acked txid per node, and
  `ReplicationServer.replicasOf(db)` reports it per stream. "Promote the replica with the highest
  acked txid" is a read of one of those two.
- **Fencing a forwarded write.** `TxSession.origin` names the replica a transaction came from, and
  `onDisconnect` is where a lease loss would hook in.
- **Redirects.** `runForward` is where a cluster-mode primary that no longer holds the lease would
  answer `307` / a WS `moved` frame instead of executing.
- **A deleted database still leaves a stream open on its replicas.** The announcement tells them
  the database list shrank, but `#resolveFollow` only ever adds. Dropping the stream and the local
  replica copy is R3's, and it is the one half of finding 1 that is not built.
- **Snapshot refs now carry the tenant position**, which is what an S3-restored snapshot has to
  seed an applier with. R3's shipper should ship the ref verbatim rather than recomputing it.
- **Exactly-once forwarding** needs an idempotency key on the `FORWARD` frame; today it is
  at-most-once and says so.
