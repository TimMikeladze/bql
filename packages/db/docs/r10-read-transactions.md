# R10 — a read transaction on a pooled reader

Written 2026-09-12 before the code, because the milestone is one decision and the rest is wiring.
It closes what `docs/r4b-hrana-forward.md` §2.2 left open: `BEGIN TRANSACTION READONLY` is refused
on a replica, so `@libsql/client`'s `transaction("read")` and `batch(…, "read")` do not work against
one.

## 1. Why it is refused, and why the reason is not "a replica does not write"

`Tenant.txBegin` calls `#assertPrimary()` and then `this.writer.exec("begin")`. **A tenant
transaction takes the writer whatever its mode**, because SQLite has one writer connection and the
transaction machinery was built on it. On a replica that writer belongs to the applier, so a client
holding it would stall the replication stream for as long as the transaction lasted.

R4b was right to refuse rather than forward — a round trip per statement to get a read the replica
already serves locally, and the primary's writer pinned to serve reads, is worse than useless. What
it could not do in that milestone was serve it *locally*, because there was nowhere to put the
transaction but the writer.

## 2. The decision

**A read transaction lives on a leased pooled reader, and on both roles.**

`Tenant.acquireReader()` already hands out a connection and a lease, and the lease already exists
for precisely this reason — `docs/c5-apply-pages.md`: "the lease is what keeps a TRUNCATE checkpoint
or a snapshot from taking the exclusive WAL locks underneath an open read transaction". A read
transaction is therefore a lease held across statements with `BEGIN DEFERRED` on it, and nothing
about the writer is involved.

Three things follow, and the third is the one worth arguing about.

### 2.1 It is not a variant of `TxSession`, it is a second kind

`TxSession` is the writer: one per database (`#txByDb`, `limits.maxOpenTx` is 1), a queue in front
of it, a lease check at commit, a txid out of it. A read transaction has none of that — many per
database, no queue, no lease, no txid — so folding them into one type would mean a type whose
fields are half meaningless whichever kind it is. `ReadTxSession` is its own map with its own baton
space, and `endReadTx` always rolls back, because there is nothing to commit.

### 2.2 On a primary it moves off the writer too, which is a behaviour change worth making

Today `BEGIN TRANSACTION READONLY` on a primary takes the writer and blocks every write for as long
as it is held; `assertReadOnly` then refuses any write inside it. After this milestone it takes a
reader, so concurrent writes proceed. The transaction still sees one consistent snapshot — that is
what `BEGIN DEFERRED` on a separate connection gives — and a write inside it is still refused by
the same `sqlite3_stmt_readonly` test.

Running one path on both roles is the point: two paths would differ under exactly the conditions
nobody tests.

### 2.3 On a replica it delays the applier, and that has to be bounded

This is the cost, and it is real. Under `[replication] apply = "pages"` the applier takes the
wal-index lock set itself; a reader mid-transaction makes it wait and then answer `ApplyBusy`.
`ReplicaClient.#apply` already handles that correctly — the record goes on `stream.deferred` and is
retried, nothing is written and the position does not move — so a read transaction **delays**
replication rather than breaking it.

But `deferred` grows while it is held, so an unbounded read transaction is an unbounded queue. Two
bounds, both of which a client can already see the shape of:

- `[limits] txIdleTimeoutMs` (5 s), which already exists, closes one that has gone quiet;
- `[limits] readTxTimeoutMs` (30 s, new) closes one however busy it is. A read transaction is not a
  session; thirty seconds of one snapshot is past any honest use and well past what a replica
  should hold its stream for.

Both end it as a rollback, which is what every read transaction ends as anyway, so a client sees
`TX_NOT_FOUND` on its next statement rather than a partial anything — and the stream is cleared, so
it recovers rather than being permanently stuck in a transaction that is over.

#### What building it found: the applier was spinning the event loop for five seconds

`WalApplier.#acquire` waits for the wal-index lock set with `Bun.sleepSync`, bounded by
`[replication] applyBusyMs` — **default 5000**. The first version of the isolation test took 5.05 s
and then failed on the idle timeout, which is what that looks like from the outside.

The spin is synchronous, so every millisecond of it is a millisecond of the replica's event loop.
And it was buying nothing: `ReplicaClient.#apply` already defers a busy record and retries it, for
as long as it takes. Five seconds of spinning was not five seconds of extra tolerance — it was five
seconds of a stalled node, on a condition R10 turns from rare into one a client can hold open
deliberately.

So `applyBusyMs` drops to **25 ms**, which is comfortably longer than any ordinary read, and the
patience moves to where it was already: the asynchronous retry, which now backs off 5 ms → 250 ms
while the tenant stays busy and resets on the first record that applies. The same test now runs in
0.62 s.

This is a fix the replica wanted anyway. R10 is only how it was found.

### 2.4 Connections are the other bound

Each open read transaction holds a SQLite connection for its whole life, and `acquireReader` opens
one past the pool rather than failing. Unbounded, that is a file-descriptor exhaustion a single
client can drive, so `[limits] maxReadTx` (16 per database) refuses the seventeenth with
`409 TX_BUSY` — the same code the writer path uses for the same meaning, "come back".

## 3. Where it goes

| | |
|---|---|
| `src/tenant/tenant.ts` | `readTxBegin` / `readTxExec` / `readTxEnd`, a lease held across statements. No `#assertPrimary`, no writer, no txid. |
| `src/server/runtime.ts` | `ReadTxSession`, `beginReadTx`, `readTxSession`, `endReadTx`; `rollbackOwned`, `evict` and `close` end them too. |
| `src/server/hrana/execute.ts` | `verb.readonly` opens one instead of refusing; statements in it run through `readTxExec`; `assertReadOnly` still refuses a write inside it. |

`executeStmt` is still the only place a Hrana statement runs, so `execute`, `batch`, `sequence` and
the cursor all get it from the one change.

## 4. What this does not do

- **The native `/v1/db/{db}/tx` keeps its three writer modes.** Adding a fourth is a route-level
  change with its own baton dispatch, and nothing asks for it: the native surface's consistent-read
  answer is `BQL-Min-Txid`, which needs no transaction at all. Recorded in `docs/next.md`.
- **It does not forward.** A read transaction on a replica is served by the replica, which is the
  whole point.
- **It changes no ack level.** A read transaction commits nothing.

## 5. The tests that would fail if this were only recorded

`test/hrana/forward.test.ts`:

- `@libsql/client`'s `transaction("read")` against a **replica** runs, reads, and refuses a write
  inside itself with `SQLITE_READONLY` — the case that did not work at all;
- the snapshot is real: a read transaction opened on a replica, a write on the primary replicated
  in between, and the second read inside the transaction still sees the first read's value;
- on a **primary**, a write from another connection **completes** while a read transaction is open,
  which is the behaviour change of §2.2 and would fail against the old writer-based path;
- the seventeenth concurrent read transaction on one database is `409 TX_BUSY`;
- a read transaction left open past `readTxTimeoutMs` is gone, its next statement answers
  `TX_NOT_FOUND`, and the statement after that succeeds — the stream recovers.

Deliberately broken to check they bite (`docs/c4d-cluster-workers.md` §9): dropping the
`BEGIN DEFERRED` from `readTxBegin` fails the isolation case; removing the `maxReadTx` check fails
the `TX_BUSY` one.

The case R4b's test used to assert — `begin transaction readonly` on a replica answering
`NOT_PRIMARY` — is rewritten rather than deleted, because it is the contract this milestone
changed.
