# R4b — forwarding a write off a replica on the Hrana surface

`docs/r4-hrana.md` built the libsql-compatible surface; `docs/r2-durability.md` built write
forwarding for the native one. This joins them. Written 2026-09-12 before the code, because the
milestone is one decision and the rest is wiring.

## 1. What is refused today

`POST /v2/pipeline` with a write, on a replica, fails. The native surface has forwarded writes
since R2 — `routes.query` asks `forwarder.needsPrimary` and sends the statement to the primary —
but `hrana/execute.ts` goes straight to `executeStatement`, which refuses on a replica. So
`@libsql/client` against a bql.sh replica is read-only, while the same client against the native
surface is not.

## 2. The decision: what a baton opened on a replica means

This was the blocker, and the answer is that **it means exactly what it means on a primary**.

A baton names a *stream* — a local object holding a principal, a database and, while one is open,
a transaction. On a primary that transaction is the tenant's own writer. The temptation is to say a
baton on a replica must therefore mean something else, or name something on the primary, or not
exist.

None of that is needed, because R2 already built the missing piece: `Forwarder.RemoteTx` is a
transaction the replica opened **on the primary** and holds a handle to. So:

> **A stream on a replica holds a `RemoteTx` where a stream on a primary holds a `TxSession`.** The
> baton is unchanged — still proof this process issued it, still naming a local stream, still
> rotating on every response. What hangs off the stream changes; what the baton means does not.

The signing key still dies with the process, which is still the honest lifetime: the stream is in
this process's memory either way.

### 2.1 Once a transaction is remote, every statement in it is remote

Not just the writes. A transaction that read locally and wrote remotely would not show a client its
own uncommitted writes — the local file is a snapshot that does not contain them — and
read-your-writes inside an explicit transaction is not a property to trade.

So a stream with an open `RemoteTx` sends **every** statement to the primary until `COMMIT` or
`ROLLBACK`, whatever `sqlite3_stmt_readonly` says about it.

### 2.2 `BEGIN TRANSACTION READONLY` is refused on a replica, and that is not this milestone's to fix

The plan said it would stay local, on the reasoning that a snapshot of the local file is what a
replica is *for*. Building it found the reason that is wrong, in `Tenant.txBegin`:

> `#assertPrimary()` — and then `this.writer.exec("begin")`.

**A tenant transaction takes the writer, whatever its mode**, because SQLite has one writer and the
transaction machinery is built on it. On a replica that writer belongs to the applier, so a client
holding it would stall the replication stream for as long as the transaction lasted. Refusing is
right, and it is right for a better reason than "a replica does not write".

Forwarding it instead would be worse than useless: a round trip per statement to get a read the
replica already serves locally, and a transaction pinning the *primary's* writer to serve reads.

So it is refused, as it was before this milestone. A client that wants a consistent multi-statement
read on a replica uses what the replica already gives it: every statement is a snapshot read, and
`BQL-Min-Txid` pins which snapshot. A real read transaction on a replica wants a transaction on a
*pooled reader* rather than on the writer, which is its own piece of work and does not belong here.

### 2.3 A statement outside a transaction forwards on its own

Exactly as `routes.query` does: `forwarder.needsPrimary` classifies with SQLite's own
`sqlite3_stmt_readonly` on a pooled reader, a read is served locally, a write is one round trip.
Nothing is guessed at from the SQL text.

## 3. Where it goes: one function

`executeStmt` is the only place a Hrana statement runs. `runBatch` and `cursorEntries` both call it
per step — including the `BEGIN` and `COMMIT` steps `@libsql/client` builds a transaction out of —
so changing that one function covers `execute`, `batch`, `sequence` and the cursor, and there is no
second classification anywhere to drift.

Ownership is already right: a stream carries an `owner`, `Forwarder.rollbackOwned(owner)` already
rolls back what a closed socket left open on the primary, and `ws.ts` already calls it. A socket
that dies mid-remote-transaction is rolled back by the same path that already handles a native one.

## 4. What this does not do

**It does not make a replica a primary.** Every forwarded write is a round trip, and a client that
wants write throughput should address the primary — `BQL-Primary` on every response says where it
is. Forwarding exists so a client does not have to *know*, not so it does not have to care.

**It does not forward when `[replication] forwardWrites` is off.** That switch is what an operator
sets to make a replica visibly read-only, and this changes nothing about it.

## 5. Tests

`test/server/hrana-forward.test.ts`, against a real primary and a real replica:

- a write over `/v2/pipeline` on the replica lands on the primary and is visible on both;
- a read on the replica is served locally (no round trip: it works with the primary stopped);
- `BEGIN`, insert, `COMMIT` as one `@libsql/client`-shaped batch works on the replica, and the row
  is on the primary;
- inside that transaction a **read** sees the transaction's own uncommitted write, which is §2.1;
- `BEGIN TRANSACTION READONLY` on the replica is refused, and §2.2 says why;
- closing the socket mid-transaction rolls it back on the primary rather than pinning its writer.

## 6. As built

Built 2026-09-12. `bun test` → **1440 pass, 2 skip, 0 fail** (1434 before). `bun run typecheck`,
`bun run bytes` and `bun run routes:check` clean.

**§3 held: one function.** `executeStmt` gained the three branches and `runBatch`, `cursorEntries`,
`sequence` and the cursor all inherited them, so `@libsql/client`'s `BEGIN`/insert/`COMMIT` batch
against a replica works without a line in the batch code.

**Two things came out differently, and one of them was a bug this milestone had no business
finding.**

- **§2.2 was wrong and is rewritten.** A read-only transaction is refused on a replica, not served
  locally, because `Tenant.txBegin` takes the tenant's *writer* whatever the mode and a replica's
  writer belongs to the applier. The plan's reasoning — "a snapshot of the local file is what a
  replica is for" — was right about the intent and wrong about the mechanism.
- **A write on a replica with `[replication] forwardWrites = false` was accepted locally**, on
  *both* surfaces, and this is a pre-existing hole rather than anything R4b introduced. The switch
  an operator sets to make a replica visibly read-only did the opposite: the write landed in the
  local file and was acknowledged, and then the next record applied from the primary failed the
  checksum chain, so the replica re-snapshotted and **silently discarded a write a client had been
  told was durable**.

  The fix is one guard in `Promoter.assertWritable`, which every write already calls: a replica does
  not write to its own copy. It is only reachable when the write was not forwarded, because a
  forwarded write runs on the primary and never comes back through it.

**One e2e assertion moved on purpose.** `test/e2e/phase1.test.ts` asserted that a Hrana write on a
replica is refused — which was the contract, and is the contract this milestone changes. It now
writes through the replica, and opens a transaction on it whose read sees its own uncommitted
write.
